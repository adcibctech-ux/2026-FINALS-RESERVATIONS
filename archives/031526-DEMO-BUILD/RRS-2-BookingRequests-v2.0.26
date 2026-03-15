/**
 * RRS-2-BookingRequests-v2.0.26
 * BOOKING REQUESTS (new) -> Deterministic multi-slot holds (in preference order) + create 1 BOOKING per held slot + write summaries
 *
 * BUG FIXES: N/A (new major version for studio/multi-prepaid workflow)
 *
 * BEHAVIOR:
 * - Trigger: Automation on BOOKING REQUESTS record created; receives input.config().recordId
 * - Inputs:
 *    - {Studio} (link, limit 1) [required]
 *    - {Pre-Paid Reservation} (link, multi) [required] -> determines requested hours (count of linked PAID ROSTER records)
 *    - {Requested Slot(s)} (link, multi, ordered by user preference) [required]
 *    - {Reservation Email}, {Contact Email}, {Booking Acknowledgement}
 * - Capacity:
 *    - cap = MIN( count(Pre-Paid Reservation), Studio Hours Remaining (if present), 10 )
 * - For each requested slot (in selection order), attempts hold:
 *    - If slot Status == AVAILABLE and still under cap -> mark slot HELD and create a BOOKING record (1 per slot)
 *    - Otherwise -> add slot to {Failed Slot(s)} and append to {Failed Slot Summary} with reason
 * - Writes summaries in the format (EST):
 *    - RESERVATION N: MM/DD/YY // ROOM // h:mm AM/PM (EST) // h:mm AM/PM (EST)
 * - If 0 held -> Request Status = "FAILED - UNAVAILABLE SLOT"
 * - If >=1 held -> Request Status = "HOLD CREATED"
 */

const cfg = input.config();
const requestRecordId = cfg.recordId;

const REQ_TABLE = "BOOKING REQUESTS";
const BOOK_TABLE = "BOOKINGS";
const SLOTS_TABLE = "SLOTS (Operational)";
const STUDIO_TABLE = "STUDIO ROSTER";

const requests = base.getTable(REQ_TABLE);
const bookings = base.getTable(BOOK_TABLE);
const slots = base.getTable(SLOTS_TABLE);
const studios = base.getTable(STUDIO_TABLE);

function sel(name) { return { name }; } // singleSelect-safe

