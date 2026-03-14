/**
 * RRS-2-BookingRequests-v1.3.26
 * BOOKING REQUESTS (new) -> Hold best slot (ranked choices, else smart fallback) + generate confirmation code + update request
 *
 * BUG FIXES: Create provisional BOOKINGS record when a hold is created; set Booking Status = AWAITING CONFIRMATION; write hold metadata onto BOOKINGS.
 *
 * BEHAVIOR:
 * Priority:
 * 1) Slot Choice #1 if AVAILABLE
 * 2) Slot Choice #2 if AVAILABLE
 * 3) Slot Choice #3 if AVAILABLE
 * 4) Nonconflicting 60-min AVAILABLE slot
 * 5) Nonconflicting 30-min AVAILABLE slot
 *
 * If chosen slot is 30-min, attempts to also hold a second 30-min slot (to total 60) using remaining ranked choices first,
 * then fallback nonconflicting 30-min.
 *
 * If cannot hold anything -> Request Status = NEEDS HELP
 */

const cfg = input.config();
const requestRecordId = cfg.recordId;

const REQ_TABLE = "BOOKING REQUESTS";
const PAID_TABLE = "PAID ROSTER";
const SLOTS_TABLE = "SLOTS (Operational)";
const SCHED_TABLE = "MASTER SCHEDULE (Synced)";
const BOOKINGS_TABLE = "BOOKINGS";

const requests = base.getTable(REQ_TABLE);
const paid = base.getTable(PAID_TABLE);
const slots = base.getTable(SLOTS_TABLE);
const sched = base.getTable(SCHED_TABLE);
const bookings = base.getTable(BOOKINGS_TABLE);

function sel(name) { return { name }; } // singleSelect-safe in automations

function randomCode(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
function randomToken(len = 10) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
function minutesBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 60000);
}
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}
function containsIgnoreCase(hay, needle) {
  return (hay || "").toLowerCase().includes((needle || "").toLowerCase());
}

const HOLD_MINUTES = 15;
const now = new Date();
const holdExpires = new Date(now.getTime() + HOLD_MINUTES * 60 * 1000);
const holdToken = `HOLD-${randomToken(10)}`;
const confirmCode = randomCode(6);

// ------------------ Load request ------------------
const reqQuery = await requests.selectRecordsAsync({
  fields: [
    "Pre-Paid Reservation",
    "Reservation Email",
    "Contact Email",
    "Slot Choice #1",
    "Slot Choice #2",
    "Slot Choice #3",
    "Held Slot(s)",
    "Hold Token",
    "Hold Expires At",
    "Confirmation Code",
    "Request Status",
    "Booking Acknowledgement",
  ],
});
const req = reqQuery.getRecord(requestRecordId);
if (!req) throw new Error(`BOOKING REQUESTS record not found: ${requestRecordId}`);

const ack = req.getCellValue("Booking Acknowledgement");
if (!ack) {
  await requests.updateRecordAsync(req.id, { "Request Status": sel("NEEDS HELP") });
  return;
}

const contactEmail = (req.getCellValueAsString("Contact Email") || "").trim();
const reservationEmail = (req.getCellValueAsString("Reservation Email") || "").trim().toLowerCase();
if (!contactEmail || !reservationEmail) {
  await requests.updateRecordAsync(req.id, { "Request Status": sel("NEEDS HELP") });
  return;
}

const paidLink = (req.getCellValue("Pre-Paid Reservation") || [])[0];
if (!paidLink) {
  await requests.updateRecordAsync(req.id, { "Request Status": sel("NEEDS HELP") });
  return;
}

// ------------------ Load paid roster record ------------------
const paidQuery = await paid.selectRecordsAsync({
  fields: ["Attendee Age", "Attendee Code", "DCG Email"],
});
const paidRec = paidQuery.getRecord(paidLink.id);
if (!paidRec) {
  await requests.updateRecordAsync(req.id, { "Request Status": sel("NEEDS HELP") });
  return;
}

const dcgEmail = (paidRec.getCellValueAsString("DCG Email") || "").trim().toLowerCase();

// Validation: DCG Email must match Reservation Email
if (!dcgEmail || dcgEmail !== reservationEmail) {
  await requests.updateRecordAsync(req.id, {
    "Request Status": sel("FAILED - INVALID EMAIL"),
    // keep these populated for consistent downstream emails/logging
    "Hold Token": holdToken,
    "Hold Expires At": holdExpires,
    "Confirmation Code": confirmCode,
  });
  return;
}

const attendeeAge = paidRec.getCellValue("Attendee Age");
const attendeeCode = paidRec.getCellValueAsString("Attendee Code").trim(); // Dancer/Teacher

// Determine group keyword for conflict filtering
let groupKey = null;
if (attendeeCode === "Dancer" && typeof attendeeAge === "number") {
  if (attendeeAge >= 9 && attendeeAge <= 11) groupKey = "Primary";
  else if (attendeeAge >= 12 && attendeeAge <= 14) groupKey = "Junior";
  else if (attendeeAge >= 15 && attendeeAge <= 21) groupKey = "Senior";
}

// ------------------ Load slot records ------------------
const slotQuery = await slots.selectRecordsAsync({
  fields: ["Status", "Start Time", "End Time", "Room", "Hold Token", "Hold Expires At", "Held By Email"],
});

function getSlotFromLink(linkObj) {
  if (!linkObj) return null;
  return slotQuery.getRecord(linkObj.id) || null;
}

