/**
 * RRS-4-ExpireHolds-v1.1.26
 * Scheduled expiry sweep -> expire provisional bookings + release slots + mark requests expired
 *
 * BUG FIXES:
 * - Release HELD slots back to AVAILABLE by TWO methods:
 *    (A) Primary: match slots by Booking {Hold Token}
 *    (B) Fallback: also release any HELD slots directly linked in Booking {Slot(s)}
 *  This covers cases where slot tokens drifted / were cleared / mismatched.
 *
 * BEHAVIOR:
 * - Runs on a schedule (every 15 minutes).
 * - Finds BOOKINGS where:
 *    - {Booking Status} == "AWAITING CONFIRMATION"
 *    - {Hold Expires At} is before NOW()
 * - For each expired booking:
 *    - Sets {Booking Status} = "EXPIRED"
 *    - Sets {Expired At} = NOW()
 *    - Releases any SLOTS (Operational) still held for this booking:
 *        - Slot {Status} -> "AVAILABLE"
 *        - Clears Slot {Hold Token}, {Hold Expires At}, {Held By Email}
 *    - Updates linked BOOKING REQUESTS record:
 *        - {Request Status} -> "EXPIRED"
 */

const BOOKINGS_TABLE = "BOOKINGS";
const SLOTS_TABLE = "SLOTS (Operational)";
const REQUESTS_TABLE = "BOOKING REQUESTS";

const bookings = base.getTable(BOOKINGS_TABLE);
const slots = base.getTable(SLOTS_TABLE);
const requests = base.getTable(REQUESTS_TABLE);

function sel(name) { return { name }; }

async function batchUpdate(table, records) {
  const CHUNK = 50;
  for (let i = 0; i < records.length; i += CHUNK) {
    await table.updateRecordsAsync(records.slice(i, i + CHUNK));
  }
}

const now = new Date();

// --- Load bookings (awaiting confirmation) ---
const bookingQuery = await bookings.selectRecordsAsync({
  fields: ["Booking Status", "Hold Expires At", "Hold Token", "Booking Request", "Slot(s)"],
});

const expiringBookings = [];
for (const b of bookingQuery.records) {
  const status = (b.getCellValueAsString("Booking Status") || "").trim();
  if (status !== "AWAITING CONFIRMATION") continue;

  const exp = b.getCellValue("Hold Expires At");
  if (!exp) continue;

  const expAt = new Date(exp);
  if (now > expAt) expiringBookings.push(b);
}

if (expiringBookings.length === 0) {
  console.log("RRS-4: No expiring bookings found.");
  return;
}

console.log(`RRS-4: Found ${expiringBookings.length} expiring bookings.`);

// --- Load slots once ---
const slotQuery = await slots.selectRecordsAsync({
  fields: ["Status", "Hold Token", "Hold Expires At", "Held By Email"],
});

// Index HELD slots by token for primary release
const heldSlotsByToken = new Map();
for (const s of slotQuery.records) {
  const sStatus = (s.getCellValueAsString("Status") || "").trim();
  if (sStatus !== "HELD") continue;

  const token = (s.getCellValueAsString("Hold Token") || "").trim();
  if (!token) continue;

  if (!heldSlotsByToken.has(token)) heldSlotsByToken.set(token, []);
  heldSlotsByToken.get(token).push(s);
}

// Track which slots we already plan to update (avoid duplicates)
const slotIdsToRelease = new Set();

// --- Build updates ---
const bookingUpdates = [];
const slotUpdates = [];
const requestUpdates = [];

for (const b of expiringBookings) {
  const token = (b.getCellValueAsString("Hold Token") || "").trim();
  const reqLink = (b.getCellValue("Booking Request") || [])[0];
  const linkedSlots = b.getCellValue("Slot(s)") || [];

  // Expire booking
  bookingUpdates.push({
    id: b.id,
    fields: {
      "Booking Status": sel("EXPIRED"),
      "Expired At": now,
    },
  });

  // (A) Release held slots by token match (primary)
  const tokenHeld = token ? (heldSlotsByToken.get(token) || []) : [];
  for (const s of tokenHeld) slotIdsToRelease.add(s.id);

  // (B) Release held slots linked directly on the booking (fallback)
  for (const l of linkedSlots) slotIdsToRelease.add(l.id);

  // Mark request expired (if linked)
  if (reqLink) {
    requestUpdates.push({
      id: reqLink.id,
      fields: { "Request Status": sel("EXPIRED") },
    });
  }
}

// Build slot update payloads (only for slots that are currently HELD)
for (const slotId of slotIdsToRelease) {
  const s = slotQuery.getRecord(slotId);
  if (!s) continue;

  const sStatus = (s.getCellValueAsString("Status") || "").trim();
  // Only release if still held; don't clobber BOOKED, etc.
  if (sStatus !== "HELD") continue;

  slotUpdates.push({
    id: slotId,
    fields: {
      "Status": sel("AVAILABLE"),
      "Hold Token": "",
      "Hold Expires At": null,
      "Held By Email": "",
    },
  });
}

// --- Execute updates ---
if (bookingUpdates.length) await batchUpdate(bookings, bookingUpdates);
if (slotUpdates.length) await batchUpdate(slots, slotUpdates);
if (requestUpdates.length) await batchUpdate(requests, requestUpdates);

console.log("RRS-4: Expiry sweep complete:");
console.log(`- Bookings expired: ${bookingUpdates.length}`);
console.log(`- Slots released: ${slotUpdates.length}`);
console.log(`- Requests marked EXPIRED: ${requestUpdates.length}`);
