/**
 * RRS-3-Confirmations-v1.2.26
 * CONFIRMATIONS (new) -> Validate confirmation + confirm existing provisional BOOKING + book slot(s) + link PAID ROSTER
 *
 * BUG FIXES: Added support for CONFIRMATIONS linking to BOOKING REQUESTS (user selects their request). Script now matches booking primarily via the selected Booking Request, then validates Contact Email + Confirmation Code.
 *
 * BEHAVIOR:
 * - Triggered when a CONFIRMATIONS record is created.
 * - Reads {Contact Email} + {Confirmation Code} + linked {Booking Request} from CONFIRMATIONS.
 * - Finds the matching provisional booking in BOOKINGS by:
 *    - {Booking Status} == "AWAITING CONFIRMATION"
 *    - {Booking Request} == selected request
 * - Validates that:
 *    - Booking {Confirmation Code} matches submitted {Confirmation Code} (case-insensitive)
 *    - Booking {Held Contact Email} matches submitted {Contact Email} (case-insensitive)
 * - If booking not found OR code/email mismatch -> sets CONFIRMATIONS {Result} = "INVALID" and exits.
 * - If booking found but hold expired -> marks booking EXPIRED + stamps {Expired At}, sets CONFIRMATIONS {Result} = "EXPIRED", links CONFIRMATIONS {Booking}, and exits.
 * - If booking found and not expired, validates each linked slot:
 *    - Slot {Status} == "HELD"
 *    - Slot {Hold Token} == Booking {Hold Token}
 *    - Slot {Held By Email} == Booking {Held Contact Email} (case-insensitive)
 *   If any validation fails -> sets booking {Booking Status} = "NEEDS REVIEW", sets CONFIRMATIONS {Result} = "INVALID",
 *   links CONFIRMATIONS {Booking}, and exits.
 * - On success:
 *    - Updates booking: {Booking Status}="CONFIRMED", {Confirmed?}=true, {Confirmed At}=NOW()
 *    - Updates slot(s): {Status}="BOOKED" and clears hold fields (token/expires/email)
 *    - Updates PAID ROSTER linked via booking {Pre-Paid Reservation}: sets {Booking Confirmation} = this booking
 *    - Updates BOOKING REQUESTS linked via booking {Booking Request}: sets {BOOKINGS} = this booking
 *    - Updates CONFIRMATIONS: {Result}="VALID", links {Booking} = this booking, writes {Booking Summary}
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
    "Booking Request", // <-- NEW linked field to BOOKING REQUESTS
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

// -------------------- FIND MATCHING PROVISIONAL BOOKING (by selected request) --------------------
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

  // Secondary validation: code + email must match too
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

// Link confirmation to booking for audit (even if it later expires/invalidates)
await confirmations.updateRecordAsync(conf.id, {
  "Booking": [{ id: booking.id }],
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

const bHoldToken = (booking.getCellValueAsString("Hold Token") || "").trim();
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

// Update slot(s): BOOKED + clear hold fields
const slotUpdates = slotLinks.map(l => ({
  id: l.id,
  fields: {
    "Status": sel("BOOKED"),
    "Hold Token": "",
    "Hold Expires At": null,
    "Held By Email": "",
  },
}));
await slots.updateRecordsAsync(slotUpdates).catch(() => {});

// -------------------- LINK BACK TO PAID ROSTER --------------------
const paidLink = (booking.getCellValue("Pre-Paid Reservation") || [])[0];
if (paidLink) {
  await paid.updateRecordAsync(paidLink.id, {
    "Booking Confirmation": [{ id: booking.id }],
  }).catch(() => {});
}

// -------------------- LINK BACK TO BOOKING REQUESTS --------------------
const brLink = (booking.getCellValue("Booking Request") || [])[0];
if (brLink) {
  await requests.updateRecordAsync(brLink.id, {
    "BOOKINGS": [{ id: booking.id }],
  }).catch(() => {});
}

// -------------------- STAMP CONFIRMATION RESULT + SUMMARY --------------------
await confirmations.updateRecordAsync(conf.id, {
  "Result": sel("VALID"),
  "Booking": [{ id: booking.id }],
  "Booking Summary": bookingSummary,
}).catch(() => {});