function randomCode(len = 10) {
  // longer than before to minimize collisions; avoids ambiguous chars
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function randomToken(len = 12) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function fmtDate(d) {
  // MM/DD/YY
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${mm}/${dd}/${yy}`;
}

function fmtTime(d) {
  // h:mm AM/PM
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m} ${ampm}`;
}

function slotLine(n, room, start, end) {
  const dateStr = fmtDate(start);
  const startStr = `${fmtTime(start)} (EST)`;
  const endStr = `${fmtTime(end)} (EST)`;
  return `RESERVATION ${n}: ${dateStr} // ${room} // ${startStr} // ${endStr}`;
}

async function batchUpdate(table, records) {
  const CHUNK = 50;
  for (let i = 0; i < records.length; i += CHUNK) {
    await table.updateRecordsAsync(records.slice(i, i + CHUNK));
  }
}

async function batchCreate(table, records) {
  const CHUNK = 50;
  const createdIds = [];
  for (let i = 0; i < records.length; i += CHUNK) {
    const ids = await table.createRecordsAsync(records.slice(i, i + CHUNK));
    createdIds.push(...ids);
  }
  return createdIds;
}

// ------------------ Load request ------------------
const reqQuery = await requests.selectRecordsAsync({
  fields: [
    "Studio",
    "Pre-Paid Reservation",
    "Requested Slot(s)",
    "Reservation Email",
    "Contact Email",
    "Booking Acknowledgement",
    "Hold Summary",
    "Failed Slot(s)",
    "Failed Slot Summary",
    "Held Slot(s)",
    "Hold Token",
    "Hold Expires At",
    "Confirmation Code",
    "Request Status",
    "BOOKINGS",
  ],
});

const req = reqQuery.getRecord(requestRecordId);
if (!req) throw new Error(`BOOKING REQUESTS record not found: ${requestRecordId}`);

const ack = req.getCellValue("Booking Acknowledgement");
if (!ack) {
  await requests.updateRecordAsync(req.id, { "Request Status": sel("NEEDS HELP") });
  return;
}

const studioLink = (req.getCellValue("Studio") || [])[0];
const paidLinks = (req.getCellValue("Pre-Paid Reservation") || []);
const requestedSlotLinks = (req.getCellValue("Requested Slot(s)") || []);

const contactEmail = (req.getCellValueAsString("Contact Email") || "").trim();
const reservationEmail = (req.getCellValueAsString("Reservation Email") || "").trim();

if (!studioLink || paidLinks.length === 0 || requestedSlotLinks.length === 0 || !contactEmail || !reservationEmail) {
  await requests.updateRecordAsync(req.id, { "Request Status": sel("NEEDS HELP") });
  return;
}

// ------------------ Load studio (for hours remaining) ------------------
let studioHoursRemaining = null;
try {
  const studioQuery = await studios.selectRecordsAsync({ fields: ["Hours Remaining"] });
  const studioRec = studioQuery.getRecord(studioLink.id);
  if (studioRec) {
    const hr = studioRec.getCellValue("Hours Remaining");
    if (typeof hr === "number") studioHoursRemaining = hr;
    else {
      // In case Hours Remaining is a formula returned as string:
      const asStr = (studioRec.getCellValueAsString("Hours Remaining") || "").trim();
      const asNum = parseFloat(asStr);
      if (!Number.isNaN(asNum)) studioHoursRemaining = asNum;
    }
  }
} catch (_) {
  // If STUDIO ROSTER or field missing, ignore; cap will be based on paidLinks length.
}

// Capacity: count of prepaid records requested, bounded by studio remaining if available, and max 10
let cap = paidLinks.length;
if (typeof studioHoursRemaining === "number") cap = Math.min(cap, studioHoursRemaining);
cap = Math.min(cap, 10);

if (cap <= 0) {
  await requests.updateRecordAsync(req.id, { "Request Status": sel("FAILED - UNAVAILABLE SLOT") });
  return;
}

// ------------------ Load slots ------------------
const slotQuery = await slots.selectRecordsAsync({
  fields: ["Status", "Start Time", "End Time", "Room", "Hold Token", "Hold Expires At", "Held By Email", "Hold Created"],
});

function getRoomName(slotRec) {
  // Room is a single link field; display string works for both link + lookup.
  return (slotRec.getCellValueAsString("Room") || "").trim();
}

function isAvailable(slotRec) {
  return (slotRec.getCellValueAsString("Status") || "").trim() === "AVAILABLE";
}

// ------------------ Create hold token + confirmation code ------------------
const HOLD_MINUTES = 15;
const now = new Date();
const holdExpires = new Date(now.getTime() + HOLD_MINUTES * 60 * 1000);
const holdToken = `HOLD-${randomToken(12)}`;
const confirmCode = randomCode(10); // longer than old 6-char to reduce collisions

// ------------------ Attempt holds in preference order ------------------
const heldSlotIds = [];
const failedSlotIds = [];

const holdSummaryLines = [];
const failedSummaryLines = [];

const slotUpdates = [];
const bookingCreates = [];

let reservationNumber = 0;
let paidIndex = 0;

for (const link of requestedSlotLinks) {
  if (heldSlotIds.length >= cap) break;
  if (!link?.id) continue;

  const slotRec = slotQuery.getRecord(link.id);
  if (!slotRec) continue;

  const sStartRaw = slotRec.getCellValue("Start Time");
  const sEndRaw = slotRec.getCellValue("End Time");
  const room = getRoomName(slotRec);

  // If slot missing time data, treat as fail
  if (!sStartRaw || !sEndRaw || !room) {
    failedSlotIds.push(slotRec.id);
    failedSummaryLines.push(
      `FAILED: (slot missing room/start/end data) — please submit an IT help desk ticket.`
    );
    continue;
  }

  const sStart = new Date(sStartRaw);
  const sEnd = new Date(sEndRaw);

  if (!isAvailable(slotRec)) {
    failedSlotIds.push(slotRec.id);
    failedSummaryLines.push(
      `FAILED: ${fmtDate(sStart)} // ${room} // ${fmtTime(sStart)} (EST) // ${fmtTime(sEnd)} (EST) — Slot was not available at the time your request was processed.`
    );
    continue;
  }

  // consume one PAID ROSTER record per successful hold
  const paidLink = paidLinks[paidIndex];
  if (!paidLink?.id) {
    // should not happen; but protect
    failedSlotIds.push(slotRec.id);
    failedSummaryLines.push(
      `FAILED: ${fmtDate(sStart)} // ${room} // ${fmtTime(sStart)} (EST) // ${fmtTime(sEnd)} (EST) — Internal error allocating your pre-paid reservation.`
    );
    continue;
  }

  // HOLD the slot
  heldSlotIds.push(slotRec.id);
  reservationNumber++;
  paidIndex++;

  holdSummaryLines.push(slotLine(reservationNumber, room, sStart, sEnd));

  slotUpdates.push({
    id: slotRec.id,
    fields: {
      "Status": sel("HELD"),
      "Held By Email": contactEmail,
      "Hold Token": holdToken,
      "Hold Expires At": holdExpires,
      "Hold Created": now,
    }
  });

  // Create 1 booking per held slot (Slot(s) and Pre-Paid Reservation are single-link fields)
  bookingCreates.push({
    fields: {
      "Booking Status": sel("AWAITING CONFIRMATION"),
      "Booking Request": [{ id: req.id }],
      "Studio": [{ id: studioLink.id }],
      "Pre-Paid Reservation": [{ id: paidLink.id }],
      "Slot(s)": [{ id: slotRec.id }],
      "Hold Token": holdToken,
      "Hold Expires At": holdExpires,
      "Held Contact Email": contactEmail,
      "Confirmation Code": confirmCode,
      "Booking Summary": slotLine(1, room, sStart, sEnd), // per-booking summary (always RESERVATION 1)
    }
  });
}

// If nothing held, fail request
if (heldSlotIds.length === 0) {
  await requests.updateRecordAsync(req.id, {
    "Request Status": sel("FAILED - UNAVAILABLE SLOT"),
    "Hold Token": holdToken,
    "Hold Expires At": holdExpires,
    "Confirmation Code": confirmCode,
    "Hold Summary": "",
    "Failed Slot(s)": failedSlotIds.map(id => ({ id })),
    "Failed Slot Summary": failedSummaryLines.join("\n"),
    "Held Slot(s)": [],
  });
  return;
}

// Apply slot holds
if (slotUpdates.length) {
  await batchUpdate(slots, slotUpdates);
}

// Create bookings
let createdBookingIds = [];
if (bookingCreates.length) {
  createdBookingIds = await batchCreate(bookings, bookingCreates);
}

// Write request outputs
await requests.updateRecordAsync(req.id, {
  "Request Status": sel("HOLD CREATED"),
  "Hold Token": holdToken,
  "Hold Expires At": holdExpires,
  "Confirmation Code": confirmCode,
  "Held Slot(s)": heldSlotIds.map(id => ({ id })),
  "Hold Summary": holdSummaryLines.join("\n"),
  "Failed Slot(s)": failedSlotIds.map(id => ({ id })),
  "Failed Slot Summary": failedSummaryLines.join("\n"),
  "BOOKINGS": createdBookingIds.map(id => ({ id })),
});

console.log(`RRS-2 v2.0.26 complete: held=${heldSlotIds.length}, failed=${failedSlotIds.length}, bookingsCreated=${createdBookingIds.length}`);
