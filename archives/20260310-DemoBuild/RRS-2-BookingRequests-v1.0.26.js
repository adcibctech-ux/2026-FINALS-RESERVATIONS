/**
 * RRS-2-BookingRequests-v1.0.26
 * BOOKING REQUESTS (new) -> Hold best slot (ranked choices, else smart fallback) + generate confirmation code + update request
 *
 * BUG FIXES: N/A
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

const requests = base.getTable(REQ_TABLE);
const paid = base.getTable(PAID_TABLE);
const slots = base.getTable(SLOTS_TABLE);
const sched = base.getTable(SCHED_TABLE);

function sel(name) { return { name }; } // singleSelect-safe
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
const reservationEmail = (req.getCellValueAsString("Reservation Email") || "").trim();
if (!contactEmail) {
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
  fields: ["Attendee Age", "Attendee Code", "DCG Email", "Secondary Email", "Pre-Payment Email", "First Name", "Last Name", "Studio Name"],
});
const paidRec = paidQuery.getRecord(paidLink.id);
if (!paidRec) {
  await requests.updateRecordAsync(req.id, { "Request Status": sel("NEEDS HELP") });
  return;
}

const attendeeAge = paidRec.getCellValue("Attendee Age");
const attendeeCode = paidRec.getCellValueAsString("Attendee Code").trim(); // "Dancer" / "Teacher"

// Determine group keyword for conflict filtering
let groupKey = null; // "Primary" | "Junior" | "Senior"
if (attendeeCode === "Dancer" && typeof attendeeAge === "number") {
  if (attendeeAge >= 9 && attendeeAge <= 11) groupKey = "Primary";
  else if (attendeeAge >= 12 && attendeeAge <= 14) groupKey = "Junior";
  else if (attendeeAge >= 15 && attendeeAge <= 21) groupKey = "Senior";
}

// ------------------ Load slot records ------------------
const slotQuery = await slots.selectRecordsAsync({
  fields: ["Status", "Start Time", "End Time", "Room", "Hold Token", "Hold Expires At", "Held By Email"],
});

// Helper to get slot record by link
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

  // Find the latest end time of relevant competition/open stage blocks for their group
  const relevant = scheduleRecs.filter(x =>
    (containsIgnoreCase(x.event, "competition") || containsIgnoreCase(x.event, "open stage")) &&
    containsIgnoreCase(x.category, groupKey)
  );

  if (relevant.length) {
    endOfDivision = new Date(Math.max(...relevant.map(x => new Date(x.end).getTime())));
  }
}

function isNonConflictingSlot(slotRec) {
  if (!groupKey) return true; // Teachers or unknown age: do not filter

  const sStart = slotRec.getCellValue("Start Time");
  const sEnd = slotRec.getCellValue("End Time");
  if (!sStart || !sEnd) return false;

  const start = new Date(sStart);
  const end = new Date(sEnd);

  // Don’t suggest after division ends (your rule)
  if (endOfDivision && start > endOfDivision) return false;

  // Avoid overlaps with relevant competition/open stage events for their group in other locations
  for (const ev of scheduleRecs) {
    if (!(containsIgnoreCase(ev.event, "competition") || containsIgnoreCase(ev.event, "open stage"))) continue;
    if (!containsIgnoreCase(ev.category, groupKey)) continue;

    const evStart = new Date(ev.start);
    const evEnd = new Date(ev.end);
    if (overlaps(start, end, evStart, evEnd)) return false;
  }

  return true;
}

// ------------------ Choose a slot to hold ------------------
function isAvailable(slotRec) {
  return (slotRec.getCellValueAsString("Status") || "").trim() === "AVAILABLE";
}

function slotDurationMin(slotRec) {
  const s = slotRec.getCellValue("Start Time");
  const e = slotRec.getCellValue("End Time");
  if (!s || !e) return null;
  return minutesBetween(new Date(s), new Date(e));
}

// Step 1–3: ranked picks
let chosen = null;
for (const link of rankedLinks) {
  const sr = getSlotFromLink(link);
  if (sr && isAvailable(sr)) { chosen = sr; break; }
}

// Step 4–5: nonconflicting suggestions (60 then 30)
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

// If chosen is 30 min, try to hold a second 30 to total 60
let second30 = null;
const chosenDur = slotDurationMin(chosen);

if (chosenDur === 30) {
  // Try remaining ranked choices first (excluding chosen)
  for (const link of rankedLinks) {
    const sr = getSlotFromLink(link);
    if (!sr || sr.id === chosen.id) continue;
    if (isAvailable(sr) && slotDurationMin(sr) === 30) {
      second30 = sr;
      break;
    }
  }

  // If still none, fallback to a nonconflicting 30-min slot
  if (!second30) {
    const allAvail30 = slotQuery.records
      .filter(r => isAvailable(r) && r.id !== chosen.id && slotDurationMin(r) === 30 && isNonConflictingSlot(r));
    second30 = allAvail30[0] || null;
  }
}

// ------------------ Apply hold(s) ------------------
const slotUpdates = [];
slotUpdates.push({
  id: chosen.id,
  fields: {
    "Status": sel("HELD"),
    "Held By Email": contactEmail,
    "Hold Token": holdToken,
    "Hold Expires At": holdExpires,
  }
});

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

// Update request record
const heldLinks = [{ id: chosen.id }];
if (second30) heldLinks.push({ id: second30.id });

await requests.updateRecordAsync(req.id, {
  "Request Status": sel("HOLD CREATED"),
  "Hold Token": holdToken,
  "Hold Expires At": holdExpires,
  "Confirmation Code": confirmCode,
  "Held Slot(s)": heldLinks,
});
