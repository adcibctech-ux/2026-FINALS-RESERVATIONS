/**
 * RRS-2-BookingRequests-v2.1.26
 * BOOKING REQUESTS -> Deterministic multi-slot holds + 1 BOOKING per held slot + summaries
 *
 * BUG FIXES:
 * - Reinforced email validation:
 *    STUDIO ROSTER {DCG Email} == each selected PAID ROSTER {DCG Email} == BOOKING REQUESTS {Reservation Email}
 *   If mismatch -> Request Status = "FAILED - INVALID EMAIL" and STOP (no holds, no bookings).
 * - Logs validation failure message into {Failed Slot Summary} for clean email branching.
 *
 * BEHAVIOR:
 * - cap = MIN(count(Pre-Paid Reservation), Studio Hours Remaining (if present), 15)
 * - Attempts holds in selection order until cap held.
 * - Remaining requested slots beyond cap are logged as FAILED (NOT ATTEMPTED — capacity reached).
 * - Writes Hold / Failed / Booking summaries with EST formatting.
 */

const cfg = input.config();
const requestRecordId = cfg.recordId;

const REQ_TABLE = "BOOKING REQUESTS";
const BOOK_TABLE = "BOOKINGS";
const SLOTS_TABLE = "SLOTS (Operational)";
const STUDIO_TABLE = "STUDIO ROSTER";
const PAID_TABLE = "PAID ROSTER";

const requests = base.getTable(REQ_TABLE);
const bookings = base.getTable(BOOK_TABLE);
const slots = base.getTable(SLOTS_TABLE);
const studios = base.getTable(STUDIO_TABLE);
const paid = base.getTable(PAID_TABLE);

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
    "Reservation Name",
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
const reservationEmailRaw = (req.getCellValueAsString("Reservation Email") || "").trim();
const reservationEmail = reservationEmailRaw.toLowerCase();
const reservationName = (req.getCellValueAsString("Reservation Name") || "").trim();

if (!studioLink || paidLinks.length === 0 || requestedSlotLinks.length === 0 || !contactEmail || !reservationEmailRaw) {
  await requests.updateRecordAsync(req.id, { "Request Status": sel("NEEDS HELP") });
  return;
}

// ------------------ Email validation (bolstered) ------------------
// Load studio DCG Email
const studioQuery = await studios.selectRecordsAsync({ fields: ["DCG Email", "Hours Remaining"] });
const studioRec = studioQuery.getRecord(studioLink.id);
const studioDcgEmail = (studioRec?.getCellValueAsString("DCG Email") || "").trim().toLowerCase();

if (!studioDcgEmail) {
  await requests.updateRecordAsync(req.id, {
    "Request Status": sel("FAILED - INVALID EMAIL"),
    "Failed Slot Summary": "FAILED: Studio DCG Email is missing in STUDIO ROSTER. Please contact the office manager.",
  });
  return;
}

if (studioDcgEmail !== reservationEmail) {
  await requests.updateRecordAsync(req.id, {
    "Request Status": sel("FAILED - INVALID EMAIL"),
    "Failed Slot Summary":
      `FAILED: Reservation Email validation failed.\n` +
      `- Studio DCG Email: ${studioDcgEmail}\n` +
      `- Reservation Email entered: ${reservationEmail}\n` +
      `Please re-submit and enter the exact DCG email associated with your studio/payment.`,
    "Hold Summary": "",
    "Held Slot(s)": [],
    "Failed Slot(s)": [],
    "Hold Token": "",
    "Hold Expires At": null,
    "Confirmation Code": "",
  });
  return;
}

// Load PAID ROSTER DCG Emails for all selected paid records
const paidQuery = await paid.selectRecordsAsync({ fields: ["DCG Email"] });
const badPaid = [];
for (const pl of paidLinks) {
  const pr = paidQuery.getRecord(pl.id);
  const paidDcg = (pr?.getCellValueAsString("DCG Email") || "").trim().toLowerCase();
  if (!paidDcg) {
    badPaid.push(`(missing DCG Email) record=${pl.id}`);
    continue;
  }
  if (paidDcg !== studioDcgEmail || paidDcg !== reservationEmail) {
    badPaid.push(`${paidDcg} (record=${pl.id})`);
  }
}

if (badPaid.length > 0) {
  await requests.updateRecordAsync(req.id, {
    "Request Status": sel("FAILED - INVALID EMAIL"),
    "Failed Slot Summary":
      `FAILED: Reservation Email validation failed.\n` +
      `Reservation Email must match BOTH your Studio DCG Email and the DCG Email on each selected pre-paid reservation.\n\n` +
      `- Studio DCG Email: ${studioDcgEmail}\n` +
      `- Reservation Email entered: ${reservationEmail}\n` +
      `- Mismatched/missing DCG Email on selected pre-paid reservation(s):\n  - ${badPaid.join("\n  - ")}\n\n` +
      `Please re-submit and make sure you selected the correct pre-paid reservation(s) and entered the correct DCG email.`,
    "Hold Summary": "",
    "Held Slot(s)": [],
    "Failed Slot(s)": [],
    "Hold Token": "",
    "Hold Expires At": null,
    "Confirmation Code": "",
  });
  return;
}

// ------------------ Capacity (uses Studio Hours Remaining if numeric) ------------------
let studioHoursRemaining = null;
const hr = studioRec?.getCellValue("Hours Remaining");
if (typeof hr === "number") studioHoursRemaining = hr;
else {
  const hrStr = (studioRec?.getCellValueAsString("Hours Remaining") || "").trim();
  const hrNum = parseFloat(hrStr);
  if (!Number.isNaN(hrNum)) studioHoursRemaining = hrNum;
}

let cap = paidLinks.length;
if (typeof studioHoursRemaining === "number") cap = Math.min(cap, studioHoursRemaining);
cap = Math.min(cap, 15);

if (cap <= 0) {
  await requests.updateRecordAsync(req.id, { "Request Status": sel("FAILED - UNAVAILABLE SLOT") });
  return;
}

// ------------------ Load slots ------------------
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

  // If we've reached cap, mark NOT ATTEMPTED due to capacity
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

  if (!hasTimeData) {
    failedSlotIds.push(slotRec.id);
    failedSummaryLines.push(`FAILED: (slot missing room/start/end data) — please submit an IT help desk ticket.`);
    continue;
  }

  if (!isAvailable(slotRec)) {
    failedSlotIds.push(slotRec.id);
    failedSummaryLines.push(
      `FAILED: ${fmtDate(sStart)} // ${room} // ${fmtTime(sStart)} (EST) // ${fmtTime(sEnd)} (EST) — Slot was not available at the time your request was processed.`
    );
    continue;
  }

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
      "Reservation Name": reservationName || "",
      "Booking Summary": slotLine(1, room, sStart, sEnd),
    }
  });
}

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

if (slotUpdates.length) await batchUpdate(slots, slotUpdates);

let createdBookingIds = [];
if (bookingCreates.length) createdBookingIds = await batchCreate(bookings, bookingCreates);

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

console.log(`RRS-2 v2.1.26 complete: held=${heldSlotIds.length}, failed=${failedSlotIds.length}, bookingsCreated=${createdBookingIds.length}`);
