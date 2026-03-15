/**
 * RRS-2-BookingRequests-v2.1.26
 * BOOKING REQUESTS (new) -> Deterministic multi-slot holds (in preference order) + create 1 BOOKING per held slot + write summaries
 *
 * BUG FIXES:
 * - Log requested slots beyond capacity as FAILED (NOT ATTEMPTED — capacity reached) [Option A]
 * - Ensure every created BOOKING links {Booking Request}
 * - Populate {Reservation Name} on each BOOKING (required downstream for writeback)
 *
 * BEHAVIOR:
 * - cap = MIN(count(Pre-Paid Reservation), Studio Hours Remaining (if present), 15)
 * - Attempts holds in selection order until cap held.
 * - Remaining requested slots (after cap reached) are logged to Failed Slot(s)/Summary as "NOT ATTEMPTED — capacity reached"
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

function sel(name) { return { name }; }

function randomCode(len = 10) {
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
    "Reservation Name",          // <-- formula you already have on requests
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
const reservationName = (req.getCellValueAsString("Reservation Name") || "").trim();

if (!studioLink || paidLinks.length === 0 || requestedSlotLinks.length === 0 || !contactEmail || !reservationEmail) {
  await requests.updateRecordAsync(req.id, { "Request Status": sel("NEEDS HELP") });
  return;
}

// ------------------ Load studio hours remaining (optional cap) ------------------
let studioHoursRemaining = null;
try {
  const studioQuery = await studios.selectRecordsAsync({ fields: ["Hours Remaining"] });
  const studioRec = studioQuery.getRecord(studioLink.id);
  if (studioRec) {
    const hr = studioRec.getCellValue("Hours Remaining");
    if (typeof hr === "number") studioHoursRemaining = hr;
    else {
      const asStr = (studioRec.getCellValueAsString("Hours Remaining") || "").trim();
      const asNum = parseFloat(asStr);
      if (!Number.isNaN(asNum)) studioHoursRemaining = asNum;
    }
  }
} catch (_) {}

let cap = paidLinks.length;
if (typeof studioHoursRemaining === "number") cap = Math.min(cap, studioHoursRemaining);
cap = Math.min(cap, 15);

if (cap <= 0) {
  await requests.updateRecordAsync(req.id, { "Request Status": sel("FAILED - UNAVAILABLE SLOT") });
  return;
}

// ------------------ Load slot records ------------------
const slotQuery = await slots.selectRecordsAsync({
  fields: ["Status", "Start Time", "End Time", "Room", "Hold Token", "Hold Expires At", "Held By Email", "Hold Created"],
});
function getRoomName(slotRec) { return (slotRec.getCellValueAsString("Room") || "").trim(); }
function isAvailable(slotRec) { return (slotRec.getCellValueAsString("Status") || "").trim() === "AVAILABLE"; }

// ------------------ Hold metadata ------------------
const HOLD_MINUTES = 15;
const now = new Date();
const holdExpires = new Date(now.getTime() + HOLD_MINUTES * 60 * 1000);
const holdToken = `HOLD-${randomToken(12)}`;
const confirmCode = randomCode(10);

// ------------------ Attempt holds ------------------
const heldSlotIds = [];
const failedSlotIds = [];
const holdSummaryLines = [];
const failedSummaryLines = [];
const slotUpdates = [];
const bookingCreates = [];

let reservationNumber = 0;
let paidIndex = 0;

for (let i = 0; i < requestedSlotLinks.length; i++) {
  const link = requestedSlotLinks[i];
  if (!link?.id) continue;

  const slotRec = slotQuery.getRecord(link.id);
  if (!slotRec) continue;

  const sStartRaw = slotRec.getCellValue("Start Time");
  const sEndRaw = slotRec.getCellValue("End Time");
  const room = getRoomName(slotRec);

  const hasTimeData = !!(sStartRaw && sEndRaw && room);
  const sStart = hasTimeData ? new Date(sStartRaw) : null;
  const sEnd = hasTimeData ? new Date(sEndRaw) : null;

  // If we've already reached cap, mark as NOT ATTEMPTED due to capacity
  if (heldSlotIds.length >= cap) {
    failedSlotIds.push(slotRec.id);
    if (hasTimeData) {
      failedSummaryLines.push(
        `FAILED: ${fmtDate(sStart)} // ${room} // ${fmtTime(sStart)} (EST) // ${fmtTime(sEnd)} (EST) — Not attempted (capacity reached for this request).`
      );
    } else {
      failedSummaryLines.push(`FAILED: (slot missing room/start/end data) — Not attempted (capacity reached).`);
    }
    continue;
  }

  // Missing time/room data
  if (!hasTimeData) {
    failedSlotIds.push(slotRec.id);
    failedSummaryLines.push(`FAILED: (slot missing room/start/end data) — please submit an IT help desk ticket.`);
    continue;
  }

  // Slot not available
  if (!isAvailable(slotRec)) {
    failedSlotIds.push(slotRec.id);
    failedSummaryLines.push(
      `FAILED: ${fmtDate(sStart)} // ${room} // ${fmtTime(sStart)} (EST) // ${fmtTime(sEnd)} (EST) — Slot was not available at the time your request was processed.`
    );
    continue;
  }

  // Allocate one PAID record per held slot
  const paidLink = paidLinks[paidIndex];
  if (!paidLink?.id) {
    failedSlotIds.push(slotRec.id);
    failedSummaryLines.push(
      `FAILED: ${fmtDate(sStart)} // ${room} // ${fmtTime(sStart)} (EST) // ${fmtTime(sEnd)} (EST) — Internal error allocating your pre-paid reservation.`
    );
    continue;
  }

  // HOLD slot
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

  // Create 1 booking per held slot
  bookingCreates.push({
    fields: {
      "Booking Status": sel("AWAITING CONFIRMATION"),
      "Booking Request": [{ id: req.id }],     // <-- ensure all bookings link back
      "Studio": [{ id: studioLink.id }],
      "Pre-Paid Reservation": [{ id: paidLink.id }],
      "Slot(s)": [{ id: slotRec.id }],
      "Hold Token": holdToken,
      "Hold Expires At": holdExpires,
      "Held Contact Email": contactEmail,
      "Confirmation Code": confirmCode,
      "Reservation Name": reservationName || "",
      "Booking Summary": slotLine(1, room, sStart, sEnd),
    }
  });
}

// Nothing held
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

// Apply holds
if (slotUpdates.length) await batchUpdate(slots, slotUpdates);

// Create bookings
let createdBookingIds = [];
if (bookingCreates.length) createdBookingIds = await batchCreate(bookings, bookingCreates);

// Update request
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
