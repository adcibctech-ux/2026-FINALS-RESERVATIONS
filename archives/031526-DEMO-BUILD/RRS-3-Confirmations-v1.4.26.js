/**
 * RRS-3-Confirmations-v1.4.26
 * CONFIRMATIONS -> Validate confirmation -> confirm ALL bookings under request/code -> book slots -> link records -> write summaries
 *
 * BUG FIXES:
 * - Adds PARTIAL result support:
 *    - Result = VALID if all matched bookings confirmed
 *    - Result = PARTIAL if some confirmed and some failed/expired
 *    - Result = EXPIRED if all matched bookings expired
 *    - Result = INVALID if no matches found
 * - Writes:
 *    - {Confirmed Booking(s)} (multi-link)
 *    - {Failed Booking(s)} (multi-link)
 *    - {Booking Summary} (confirmed list)
 *    - {Failed Booking Summary} (failed list + reasons)
 *
 * BEHAVIOR:
 * - Trigger: Automation on CONFIRMATIONS record created; receives input.config().recordId
 * - Requires CONFIRMATIONS fields:
 *    - {Booking Request}, {Contact Email}, {Confirmation Code}, {Confirmation Agreement}
 * - Matches BOOKINGS where:
 *    - {Booking Request} == selected request
 *    - {Confirmation Code} matches
 *    - {Booking Status} == "AWAITING CONFIRMATION"
 * - Validates hold expiry via booking {Hold Expires At}
 * - Confirms all valid bookings; skips expired as failed
 * - Books each slot and clears hold metadata
 * - Allocates entitlement consumption by linking each booking's slot to its PAID ROSTER record {Booked Slot(s)} (append-safe)
 */

const cfg = input.config();
const confirmationRecordId = cfg.recordId;

const CONF_TABLE = "CONFIRMATIONS";
const REQ_TABLE = "BOOKING REQUESTS";
const BOOK_TABLE = "BOOKINGS";
const SLOTS_TABLE = "SLOTS (Operational)";
const PAID_TABLE = "PAID ROSTER";

const confirmations = base.getTable(CONF_TABLE);
const requests = base.getTable(REQ_TABLE);
const bookings = base.getTable(BOOK_TABLE);
const slots = base.getTable(SLOTS_TABLE);
const paid = base.getTable(PAID_TABLE);

function sel(name) { return { name }; }

function fmtDate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${mm}/${dd}/${yy}`;
}
function fmtTime(d) {
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m} ${ampm}`;
}
function slotLine(n, room, start, end) {
  return `RESERVATION ${n}: ${fmtDate(start)} // ${room} // ${fmtTime(start)} (EST) // ${fmtTime(end)} (EST)`;
}

async function batchUpdate(table, updates) {
  const CHUNK = 50;
  for (let i = 0; i < updates.length; i += CHUNK) {
    await table.updateRecordsAsync(updates.slice(i, i + CHUNK));
  }
}

// ------------------ Load confirmation record ------------------
const confQuery = await confirmations.selectRecordsAsync({
  fields: [
    "Booking Request",
    "Contact Email",
    "Confirmation Code",
    "Confirmation Agreement",
    "Result",
    "Booking",
    "Hold Token",
    "Booking Summary",
    "Confirmed Booking(s)",
    "Failed Booking(s)",
    "Failed Booking Summary",
  ],
});
const conf = confQuery.getRecord(confirmationRecordId);
if (!conf) throw new Error(`CONFIRMATIONS record not found: ${confirmationRecordId}`);

const agreement = conf.getCellValue("Confirmation Agreement");
if (!agreement) {
  await confirmations.updateRecordAsync(conf.id, { "Result": sel("INVALID") });
  return;
}

const reqLink = (conf.getCellValue("Booking Request") || [])[0];
const contactEmail = (conf.getCellValueAsString("Contact Email") || "").trim();
const code = (conf.getCellValueAsString("Confirmation Code") || "").trim();

if (!reqLink || !contactEmail || !code) {
  await confirmations.updateRecordAsync(conf.id, { "Result": sel("INVALID") });
  return;
}

const now = new Date();

