/**
 * RRS-4-ExpireHolds-v1.0.26
 * Scheduled expiry sweep -> expire provisional bookings + release slots + mark requests expired
 *
 * BUG FIXES: N/A
 *
 * BEHAVIOR:
 * - Runs on a schedule (every 15 minutes).
 * - Finds BOOKINGS where:
 *    - {Booking Status} == "AWAITING CONFIRMATION"
 *    - {Hold Expires At} is before NOW()
 * - For each expired booking:
 *    - Sets {Booking Status} = "EXPIRED"
 *    - Sets {Expired At} = NOW()
 *    - Releases any SLOTS (Operational) still held by that booking’s {Hold Token}:
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
  fields: ["Booking Status", "Hold Expires At", "Hold Token", "Booking Request"],
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

// --- Load held slots once ---
const slotQuery = await slots.selectRecordsAsync({
  fields: ["Status", "Hold Token", "Hold Expires At", "Held By Email"],
});

// Index held slots by token
const heldSlotsByToken = new Map();
for (const s of slotQuery.records) {
  const sStatus = (s.getCellValueAsString("Status") || "").trim();
  if (sStatus !== "HELD") continue;

  const token = (s.getCellValueAsString("Hold Token") || "").trim();
  if (!token) continue;

  if (!heldSlotsByToken.has(token)) heldSlotsByToken.set(token, []);
  heldSlotsByToken.get(token).push(s);
}

// --- Build updates ---
const bookingUpdates = [];
const slotUpdates = [];
const requestUpdates = [];

for (const b of expiringBookings) {
  const token = (b.getCellValueAsString("Hold Token") || "").trim();
  const reqLink = (b.getCellValue("Booking Request") || [])[0];

  // Expire booking
  bookingUpdates.push({
    id: b.id,
    fields: {
      "Booking Status": sel("EXPIRED"),
      "Expired At": now,
    },
  });

  // Release any held slots associated with this booking token
  const heldSlots = token ? (heldSlotsByToken.get(token) || []) : [];
  for (const s of heldSlots) {
    slotUpdates.push({
      id: s.id,
      fields: {
        "Status": sel("AVAILABLE"),
        "Hold Token": "",
        "Hold Expires At": null,
        "Held By Email": "",
      },
    });
  }

  // Mark request expired (if linked)
  if (reqLink) {
    requestUpdates.push({
      id: reqLink.id,
      fields: {
        "Request Status": sel("EXPIRED"),
      },
    });
  }
}

// --- Execute updates ---
if (bookingUpdates.length) await batchUpdate(bookings, bookingUpdates);
if (slotUpdates.length) await batchUpdate(slots, slotUpdates);
if (requestUpdates.length) await batchUpdate(requests, requestUpdates);

console.log("RRS-4: Expiry sweep complete:");
console.log(`- Bookings expired: ${bookingUpdates.length}`);
console.log(`- Slots released: ${slotUpdates.length}`);
console.log(`- Requests marked EXPIRED: ${requestUpdates.length}`);
