/**
 * RRS-3-Confirmations-v1.3.26
 * CONFIRMATIONS (new) -> Validate confirmation + confirm existing provisional BOOKING + book slot(s) + link PAID ROSTER
 *
 * BUG FIXES:
 * 1) Map BOOKINGS {Hold Token} into CONFIRMATIONS {Hold Token} upon successful match/processing.
 * 2) When confirmation is VALID and slots are booked, set BOOKING REQUESTS {Request Status} = "CONFIRMED".
 * 3) When slot(s) are flipped to BOOKED, also link SLOTS (Operational) → {PAID ROSTER} to the booking’s {Pre-Paid Reservation}.
 *
 * BEHAVIOR:
 * - Triggered when a CONFIRMATIONS record is created.
 * - Reads {Contact Email} + {Confirmation Code} + linked {Booking Request}.
 * - Finds the matching provisional booking in BOOKINGS by:
 *    - {Booking Status} == "AWAITING CONFIRMATION"
 *    - {Booking Request} == selected request
 *    - {Confirmation Code} + {Held Contact Email} match the submission (case-insensitive)
 * - Sets CONFIRMATIONS {Result}:
 *    - INVALID: no match OR slot validation fails
 *    - EXPIRED: hold expired
 *    - VALID: booking confirmed + slots booked
 * - On success:
 *    - BOOKINGS => {Booking Status}="CONFIRMED", {Confirmed?}=true, {Confirmed At}=NOW()
 *    - SLOTS => {Status}="BOOKED" + clears hold fields + links {PAID ROSTER}
 *    - PAID ROSTER => {Booking Confirmation} link to booking
 *    - BOOKING REQUESTS => {BOOKINGS} link to booking + {Request Status}="CONFIRMED"
 *    - CONFIRMATIONS => links {Booking}, writes {Booking Summary}, writes {Hold Token}, sets {Result}="VALID"
 */

const cfg = input.config();
const confirmationRecordId = cfg.recordId;

const CONF_TABLE = "CONFIRMATIONS";
const BOOKINGS_TABLE = "BOOKINGS";
const SLOTS_TABLE = "SLOTS (Operational)";
const PAID_TABLE = "PAID ROSTER";
const REQ_TABLE = "BOOKING REQUESTS";

const confirmations = base.getTable(CONF_TABLE);
const bookings = base.getTable(BOOKINGS_TABLE);
const slots = base.getTable(SLOTS_TABLE);
const paid = base.getTable(PAID_TABLE);
const requests = base.getTable(REQ_TABLE);

function sel(name) { return { name }; }
function normEmail(v) { return (v || "").trim().toLowerCase(); }
function normCode(v) { return (v || "").trim().toUpperCase(); }

// ---------- Helpers for safe field writes ----------
function hasField(table, fieldName) {
  try { table.getField(fieldName); return true; } catch { return false; }
}

// Change this if your slot link field is named differently.
// Script will try this first, then fall back to a couple common alternatives.
const SLOT_PAID_LINK_FIELD_CANDIDATES = ["PAID ROSTER", "Pre-Paid Reservation", "Paid Roster"];

// Formatters (EST)
const TZ = "America/New_York";
function fmtDateYYYYMMDD(dateVal) {
  const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function fmtTimeAMPM(dateVal) {
  const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true,
  }).format(d);
}
function buildSlotLine(roomStr, startVal, endVal) {
  const dateStr = fmtDateYYYYMMDD(startVal);
  const startStr = `${fmtTimeAMPM(startVal)} (EST)`;
  const endStr = `${fmtTimeAMPM(endVal)} (EST)`;
  return `${roomStr} // ${dateStr} // ${startStr} // ${endStr}`;
}

// -------------------- LOAD CONFIRMATION --------------------
const confQuery = await confirmations.selectRecordsAsync({
  fields: [
    "Contact Email",
    "Confirmation Code",
    "Result",
    "Booking",
    "Booking Summary",
    "Booking Request",
    "Hold Token",
  ],
});
const conf = confQuery.getRecord(confirmationRecordId);
if (!conf) throw new Error(`CONFIRMATIONS record not found: ${confirmationRecordId}`);

const contactEmail = normEmail(conf.getCellValueAsString("Contact Email"));
const code = normCode(conf.getCellValueAsString("Confirmation Code"));
const reqLink = (conf.getCellValue("Booking Request") || [])[0];

if (!contactEmail || !code || !reqLink) {
  await confirmations.updateRecordAsync(conf.id, { "Result": sel("INVALID") }).catch(() => {});
  return;
}

// -------------------- FIND MATCHING PROVISIONAL BOOKING --------------------
const bookingQuery = await bookings.selectRecordsAsync({
  fields: [
    "Booking Status",
    "Confirmation Code",
    "Held Contact Email",
    "Hold Expires At",
    "Hold Token",
    "Slot(s)",
    "Pre-Paid Reservation",
    "Booking Request",
    "Confirmed?",
    "Confirmed At",
  ],
});

let booking = null;

for (const b of bookingQuery.records) {
  const status = (b.getCellValueAsString("Booking Status") || "").trim();
  if (status !== "AWAITING CONFIRMATION") continue;

  const br = (b.getCellValue("Booking Request") || [])[0];
  if (!br || br.id !== reqLink.id) continue;

  const bCode = normCode(b.getCellValueAsString("Confirmation Code"));
  const bEmail = normEmail(b.getCellValueAsString("Held Contact Email"));

  if (bCode === code && bEmail === contactEmail) {
    booking = b;
    break;
  }
}

