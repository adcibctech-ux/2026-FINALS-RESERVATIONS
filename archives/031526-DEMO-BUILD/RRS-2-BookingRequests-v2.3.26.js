/**
 * RRS-2-BookingRequests-v2.3.26
 * BOOKING REQUESTS -> MATCH to slots (no slot hold) + create 1 BOOKING per match + write Match/Backup summaries
 *
 * BUG FIXES:
 * - Removes HELD usage entirely: slot Status is NOT changed on match (remains AVAILABLE until confirmation).
 * - Uses Match Token/Match Expires At/Match Summary naming.
 * - Produces Backup Slot(s)/Backup Slot Summary for non-attempted or unavailable slots.
 *
 * BEHAVIOR:
 * - cap = MIN(count(Pre-Paid Reservation), Studio Hours Remaining (if present), 15)
 * - Iterates Requested Slot(s) in order:
 *    - If slot Status == AVAILABLE and under cap -> create BOOKING (MATCHED) tied to one PAID ROSTER record
 *    - Else -> add to Backup Slot(s) + Backup Slot Summary with reason
 * - DOES NOT change slot Status.
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

// Match summary lines: keep "RESERVATION N:" style for emails
function matchLine(n, lastName, room, start, end) {
  return `RESERVATION ${n}: ${lastName} // ${room} // ${fmtDate(start)} // ${fmtTime(start)} - ${fmtTime(end)} (EST)`;
}
function backupLine(lastName, room, start, end, reason) {
  return `BACKUP: ${lastName} // ${room} // ${fmtDate(start)} // ${fmtTime(start)} - ${fmtTime(end)} (EST) — ${reason}`;
}

// Booking summary (per booking) – no RESERVATION prefix
function bookingSummary(lastName, room, start, end) {
  return `${lastName} // ${room} // ${fmtDate(start)} // ${fmtTime(start)} - ${fmtTime(end)} (EST)`;
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

function safeGetField(table, name) {
  try { table.getField(name); return name; } catch { return null; }
}

// --- resolve field names with fallback (in case you haven't renamed everything yet)
const F_MATCH_TOKEN = safeGetField(requests, "Match Token") || safeGetField(requests, "Hold Token");
const F_MATCH_EXPIRES = safeGetField(requests, "Match Expires At") || safeGetField(requests, "Hold Expires At");
const F_MATCH_SUMMARY = safeGetField(requests, "Match Summary") || safeGetField(requests, "Hold Summary");

const F_BACKUP_SLOTS = safeGetField(requests, "Backup Slot(s)") || safeGetField(requests, "Failed Slot(s)");
const F_BACKUP_SUMMARY = safeGetField(requests, "Backup Slot Summary") || safeGetField(requests, "Failed Slot Summary");

const F_BOOKINGS_LINK = safeGetField(requests, "BOOKINGS");

const F_REQ_STATUS = safeGetField(requests, "Request Status");

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
    ...(F_MATCH_TOKEN ? [F_MATCH_TOKEN] : []),
    ...(F_MATCH_EXPIRES ? [F_MATCH_EXPIRES] : []),
    ...(F_MATCH_SUMMARY ? [F_MATCH_SUMMARY] : []),
    ...(F_BACKUP_SLOTS ? [F_BACKUP_SLOTS] : []),
    ...(F_BACKUP_SUMMARY ? [F_BACKUP_SUMMARY] : []),
    ...(F_BOOKINGS_LINK ? [F_BOOKINGS_LINK] : []),
    ...(F_REQ_STATUS ? [F_REQ_STATUS] : []),
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

// ------------------ Email validation (Studio DCG == each Paid DCG == Reservation Email) ------------------
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
const paidMismatch = [];

for (const pl of paidLinks) {
  const pr = paidQuery.getRecord(pl.id);
  const dcg = (pr?.getCellValueAsString("DCG Email") || "").trim().toLowerCase();
  const last = (pr?.getCellValueAsString("Last Name") || "").trim() || "UNKNOWN";
  const studioName = (pr?.getCellValueAsString("Studio Name") || "").trim() || "";

  paidMeta.push({ id: pl.id, dcg, last, studioName });

  if (!dcg || dcg !== studioDcg) paidMismatch.push(`${last} (${dcg || "MISSING"})`);
}

if (paidMismatch.length > 0) {
  const upd = {};
  if (F_REQ_STATUS) upd[F_REQ_STATUS] = sel("FAILED - INVALID EMAIL");
  if (F_BACKUP_SUMMARY) upd[F_BACKUP_SUMMARY] =
    `FAILED: Reservation Email must match DCG Email on all selected pre-paid reservations.\n` +
    `- Studio DCG Email: ${studioDcg}\n` +
    `Mismatched/missing on selected reservation(s):\n- ${paidMismatch.join("\n- ")}`;
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

// ------------------ Match + create bookings ------------------
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

  // capacity reached => backup (not attempted)
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

  // MATCH
  matchedSlotIds.push(slotRec.id);
  matchN++;
  paidIndex++;

  matchLines.push(matchLine(matchN, paidRec.last, room, sStart, sEnd));

  bookingCreates.push({
    fields: {
      "Booking Status": sel("MATCHED"),
      "Booking Request": [{ id: req.id }],
      "Studio": [{ id: studioLink.id }],
      "Pre-Paid Reservation": [{ id: paidRec.id }],
      "Slot(s)": [{ id: slotRec.id }],
      "Match Token": matchToken,
      "Match Expires At": matchExpires,
      "Held Contact Email": contactEmail,
      "Confirmation Code": confirmCode,
      "Reservation Name": `${paidRec.studioName} // ${paidRec.last}`.trim(),
      "Booking Summary": bookingSummary(paidRec.last, room, sStart, sEnd),
    }
  });
}

if (matchedSlotIds.length === 0) {
  const upd = {};
  if (F_REQ_STATUS) upd[F_REQ_STATUS] = sel("FAILED - UNAVAILABLE SLOT");
  if (F_MATCH_TOKEN) upd[F_MATCH_TOKEN] = matchToken;
  if (F_MATCH_EXPIRES) upd[F_MATCH_EXPIRES] = matchExpires;
  if (safeGetField(requests, "Confirmation Code")) upd["Confirmation Code"] = confirmCode;
  if (F_MATCH_SUMMARY) upd[F_MATCH_SUMMARY] = "";
  if (F_BACKUP_SLOTS) upd[F_BACKUP_SLOTS] = backupSlotIds.map(id => ({ id }));
  if (F_BACKUP_SUMMARY) upd[F_BACKUP_SUMMARY] = backupLines.join("\n");
  await requests.updateRecordAsync(req.id, upd);
  return;
}

const createdBookingIds = bookingCreates.length ? await batchCreate(bookings, bookingCreates) : [];

// Update request
const upd = {};
if (F_REQ_STATUS) upd[F_REQ_STATUS] = sel("MATCHED");
if (F_MATCH_TOKEN) upd[F_MATCH_TOKEN] = matchToken;
if (F_MATCH_EXPIRES) upd[F_MATCH_EXPIRES] = matchExpires;
if (safeGetField(requests, "Confirmation Code")) upd["Confirmation Code"] = confirmCode;
if (F_MATCH_SUMMARY) upd[F_MATCH_SUMMARY] = matchLines.join("\n");
if (safeGetField(requests, "Matched Slot(s)")) upd["Matched Slot(s)"] = matchedSlotIds.map(id => ({ id })); // optional
if (F_BACKUP_SLOTS) upd[F_BACKUP_SLOTS] = backupSlotIds.map(id => ({ id }));
if (F_BACKUP_SUMMARY) upd[F_BACKUP_SUMMARY] = backupLines.join("\n");
if (F_BOOKINGS_LINK) upd[F_BOOKINGS_LINK] = createdBookingIds.map(id => ({ id }));

await requests.updateRecordAsync(req.id, upd);

console.log(`RRS-2 v2.3.26 complete: matched=${matchedSlotIds.length}, backups=${backupSlotIds.length}, bookingsCreated=${createdBookingIds.length}`);
