/**
 * RRS-4-ExpireMatches-v1.2.26
 * Scheduled expiry sweep -> expire MATCHED bookings + release HELD slots + (safe) mark requests expired
 *
 * BUG FIXES:
 * - Updated from legacy HOLD schema to MATCH schema:
 *    BOOKINGS: {Match Expires At}, {Match Token}, {Booking Status}="MATCHED"
 *    SLOTS: {Status}="HELD" + {Temp Hold Token}, {Temp Hold Expires At}, {Temp Hold Email}
 *
 * BEHAVIOR:
 * - Runs on a schedule (every 15 minutes).
 * - Expires BOOKINGS where:
 *    - {Booking Status} == "MATCHED"
 *    - {Match Expires At} < NOW()
 *   Actions:
 *    - {Booking Status} = "EXPIRED"
 *    - {Expired At} = NOW()
 * - Releases SLOTS where:
 *    - {Status} == "HELD"
 *    - {Temp Hold Expires At} < NOW()
 *   Actions:
 *    - {Status} = "AVAILABLE"
 *    - Clear {Temp Hold Token}, {Temp Hold Expires At}, {Temp Hold Email}
 * - Safe request expiry:
 *    - If a BOOKING REQUEST has 0 remaining MATCHED bookings (after this run),
 *      and its {Request Status} is currently "MATCHED", set {Request Status}="EXPIRED"
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

// ------------------ Load BOOKINGS ------------------
const bookingQuery = await bookings.selectRecordsAsync({
  fields: [
    "Booking Status",
    "Match Expires At",
    "Match Token",
    "Booking Request",
    "Slot(s)",
    "Expired At",
  ],
});

// Identify expiring MATCHED bookings
const expiringBookings = [];
for (const b of bookingQuery.records) {
  const status = (b.getCellValueAsString("Booking Status") || "").trim();
  if (status !== "MATCHED") continue;

  const exp = b.getCellValue("Match Expires At");
  if (!exp) continue;

  if (now > new Date(exp)) expiringBookings.push(b);
}

console.log(`RRS-4: Expiring MATCHED bookings found: ${expiringBookings.length}`);

// Build booking updates + track request impacts
const bookingUpdates = [];
const requestIdsTouched = new Set();

for (const b of expiringBookings) {
  const reqLink = (b.getCellValue("Booking Request") || [])[0];
  if (reqLink) requestIdsTouched.add(reqLink.id);

  bookingUpdates.push({
    id: b.id,
    fields: {
      "Booking Status": sel("EXPIRED"),
      "Expired At": now,
    },
  });
}

// ------------------ Load SLOTS ------------------
const slotQuery = await slots.selectRecordsAsync({
  fields: [
    "Status",
    "Temp Hold Token",
    "Temp Hold Expires At",
    "Temp Hold Email",
  ],
});

// Release HELD slots whose temp hold expired
const slotUpdates = [];
for (const s of slotQuery.records) {
  const st = (s.getCellValueAsString("Status") || "").trim();
  if (st !== "HELD") continue;

  const exp = s.getCellValue("Temp Hold Expires At");
  if (!exp) continue;

  if (now <= new Date(exp)) continue;

  slotUpdates.push({
    id: s.id,
    fields: {
      "Status": sel("AVAILABLE"),
      "Temp Hold Token": "",
      "Temp Hold Expires At": null,
      "Temp Hold Email": "",
    },
  });
}

console.log(`RRS-4: HELD slots to release: ${slotUpdates.length}`);

// ------------------ Safe Request Status expiry ------------------
// Only mark a request EXPIRED if:
// - Request Status currently "MATCHED"
// - After this run, there will be 0 MATCHED bookings remaining for that request
let requestUpdates = [];

if (requestIdsTouched.size > 0) {
  // Load requests (only the ones we touched)
  const reqQuery = await requests.selectRecordsAsync({
    fields: ["Request Status"],
  });

  // Count remaining MATCHED bookings per request (using current snapshot minus those expiring now)
  const expiringBookingIds = new Set(expiringBookings.map(b => b.id));
  const remainingMatchedCountByReq = new Map();

  for (const b of bookingQuery.records) {
    const status = (b.getCellValueAsString("Booking Status") || "").trim();

    // treat expiring ones as not remaining
    if (expiringBookingIds.has(b.id)) continue;

    if (status !== "MATCHED") continue;

    const reqLink = (b.getCellValue("Booking Request") || [])[0];
    if (!reqLink) continue;

    remainingMatchedCountByReq.set(
      reqLink.id,
      (remainingMatchedCountByReq.get(reqLink.id) || 0) + 1
    );
  }

  for (const reqId of requestIdsTouched) {
    const reqRec = reqQuery.getRecord(reqId);
    if (!reqRec) continue;

    const reqStatus = (reqRec.getCellValueAsString("Request Status") || "").trim();
    if (reqStatus !== "MATCHED") continue;

    const remaining = remainingMatchedCountByReq.get(reqId) || 0;
    if (remaining === 0) {
      requestUpdates.push({
        id: reqId,
        fields: { "Request Status": sel("EXPIRED") },
      });
    }
  }

  console.log(`RRS-4: Requests to mark EXPIRED: ${requestUpdates.length}`);
}

// ------------------ Execute ------------------
if (bookingUpdates.length) await batchUpdate(bookings, bookingUpdates);
if (slotUpdates.length) await batchUpdate(slots, slotUpdates);
if (requestUpdates.length) await batchUpdate(requests, requestUpdates);

console.log("RRS-4: Expiry sweep complete:");
console.log(`- Bookings expired: ${bookingUpdates.length}`);
console.log(`- Slots released: ${slotUpdates.length}`);
console.log(`- Requests marked EXPIRED: ${requestUpdates.length}`);
