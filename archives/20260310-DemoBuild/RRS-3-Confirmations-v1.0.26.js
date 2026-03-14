/**
 * RRS-3-Confirmations-v1.0.26
 * CONFIRMATIONS (new) -> Validate confirmation + confirm existing provisional BOOKING + book slot(s) + link PAID ROSTER
 *
 * BUG FIXES: N/A
 *
 * BEHAVIOR:
 * - Triggered when a CONFIRMATIONS record is created.
 * - Reads {Contact Email} + {Confirmation Code} from the confirmation submission.
 * - Finds a matching provisional booking in BOOKINGS where:
 *    - {Booking Status} == "AWAITING CONFIRMATION"
 *    - {Confirmation Code} matches (case-insensitive)
 *    - {Held Contact Email} matches {Contact Email} (case-insensitive)
 * - If no matching booking is found -> sets CONFIRMATIONS {Result} = "INVALID" and exits.
 * - If matching booking is found but {Hold Expires At} is in the past -> marks booking EXPIRED + stamps {Expired At},
 *   sets CONFIRMATIONS {Result} = "EXPIRED", links CONFIRMATIONS {Booking} to the booking, and exits.
 * - If matching booking is found and not expired, validates each linked slot:
 *    - Slot {Status} == "HELD"
 *    - Slot {Hold Token} == Booking {Hold Token}
 *    - Slot {Held By Email} == Booking {Held Contact Email} (case-insensitive)
 *   If any validation fails -> sets booking {Booking Status} = "NEEDS REVIEW", sets CONFIRMATIONS {Result} = "INVALID",
 *   links CONFIRMATIONS {Booking}, and exits.
 * - On success:
 *    - Updates booking: {Booking Status}="CONFIRMED", {Confirmed?}=true, {Confirmed At}=NOW()
 *    - Updates slot(s): {Status}="BOOKED" and clears hold fields (token/expires/email)
 *    - Updates PAID ROSTER linked via booking {Pre-Paid Reservation}: sets {Booking Confirmation} = this booking
 *    - Updates BOOKING REQUESTS linked via booking {Booking Request}: links {BOOKINGS} = this booking
 *    - Updates CONFIRMATIONS: {Result}="VALID" and links {Booking} = this booking
 */

// -------------------- CONFIG --------------------
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

// -------------------- LOAD CONFIRMATION --------------------
const confQuery = await confirmations.selectRecordsAsync({
  fields: ["Contact Email", "Confirmation Code", "Result", "Booking"],
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

// Link confirmation to booking for audit
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

// -------------------- SLOT VALIDATION --------------------
const slotLinks = booking.getCellValue("Slot(s)") || [];
if (!slotLinks.length) {
  await bookings.updateRecordAsync(booking.id, { "Booking Status": sel("NEEDS REVIEW") }).catch(() => {});
  await confirmations.updateRecordAsync(conf.id, { "Result": sel("INVALID") }).catch(() => {});
  return;
}

const bHoldToken = (booking.getCellValueAsString("Hold Token") || "").trim();
const bHeldEmail = normEmail(booking.getCellValueAsString("Held Contact Email"));

const slotQuery = await slots.selectRecordsAsync({
  fields: ["Status", "Hold Token", "Hold Expires At", "Held By Email"],
});

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
}

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

// -------------------- STAMP CONFIRMATION RESULT --------------------
await confirmations.updateRecordAsync(conf.id, {
  "Result": sel("VALID"),
  "Booking": [{ id: booking.id }],
}).catch(() => {});