if (!booking) {
  await confirmations.updateRecordAsync(conf.id, { "Result": sel("INVALID") }).catch(() => {});
  return;
}

const bHoldToken = (booking.getCellValueAsString("Hold Token") || "").trim();

// Link confirmation to booking for audit and carry hold token
await confirmations.updateRecordAsync(conf.id, {
  "Booking": [{ id: booking.id }],
  "Hold Token": bHoldToken,
}).catch(() => {});

// -------------------- EXPIRE CHECK --------------------
const expiresVal = booking.getCellValue("Hold Expires At");
const expiresAt = expiresVal ? new Date(expiresVal) : null;
const now = new Date();

if (!expiresAt || now > expiresAt) {
  await bookings.updateRecordAsync(booking.id, {
    "Booking Status": sel("EXPIRED"),
    "Expired At": now,
  }).catch(() => {});

  await confirmations.updateRecordAsync(conf.id, {
    "Result": sel("EXPIRED"),
    "Hold Token": bHoldToken,
  }).catch(() => {});
  return;
}

// -------------------- SLOT VALIDATION + SUMMARY BUILD --------------------
const slotLinks = booking.getCellValue("Slot(s)") || [];
if (!slotLinks.length) {
  await bookings.updateRecordAsync(booking.id, { "Booking Status": sel("NEEDS REVIEW") }).catch(() => {});
  await confirmations.updateRecordAsync(conf.id, { "Result": sel("INVALID") }).catch(() => {});
  return;
}

const bHeldEmail = normEmail(booking.getCellValueAsString("Held Contact Email"));

const slotQuery = await slots.selectRecordsAsync({
  fields: ["Status", "Hold Token", "Hold Expires At", "Held By Email", "Start Time", "End Time", "Room"],
});

const summaryLines = [];

for (const l of slotLinks) {
  const s = slotQuery.getRecord(l.id);
  if (!s) {
    await bookings.updateRecordAsync(booking.id, { "Booking Status": sel("NEEDS REVIEW") }).catch(() => {});
    await confirmations.updateRecordAsync(conf.id, { "Result": sel("INVALID") }).catch(() => {});
    return;
  }

  const sStatus = (s.getCellValueAsString("Status") || "").trim();
  const sToken = (s.getCellValueAsString("Hold Token") || "").trim();
  const sEmail = normEmail(s.getCellValueAsString("Held By Email"));

  if (sStatus !== "HELD" || sToken !== bHoldToken || (bHeldEmail && sEmail !== bHeldEmail)) {
    await bookings.updateRecordAsync(booking.id, { "Booking Status": sel("NEEDS REVIEW") }).catch(() => {});
    await confirmations.updateRecordAsync(conf.id, { "Result": sel("INVALID") }).catch(() => {});
    return;
  }

  const startVal = s.getCellValue("Start Time");
  const endVal = s.getCellValue("End Time");
  const roomStr = (s.getCellValueAsString("Room") || "").trim() || "ROOM";

  if (!startVal || !endVal) {
    await bookings.updateRecordAsync(booking.id, { "Booking Status": sel("NEEDS REVIEW") }).catch(() => {});
    await confirmations.updateRecordAsync(conf.id, { "Result": sel("INVALID") }).catch(() => {});
    return;
  }

  summaryLines.push(buildSlotLine(roomStr, startVal, endVal));
}

const bookingSummary = summaryLines.join("\n");

// -------------------- CONFIRM BOOKING --------------------
await bookings.updateRecordAsync(booking.id, {
  "Booking Status": sel("CONFIRMED"),
  "Confirmed?": true,
  "Confirmed At": now,
}).catch(() => {});

// -------------------- Update slot(s): BOOKED + clear hold + link PAID ROSTER --------------------
const paidLink = (booking.getCellValue("Pre-Paid Reservation") || [])[0];
const paidId = paidLink ? paidLink.id : null;

// pick the first existing candidate field name on SLOTS
let slotPaidFieldName = null;
for (const candidate of SLOT_PAID_LINK_FIELD_CANDIDATES) {
  if (hasField(slots, candidate)) { slotPaidFieldName = candidate; break; }
}

const slotUpdates = slotLinks.map(l => {
  const fields = {
    "Status": sel("BOOKED"),
    "Hold Token": "",
    "Hold Expires At": null,
    "Held By Email": "",
  };

  // BUG FIX #3: link PAID ROSTER onto the slot if possible
  if (paidId && slotPaidFieldName) {
    fields[slotPaidFieldName] = [{ id: paidId }];
  }

  return { id: l.id, fields };
});

await slots.updateRecordsAsync(slotUpdates).catch(() => {});

// -------------------- LINK BACK TO PAID ROSTER --------------------
if (paidId) {
  await paid.updateRecordAsync(paidId, {
    "Booking Confirmation": [{ id: booking.id }],
  }).catch(() => {});
}

// -------------------- LINK BACK TO BOOKING REQUESTS + SET REQUEST STATUS CONFIRMED --------------------
const brLink = (booking.getCellValue("Booking Request") || [])[0];
if (brLink) {
  await requests.updateRecordAsync(brLink.id, {
    "BOOKINGS": [{ id: booking.id }],
    "Request Status": sel("CONFIRMED"),
  }).catch(() => {});
}

// -------------------- STAMP CONFIRMATION RESULT + SUMMARY + HOLD TOKEN --------------------
await confirmations.updateRecordAsync(conf.id, {
  "Result": sel("VALID"),
  "Booking": [{ id: booking.id }],
  "Booking Summary": bookingSummary,
  "Hold Token": bHoldToken,
}).catch(() => {});