// ------------------ Load bookings (candidate set) ------------------
const bookQuery = await bookings.selectRecordsAsync({
  fields: [
    "Booking Request",
    "Booking Status",
    "Hold Expires At",
    "Hold Token",
    "Confirmation Code",
    "Held Contact Email",
    "Slot(s)",
    "Pre-Paid Reservation",
    "Booking Summary",
    "Confirmed?",
    "Confirmed At",
  ],
});

// Find matches
const matches = [];
for (const b of bookQuery.records) {
  const bReq = (b.getCellValue("Booking Request") || [])[0];
  if (!bReq || bReq.id !== reqLink.id) continue;

  const bStatus = (b.getCellValueAsString("Booking Status") || "").trim();
  if (bStatus !== "AWAITING CONFIRMATION") continue;

  const bCode = (b.getCellValueAsString("Confirmation Code") || "").trim();
  if (bCode !== code) continue;

  const bHeldEmail = (b.getCellValueAsString("Held Contact Email") || "").trim();
  if (bHeldEmail && bHeldEmail.toLowerCase() !== contactEmail.toLowerCase()) continue;

  matches.push(b);
}

if (matches.length === 0) {
  await confirmations.updateRecordAsync(conf.id, { "Result": sel("INVALID") });
  return;
}

// Partition expired vs valid
const expiredBookings = [];
const candidateValidBookings = [];

for (const b of matches) {
  const exp = b.getCellValue("Hold Expires At");
  if (exp && new Date(exp) < now) expiredBookings.push(b);
  else candidateValidBookings.push(b);
}

if (candidateValidBookings.length === 0) {
  // All expired
  await confirmations.updateRecordAsync(conf.id, {
    "Result": sel("EXPIRED"),
    "Failed Booking(s)": expiredBookings.map(b => ({ id: b.id })),
    "Failed Booking Summary": expiredBookings.length
      ? `All held reservations expired before confirmation.\n` +
        expiredBookings.map((b, i) => `FAILED RESERVATION ${i + 1}: Hold expired.`).join("\n")
      : "All held reservations expired before confirmation.",
  });
  return;
}

// ------------------ Load slots ------------------
const slotQuery = await slots.selectRecordsAsync({
  fields: ["Status", "Start Time", "End Time", "Room", "Hold Token", "Hold Expires At", "Held By Email", "Hold Created", "Booking"],
});

function getRoom(slotRec) {
  return (slotRec.getCellValueAsString("Room") || "").trim();
}

// ------------------ Confirm valid bookings; fail those that can't book for any reason ------------------
const slotUpdates = [];
const bookingUpdates = [];
const paidUpdatesMap = new Map(); // paidId -> Set(slotId)

const confirmedBookings = [];
const failedBookings = [...expiredBookings];

const confirmedSummaryLines = [];
const failedSummaryLines = [];

let confirmedN = 0;
let failedN = 0;

// Helper to record a failed booking with a reason + slot details if possible
function recordFailedBooking(b, reason, slotRec = null) {
  failedBookings.push(b);
  failedN++;
  if (slotRec) {
    const sStart = slotRec.getCellValue("Start Time") ? new Date(slotRec.getCellValue("Start Time")) : null;
    const sEnd = slotRec.getCellValue("End Time") ? new Date(slotRec.getCellValue("End Time")) : null;
    const room = getRoom(slotRec);
    if (sStart && sEnd && room) {
      failedSummaryLines.push(
        `FAILED: ${fmtDate(sStart)} // ${room} // ${fmtTime(sStart)} (EST) // ${fmtTime(sEnd)} (EST) — ${reason}`
      );
      return;
    }
  }
  failedSummaryLines.push(`FAILED: ${reason}`);
}

