/**
 * RRS-3-Confirmations-v1.1.26
 * CONFIRMATIONS (new) -> Validate confirmation + confirm existing provisional BOOKING + book slot(s) + link PAID ROSTER
 *
 * BUG FIXES: Write plain-English {Booking Summary} into CONFIRMATIONS based on booked slot(s) (Room // Date // Start (EST) // End (EST)).
 *
 * BEHAVIOR:
 * - Triggered when a CONFIRMATIONS record is created.
 * - Reads {Contact Email} + {Confirmation Code}.
 * - Finds matching provisional booking in BOOKINGS (AWAITING CONFIRMATION) by {Confirmation Code}+{Held Contact Email}.
 * - Sets CONFIRMATIONS {Result}:
 *    - INVALID: no match or slot validation fails
 *    - EXPIRED: hold expired
 *    - VALID: booking confirmed + slots booked
 * - On VALID:
 *    - BOOKING => CONFIRMED, stamps {Confirmed?} + {Confirmed At}
 *    - SLOTS => BOOKED + clears hold fields
 *    - PAID ROSTER => sets {Booking Confirmation} link to booking
 *    - BOOKING REQUESTS => sets {BOOKINGS} link to booking
 *    - CONFIRMATIONS => links {Booking} and writes {Booking Summary}
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

function sel(name) {
  return { name }; // singleSelect-safe in automations
}
function normEmail(v) {
  return (v || "").trim().toLowerCase();
}
function normCode(v) {
  return (v || "").trim().toUpperCase();
}

// Formatters (EST)
const TZ = "America/New_York";
function fmtDateYYYYMMDD(dateVal) {
  const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function fmtTimeAMPM(dateVal) {
  const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
  // Example output: "4:00 PM"
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
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
  fields: ["Contact Email", "Confirmation Code", "Result", "Booking", "Booking Summary"],
});
const conf = confQuery.getRecord(confirmationRecordId);
if (!conf) throw new Error(`CONFIRMATIONS record not found: ${confirmationRecordId}`);

const contactEmail = normEmail(conf.getCellValueAsString("Contact Email"));
const code = normCode(conf.getCellValueAsString("Confirmation Code"));

if (!contactEmail || !code) {
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
const reqLink = (booking.getCellValue("Booking Request") || [])[0];
if (reqLink) {
  await requests.updateRecordAsync(reqLink.id, {
    "BOOKINGS": [{ id: booking.id }],
  }).catch(() => {});
}

// -------------------- STAMP CONFIRMATION RESULT + SUMMARY --------------------
await confirmations.updateRecordAsync(conf.id, {
  "Result": sel("VALID"),
  "Booking": [{ id: booking.id }],
  "Booking Summary": bookingSummary,
}).catch(() => {});
