/**
 * RRS-2-BookingRequests-v2.2.26
 * PATCH: LastName-inclusive summaries + per-booking Reservation Name from PAID ROSTER
 *
 * BUG FIXES:
 * - Hold Summary now includes {Last Name} from the specific PAID ROSTER record consumed per booking
 * - Booking Summary now uses the same readable format
 * - BOOKING {Reservation Name} now correctly set as "{Studio Name} // {Last Name}" per booking
 * - Failed Slot Summary now uses the same readable format (Last Name = UNASSIGNED)
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
function resLine(n, lastName, room, start, end) {
  return `RESERVATION ${n}: ${lastName} // ${room} // ${fmtDate(start)} // ${fmtTime(start)} - ${fmtTime(end)} (EST)`;
}
function failLine(lastName, room, start, end, reason) {
  return `FAILED: ${lastName} // ${room} // ${fmtDate(start)} // ${fmtTime(start)} - ${fmtTime(end)} (EST) — ${reason}`;
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

if (!req.getCellValue("Booking Acknowledgement")) {
  await requests.updateRecordAsync(req.id, { "Request Status": sel("NEEDS HELP") });
  return;
}

const studioLink = (req.getCellValue("Studio") || [])[0];
const paidLinks = (req.getCellValue("Pre-Paid Reservation") || []);
const requestedSlotLinks = (req.getCellValue("Requested Slot(s)") || []);

const contactEmail = (req.getCellValueAsString("Contact Email") || "").trim();
const reservationEmailRaw = (req.getCellValueAsString("Reservation Email") || "").trim();
const reservationEmail = reservationEmailRaw.toLowerCase();

if (!studioLink || paidLinks.length === 0 || requestedSlotLinks.length === 0 || !contactEmail || !reservationEmailRaw) {
  await requests.updateRecordAsync(req.id, { "Request Status": sel("NEEDS HELP") });
  return;
}

// ------------------ Load studio & validate DCG email ------------------
const studioQuery = await studios.selectRecordsAsync({ fields: ["DCG Email", "Hours Remaining"] });
const studioRec = studioQuery.getRecord(studioLink.id);
const studioDcg = (studioRec?.getCellValueAsString("DCG Email") || "").trim().toLowerCase();

if (!studioDcg || studioDcg !== reservationEmail) {
  await requests.updateRecordAsync(req.id, {
    "Request Status": sel("FAILED - INVALID EMAIL"),
    "Failed Slot Summary":
      `FAILED: Reservation Email validation failed.\n` +
      `Reservation Email must match your Studio DCG Email.\n` +
      `- Studio DCG Email: ${studioDcg || "MISSING"}\n` +
      `- Reservation Email entered: ${reservationEmail}\n`,
    "Hold Summary": "",
    "Held Slot(s)": [],
    "Failed Slot(s)": [],
    "Hold Token": "",
    "Hold Expires At": null,
    "Confirmation Code": "",
  });
  return;
}

// ------------------ Load PAID ROSTER records: DCG Email + Last Name + Studio Name ------------------
const paidQuery = await paid.selectRecordsAsync({ fields: ["DCG Email", "Last Name", "Studio Name"] });

const paidMetaById = new Map();
const paidEmailMismatches = [];

for (const pl of paidLinks) {
  const pr = paidQuery.getRecord(pl.id);
  const prDcg = (pr?.getCellValueAsString("DCG Email") || "").trim().toLowerCase();
  const prLast = (pr?.getCellValueAsString("Last Name") || "").trim() || "UNKNOWN";
  const prStudio = (pr?.getCellValueAsString("Studio Name") || "").trim() || (req.getCellValueAsString("Studio") || "").trim();

  paidMetaById.set(pl.id, { dcg: prDcg, last: prLast, studio: prStudio });

  if (!prDcg || prDcg !== studioDcg || prDcg !== reservationEmail) {
    paidEmailMismatches.push(`- ${prLast} (${prDcg || "MISSING"})`);
  }
}

if (paidEmailMismatches.length > 0) {
  await requests.updateRecordAsync(req.id, {
    "Request Status": sel("FAILED - INVALID EMAIL"),
    "Failed Slot Summary":
      `FAILED: Reservation Email validation failed.\n` +
      `Reservation Email must match BOTH your Studio DCG Email and the DCG Email on each selected pre-paid reservation.\n\n` +
      `- Studio DCG Email: ${studioDcg}\n` +
      `- Reservation Email entered: ${reservationEmail}\n` +
      `Mismatched/missing DCG Email on selected pre-paid reservation(s):\n` +
      paidEmailMismatches.join("\n"),
    "Hold Summary": "",
    "Held Slot(s)": [],
    "Failed Slot(s)": [],
    "Hold Token": "",
    "Hold Expires At": null,
    "Confirmation Code": "",
  });
  return;
}

// ------------------ Capacity ------------------
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
  fields: ["Status", "Start Time", "End Time", "Room", "Hold Expires At", "Held By Email", "Hold Token", "Hold Created"],
});
function getRoom(slotRec) { return (slotRec.getCellValueAsString("Room") || "").trim(); }
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
const holdLines = [];
const failLines = [];
const slotUpdates = [];
const bookingCreates = [];

let reservationNum = 0;
let paidIndex = 0;

for (let i = 0; i < requestedSlotLinks.length; i++) {
  const link = requestedSlotLinks[i];
  if (!link?.id) continue;

  const slotRec = slotQuery.getRecord(link.id);
  if (!slotRec) continue;

  const room = getRoom(slotRec);
  const sStartRaw = slotRec.getCellValue("Start Time");
  const sEndRaw = slotRec.getCellValue("End Time");
  const hasTime = !!(room && sStartRaw && sEndRaw);

  const sStart = hasTime ? new Date(sStartRaw) : null;
  const sEnd = hasTime ? new Date(sEndRaw) : null;

  // capacity reached => log as not attempted
  if (heldSlotIds.length >= cap) {
    failedSlotIds.push(slotRec.id);
    if (hasTime) {
      failLines.push(failLine("UNASSIGNED", room, sStart, sEnd, "Not attempted (capacity reached for this request)."));
    } else {
      failLines.push("FAILED: UNASSIGNED — Not attempted (capacity reached).");
    }
    continue;
  }

  if (!hasTime) {
    failedSlotIds.push(slotRec.id);
    failLines.push("FAILED: UNASSIGNED — Slot missing room/start/end data.");
    continue;
  }

  if (!isAvailable(slotRec)) {
    failedSlotIds.push(slotRec.id);
    failLines.push(failLine("UNASSIGNED", room, sStart, sEnd, "Slot was not available at the time your request was processed."));
    continue;
  }

  const paidLink = paidLinks[paidIndex];
  if (!paidLink?.id) {
    failedSlotIds.push(slotRec.id);
    failLines.push(failLine("UNASSIGNED", room, sStart, sEnd, "Internal error allocating pre-paid reservation."));
    continue;
  }

  const meta = paidMetaById.get(paidLink.id) || { last: "UNKNOWN", studio: "" };
  const lastName = meta.last || "UNKNOWN";
  const studioName = meta.studio || "";

  // hold slot
  heldSlotIds.push(slotRec.id);
  reservationNum++;
  paidIndex++;

  holdLines.push(resLine(reservationNum, lastName, room, sStart, sEnd));

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
      "Reservation Name": `${studioName} // ${lastName}`.trim(),
      "Booking Summary": `${lastName} // ${room} // ${fmtDate(sStart)} // ${fmtTime(sStart)} - ${fmtTime(sEnd)} (EST)`,
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
    "Failed Slot Summary": failLines.join("\n"),
    "Held Slot(s)": [],
  });
  return;
}

if (slotUpdates.length) await batchUpdate(slots, slotUpdates);

const createdBookingIds = bookingCreates.length ? await batchCreate(bookings, bookingCreates) : [];

await requests.updateRecordAsync(req.id, {
  "Request Status": sel("HOLD CREATED"),
  "Hold Token": holdToken,
  "Hold Expires At": holdExpires,
  "Confirmation Code": confirmCode,
  "Held Slot(s)": heldSlotIds.map(id => ({ id })),
  "Hold Summary": holdLines.join("\n"),
  "Failed Slot(s)": failedSlotIds.map(id => ({ id })),
  "Failed Slot Summary": failLines.join("\n"),
  "BOOKINGS": createdBookingIds.map(id => ({ id })),
});

console.log(`RRS-2 complete: held=${heldSlotIds.length}, failed=${failedSlotIds.length}, bookingsCreated=${createdBookingIds.length}`);