const choice1 = (req.getCellValue("Slot Choice #1") || [])[0];
const choice2 = (req.getCellValue("Slot Choice #2") || [])[0];
const choice3 = (req.getCellValue("Slot Choice #3") || [])[0];
const rankedLinks = [choice1, choice2, choice3].filter(Boolean);

// ------------------ Load schedule for conflict rules (only if needed) ------------------
let scheduleRecs = [];
let endOfDivision = null;

if (groupKey) {
  const schedQuery = await sched.selectRecordsAsync({
    fields: ["Start Time", "End Time", "Location", "Category", "Event"],
  });
  scheduleRecs = schedQuery.records.map(r => ({
    start: r.getCellValue("Start Time"),
    end: r.getCellValue("End Time"),
    location: r.getCellValueAsString("Location"),
    category: r.getCellValueAsString("Category"),
    event: r.getCellValueAsString("Event"),
  })).filter(x => x.start && x.end);

  const relevant = scheduleRecs.filter(x =>
    (containsIgnoreCase(x.event, "competition") || containsIgnoreCase(x.event, "open stage")) &&
    containsIgnoreCase(x.category, groupKey)
  );

  if (relevant.length) {
    endOfDivision = new Date(Math.max(...relevant.map(x => new Date(x.end).getTime())));
  }
}

function isNonConflictingSlot(slotRec) {
  if (!groupKey) return true;

  const sStart = slotRec.getCellValue("Start Time");
  const sEnd = slotRec.getCellValue("End Time");
  if (!sStart || !sEnd) return false;

  const start = new Date(sStart);
  const end = new Date(sEnd);

  if (endOfDivision && start > endOfDivision) return false;

  for (const ev of scheduleRecs) {
    if (!(containsIgnoreCase(ev.event, "competition") || containsIgnoreCase(ev.event, "open stage"))) continue;
    if (!containsIgnoreCase(ev.category, groupKey)) continue;

    const evStart = new Date(ev.start);
    const evEnd = new Date(ev.end);
    if (overlaps(start, end, evStart, evEnd)) return false;
  }

  return true;
}

function isAvailable(slotRec) {
  return (slotRec.getCellValueAsString("Status") || "").trim() === "AVAILABLE";
}

function slotDurationMin(slotRec) {
  const s = slotRec.getCellValue("Start Time");
  const e = slotRec.getCellValue("End Time");
  if (!s || !e) return null;
  return minutesBetween(new Date(s), new Date(e));
}

// ------------------ Choose a slot to hold ------------------
let chosen = null;

// 1–3 ranked
for (const link of rankedLinks) {
  const sr = getSlotFromLink(link);
  if (sr && isAvailable(sr)) { chosen = sr; break; }
}

// 4–5 fallback
if (!chosen) {
  const allAvail = slotQuery.records.filter(r => isAvailable(r) && isNonConflictingSlot(r));
  const avail60 = allAvail.filter(r => slotDurationMin(r) === 60);
  const avail30 = allAvail.filter(r => slotDurationMin(r) === 30);
  chosen = avail60[0] || avail30[0] || null;
}

if (!chosen) {
  await requests.updateRecordAsync(req.id, {
    "Request Status": sel("NEEDS HELP"),
    "Hold Token": holdToken,
    "Hold Expires At": holdExpires,
    "Confirmation Code": confirmCode,
  });
  return;
}

// If chosen is 30, try to hold second 30
let second30 = null;
const chosenDur = slotDurationMin(chosen);

if (chosenDur === 30) {
  for (const link of rankedLinks) {
    const sr = getSlotFromLink(link);
    if (!sr || sr.id === chosen.id) continue;
    if (isAvailable(sr) && slotDurationMin(sr) === 30) {
      second30 = sr;
      break;
    }
  }
  if (!second30) {
    const allAvail30 = slotQuery.records
      .filter(r => isAvailable(r) && r.id !== chosen.id && slotDurationMin(r) === 30 && isNonConflictingSlot(r));
    second30 = allAvail30[0] || null;
  }
}

// ------------------ Apply hold(s) ------------------
const slotUpdates = [{
  id: chosen.id,
  fields: {
    "Status": sel("HELD"),
    "Held By Email": contactEmail,
    "Hold Token": holdToken,
    "Hold Expires At": holdExpires,
  }
}];

if (second30) {
  slotUpdates.push({
    id: second30.id,
    fields: {
      "Status": sel("HELD"),
      "Held By Email": contactEmail,
      "Hold Token": holdToken,
      "Hold Expires At": holdExpires,
    }
  });
}

await slots.updateRecordsAsync(slotUpdates);

// ------------------ Create provisional BOOKING ------------------
const heldLinks = [{ id: chosen.id }];
if (second30) heldLinks.push({ id: second30.id });

const bookingCreate = await bookings.createRecordsAsync([{
  fields: {
    "Booking Status": sel("AWAITING CONFIRMATION"),
    "Booking Request": [{ id: req.id }],
    "Pre-Paid Reservation": [{ id: paidRec.id }],
    "Slot(s)": heldLinks,
    "Confirmed?": false,
    "Hold Token": holdToken,
    "Hold Expires At": holdExpires,
    "Held Contact Email": contactEmail,
    "Confirmation Code": confirmCode,
  }
}]);

// ------------------ Update request record ------------------
await requests.updateRecordAsync(req.id, {
  "Request Status": sel("HOLD CREATED"),
  "Hold Token": holdToken,
  "Hold Expires At": holdExpires,
  "Confirmation Code": confirmCode,
  "Held Slot(s)": heldLinks,
});
