/**
 * RRS-2-BookingRequests-v2.5.26
 * PATCH: Fix summary time formatting to America/New_York (EST/EDT) using Intl.DateTimeFormat
 *
 * BUG FIXES:
 * - Summary fields were displaying UTC times (+4 hours). Now forces America/New_York.
 *
 * BEHAVIOR:
 * - Same as v2.4 logic: matches slots (no slot hold), creates MATCHED bookings, writes Match/Backup summaries.
 * - Slots remain AVAILABLE until confirmation sets BOOKED.
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

// ---- TIMEZONE SAFE FORMATTERS (America/New_York) ----
const TZ = "America/New_York";

const fmtDateNY = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  month: "2-digit",
  day: "2-digit",
  year: "2-digit",
});

const fmtTimeNY = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

function dateStr(d) {
  // returns MM/DD/YY
  return fmtDateNY.format(d);
}
function timeStr(d) {
  // returns like "9:30 AM"
  return fmtTimeNY.format(d);
}

function matchLine(n, lastName, room, start, end) {
  return `RESERVATION ${n}: ${lastName} // ${room} // ${dateStr(start)} // ${timeStr(start)} - ${timeStr(end)} (EST)`;
}
function backupLine(lastName, room, start, end, reason) {
  return `BACKUP: ${lastName} // ${room} // ${dateStr(start)} // ${timeStr(start)} - ${timeStr(end)} (EST) — ${reason}`;
}
function bookingSummary(lastName, room, start, end) {
  return `${lastName} // ${room} // ${dateStr(start)} // ${timeStr(start)} - ${timeStr(end)} (EST)`;
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

function safeField(table, name) {
  try { return table.getField(name); } catch { return null; }
}
function safeName(table, name) {
  return safeField(table, name) ? name : null;
}
function isWritable(table, name) {
  const f = safeField(table, name);
  return !!(f && !f.isComputed);
}

// BOOKING REQUESTS field names (supports mid-rename)
const F_MATCH_TOKEN = safeName(requests, "Match Token") || safeName(requests, "Hold Token");
const F_MATCH_EXPIRES = safeName(requests, "Match Expires At") || safeName(requests, "Hold Expires At");
const F_MATCH_SUMMARY = safeName(requests, "Match Summary") || safeName(requests, "Hold Summary");

const F_BACKUP_SLOTS = safeName(requests, "Backup Slot(s)") || safeName(requests, "Failed Slot(s)");
const F_BACKUP_SUMMARY = safeName(requests, "Backup Slot Summary") || safeName(requests, "Failed Slot Summary");

const F_BOOKINGS_LINK = safeName(requests, "BOOKINGS");
const F_REQ_STATUS = safeName(requests, "Request Status");

// ------------------ Load request ------------------
const reqQuery = await requests.selectRecordsAsync({
  fields: [
    "Studio",
    "Pre-Paid Reservation",
    "Requested Slot(s)",
    "Reservation Email",
    "Contact Email",
    "Booking Acknowledgement",
    ...(F_MATCH_TOKEN ? [F_MATCH_TOKEN] : []),
    ...(F_MATCH_EXPIRES ? [F_MATCH_EXPIRES] : []),
    ...(F_MATCH_SUMMARY ? [F_MATCH_SUMMARY] : []),
    ...(F_BACKUP_SLOTS ? [F_BACKUP_SLOTS] : []),
    ...(F_BACKUP_SUMMARY ? [F_BACKUP_SUMMARY] : []),
    ...(F_BOOKINGS_LINK ? [F_BOOKINGS_LINK] : []),
    ...(F_REQ_STATUS ? [F_REQ_STATUS] : []),
    ...(safeName(requests, "Confirmation Code") ? ["Confirmation Code"] : []),
  ],
});

const req = reqQuery.getRecord(requestRecordId);
if (!req) throw new Error(`BOOKING REQUESTS record not found: ${requestRecordId}`);

if (!req.getCellValue("Booking Acknowledgement")) {
  if (F_REQ_STATUS) await requests.updateRecordAsync(req.id, { [F_REQ_STATUS]: sel("NEEDS HELP") });
  return;
}

const studioLink = (req.getCellValue("Studio") || [])[0];
const paidLinks = (req.getCellValue("Pre-Paid Reservation") || []);
const requestedSlotLinks = (req.getCellValue("Requested Slot(s)") || []);

const contactEmail = (req.getCellValueAsString("Contact Email") || "").trim();
const reservationEmailRaw = (req.getCellValueAsString("Reservation Email") || "").trim();
const reservationEmail = reservationEmailRaw.toLowerCase();

if (!studioLink || paidLinks.length === 0 || requestedSlotLinks.length === 0 || !contactEmail || !reservationEmailRaw) {
  if (F_REQ_STATUS) await requests.updateRecordAsync(req.id, { [F_REQ_STATUS]: sel("NEEDS HELP") });
  return;
}

// ------------------ Validate DCG Email ------------------
const studioQuery = await studios.selectRecordsAsync({ fields: ["DCG Email", "Hours Remaining"] });
const studioRec = studioQuery.getRecord(studioLink.id);
const studioDcg = (studioRec?.getCellValueAsString("DCG Email") || "").trim().toLowerCase();

if (!studioDcg || studioDcg !== reservationEmail) {
  const upd = {};
  if (F_REQ_STATUS) upd[F_REQ_STATUS] = sel("FAILED - INVALID EMAIL");
  if (F_BACKUP_SUMMARY) upd[F_BACKUP_SUMMARY] =
    `FAILED: Reservation Email must match your Studio DCG Email.\n- Studio DCG Email: ${studioDcg || "MISSING"}\n- Entered: ${reservationEmail}`;
  await requests.updateRecordAsync(req.id, upd);
  return;
}

const paidQuery = await paid.selectRecordsAsync({ fields: ["DCG Email", "Last Name", "Studio Name"] });

const paidMeta = [];
const mismatches = [];

for (const pl of paidLinks) {
  const pr = paidQuery.getRecord(pl.id);
  const dcg = (pr?.getCellValueAsString("DCG Email") || "").trim().toLowerCase();
  const last = (pr?.getCellValueAsString("Last Name") || "").trim() || "UNKNOWN";
  const studioName = (pr?.getCellValueAsString("Studio Name") || "").trim() || "";

  paidMeta.push({ id: pl.id, last, studioName });

  if (!dcg || dcg !== studioDcg) mismatches.push(`${last} (${dcg || "MISSING"})`);
}

if (mismatches.length > 0) {
  const upd = {};
  if (F_REQ_STATUS) upd[F_REQ_STATUS] = sel("FAILED - INVALID EMAIL");
  if (F_BACKUP_SUMMARY) upd[F_BACKUP_SUMMARY] =
    `FAILED: Reservation Email must match DCG Email on all selected pre-paid reservations.\n` +
    `- Studio DCG Email: ${studioDcg}\n` +
    `Mismatched/missing:\n- ${mismatches.join("\n- ")}`;
  await requests.updateRecordAsync(req.id, upd);
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

const now = new Date();
const MATCH_MINUTES = 15;
const matchExpires = new Date(now.getTime() + MATCH_MINUTES * 60 * 1000);
const matchToken = `MATCH-${randomToken(12)}`;
const confirmCode = randomCode(10);

// ------------------ Load slots ------------------
const slotQuery = await slots.selectRecordsAsync({
  fields: ["Status", "Start Time", "End Time", "Room"],
});
function roomName(slotRec) { return (slotRec.getCellValueAsString("Room") || "").trim(); }
function isAvailable(slotRec) { return (slotRec.getCellValueAsString("Status") || "").trim() === "AVAILABLE"; }

const matchedSlotIds = [];
const backupSlotIds = [];
const matchLines = [];
const backupLines = [];
const bookingCreates = [];

let matchN = 0;
let paidIndex = 0;

for (const link of requestedSlotLinks) {
  const slotRec = slotQuery.getRecord(link.id);
  if (!slotRec) continue;

  const room = roomName(slotRec);
  const sStartRaw = slotRec.getCellValue("Start Time");
  const sEndRaw = slotRec.getCellValue("End Time");
  const hasTime = !!(room && sStartRaw && sEndRaw);

  const sStart = hasTime ? new Date(sStartRaw) : null;
  const sEnd = hasTime ? new Date(sEndRaw) : null;

  if (matchedSlotIds.length >= cap) {
    backupSlotIds.push(slotRec.id);
    if (hasTime) backupLines.push(backupLine("UNASSIGNED", room, sStart, sEnd, "Not attempted (capacity reached)."));
    else backupLines.push("BACKUP: UNASSIGNED — Not attempted (capacity reached).");
    continue;
  }

  if (!hasTime) {
    backupSlotIds.push(slotRec.id);
    backupLines.push("BACKUP: UNASSIGNED — Slot missing room/start/end data.");
    continue;
  }

  if (!isAvailable(slotRec)) {
    backupSlotIds.push(slotRec.id);
    backupLines.push(backupLine("UNASSIGNED", room, sStart, sEnd, "Slot was not available when your request was processed."));
    continue;
  }

  const paidRec = paidMeta[paidIndex];
  if (!paidRec) {
    backupSlotIds.push(slotRec.id);
    backupLines.push(backupLine("UNASSIGNED", room, sStart, sEnd, "Internal error allocating pre-paid reservation."));
    continue;
  }

  matchedSlotIds.push(slotRec.id);
  matchN++;
  paidIndex++;

  matchLines.push(matchLine(matchN, paidRec.last, room, sStart, sEnd));

  const bFields = {
    "Booking Status": sel("MATCHED"),
    "Booking Request": [{ id: req.id }],
    "Studio": [{ id: studioLink.id }],
    "Pre-Paid Reservation": [{ id: paidRec.id }],
    "Slot(s)": [{ id: slotRec.id }],
    "Held Contact Email": contactEmail,
    "Confirmation Code": confirmCode,
    "Reservation Name": `${paidRec.studioName} // ${paidRec.last}`.trim(),
    "Booking Summary": bookingSummary(paidRec.last, room, sStart, sEnd),
  };

  if (isWritable(bookings, "Match Token")) bFields["Match Token"] = matchToken;
  if (isWritable(bookings, "Match Expires At")) bFields["Match Expires At"] = matchExpires;

  bookingCreates.push({ fields: bFields });
}

if (matchedSlotIds.length === 0) {
  const upd = {};
  if (F_REQ_STATUS) upd[F_REQ_STATUS] = sel("FAILED - UNAVAILABLE SLOT");
  if (F_MATCH_TOKEN) upd[F_MATCH_TOKEN] = matchToken;
  if (F_MATCH_EXPIRES) upd[F_MATCH_EXPIRES] = matchExpires;
  if (safeName(requests, "Confirmation Code")) upd["Confirmation Code"] = confirmCode;
  if (F_MATCH_SUMMARY) upd[F_MATCH_SUMMARY] = "";
  if (F_BACKUP_SLOTS) upd[F_BACKUP_SLOTS] = backupSlotIds.map(id => ({ id }));
  if (F_BACKUP_SUMMARY) upd[F_BACKUP_SUMMARY] = backupLines.join("\n");
  await requests.updateRecordAsync(req.id, upd);
  return;
}

const createdBookingIds = bookingCreates.length ? await batchCreate(bookings, bookingCreates) : [];

const upd = {};
if (F_REQ_STATUS) upd[F_REQ_STATUS] = sel("MATCHED");
if (F_MATCH_TOKEN) upd[F_MATCH_TOKEN] = matchToken;
if (F_MATCH_EXPIRES) upd[F_MATCH_EXPIRES] = matchExpires;
if (safeName(requests, "Confirmation Code")) upd["Confirmation Code"] = confirmCode;
if (F_MATCH_SUMMARY) upd[F_MATCH_SUMMARY] = matchLines.join("\n");
if (safeName(requests, "Matched Slot(s)")) upd["Matched Slot(s)"] = matchedSlotIds.map(id => ({ id }));
if (F_BACKUP_SLOTS) upd[F_BACKUP_SLOTS] = backupSlotIds.map(id => ({ id }));
if (F_BACKUP_SUMMARY) upd[F_BACKUP_SUMMARY] = backupLines.join("\n");
if (F_BOOKINGS_LINK) upd[F_BOOKINGS_LINK] = createdBookingIds.map(id => ({ id }));

await requests.updateRecordAsync(req.id, upd);

console.log(`RRS-2 v2.5.26 complete: matched=${matchedSlotIds.length}, backups=${backupSlotIds.length}, bookingsCreated=${createdBookingIds.length}`);