for (const b of candidateValidBookings) {
  const slotLink = (b.getCellValue("Slot(s)") || [])[0];
  if (!slotLink) {
    recordFailedBooking(b, "Booking has no linked slot.");
    continue;
  }

  const slotRec = slotQuery.getRecord(slotLink.id);
  if (!slotRec) {
    recordFailedBooking(b, "Slot record not found.");
    continue;
  }

  const sStartRaw = slotRec.getCellValue("Start Time");
  const sEndRaw = slotRec.getCellValue("End Time");
  const room = getRoom(slotRec);

  if (!sStartRaw || !sEndRaw || !room) {
    recordFailedBooking(b, "Slot is missing room/start/end data.", slotRec);
    continue;
  }

  // If slot is no longer HELD, treat as failed (someone else may have booked/hold released)
  const slotStatus = (slotRec.getCellValueAsString("Status") || "").trim();
  if (slotStatus !== "HELD") {
    recordFailedBooking(b, `Slot is not currently held (current status: ${slotStatus}).`, slotRec);
    continue;
  }

  // Confirm booking
  confirmedBookings.push(b);
  confirmedN++;

  const sStart = new Date(sStartRaw);
  const sEnd = new Date(sEndRaw);

  confirmedSummaryLines.push(slotLine(confirmedN, room, sStart, sEnd));

  slotUpdates.push({
    id: slotRec.id,
    fields: {
      "Status": sel("BOOKED"),
      "Hold Token": "",
      "Hold Expires At": null,
      "Held By Email": "",
      "Hold Created": null,
    }
  });

  bookingUpdates.push({
    id: b.id,
    fields: {
      "Booking Status": sel("CONFIRMED"),
      "Confirmed?": true,
      "Confirmed At": now,
      // per booking summary stays RESERVATION 1, keep existing if present
      "Booking Summary": (b.getCellValueAsString("Booking Summary") || "").trim() || slotLine(1, room, sStart, sEnd),
    }
  });

  // Allocate to PAID ROSTER consumption (append-safe)
  const paidLink = (b.getCellValue("Pre-Paid Reservation") || [])[0];
  if (paidLink?.id) {
    if (!paidUpdatesMap.has(paidLink.id)) paidUpdatesMap.set(paidLink.id, new Set());
    paidUpdatesMap.get(paidLink.id).add(slotRec.id);
  }
}

// Apply slot + booking updates
if (slotUpdates.length) await batchUpdate(slots, slotUpdates);
if (bookingUpdates.length) await batchUpdate(bookings, bookingUpdates);

// Update PAID ROSTER {Booked Slot(s)} append-safe
if (paidUpdatesMap.size > 0) {
  const paidQuery = await paid.selectRecordsAsync({ fields: ["Booked Slot(s)"] });
  const paidRecordUpdates = [];

  for (const [paidId, slotSet] of paidUpdatesMap.entries()) {
    const pr = paidQuery.getRecord(paidId);
    if (!pr) continue;

    const existing = pr.getCellValue("Booked Slot(s)") || [];
    const existingIds = new Set(existing.map(x => x.id));

    for (const sid of slotSet) existingIds.add(sid);

    paidRecordUpdates.push({
      id: paidId,
      fields: {
        "Booked Slot(s)": Array.from(existingIds).map(id => ({ id })),
      }
    });
  }

  if (paidRecordUpdates.length) await batchUpdate(paid, paidRecordUpdates);
}

// Update Booking Request status -> CONFIRMED if any confirmed, else EXPIRED
await requests.updateRecordAsync(reqLink.id, {
  "Request Status": confirmedBookings.length > 0 ? sel("CONFIRMED") : sel("EXPIRED"),
});

// Determine Result
let result;
if (confirmedBookings.length > 0 && failedBookings.length === 0) result = "VALID";
else if (confirmedBookings.length > 0 && failedBookings.length > 0) result = "PARTIAL";
else if (confirmedBookings.length === 0 && expiredBookings.length > 0) result = "EXPIRED";
else result = "INVALID";

// Link sets for confirmation record
const confirmedLinks = confirmedBookings.map(b => ({ id: b.id }));
const failedLinks = failedBookings.map(b => ({ id: b.id }));
const allLinks = [...confirmedLinks, ...failedLinks];

// Representative hold token (if any)
const holdToken = (confirmedBookings[0]?.getCellValueAsString("Hold Token") || "").trim()
  || (failedBookings[0]?.getCellValueAsString("Hold Token") || "").trim()
  || "";

// Write confirmation record
await confirmations.updateRecordAsync(conf.id, {
  "Result": sel(result),
  "Booking": allLinks, // keep full visibility
  "Confirmed Booking(s)": confirmedLinks,
  "Failed Booking(s)": failedLinks,
  "Hold Token": holdToken,
  "Booking Summary": confirmedSummaryLines.join("\n"),
  "Failed Booking Summary": failedSummaryLines.join("\n"),
});

console.log(`RRS-3 v1.5.26 complete: result=${result}, confirmed=${confirmedBookings.length}, failed=${failedBookings.length}`);
