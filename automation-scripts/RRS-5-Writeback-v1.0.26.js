/**
 * RRS-5-Writeback-v1.0.26
 * BOOKINGS (CONFIRMED) -> Write reservation details into MASTER SCHEDULE via Airtable API + stamp writeback fields + close request
 *
 * BUG FIXES: N/A
 *
 * BEHAVIOR:
 * - Runs in the 2026 FINALS RESERVATIONS base.
 * - Triggered when a BOOKINGS record matches:
 *    - {Booking Status} = "CONFIRMED"
 *    - {Master Writeback Completed?} is unchecked
 * - Uses the booking’s linked {Slot(s)} records to retrieve each slot’s {Master Record ID}.
 * - For each Master Record ID, PATCHes the MASTER SCHEDULE record in the 2026 FINALS base:
 *    - {Event} = Reservation Name
 *    - {Reservation Name} = Reservation Name
 *    - {Reservation Email} = Held Contact Email
 *    - {Reservation Booking ID} = Booking ID
 *    - {Reservation Status} = BOOKED
 *    - {Confirmed On} = Confirmed At
 *    - {Last Reservation Sync Note} = timestamp note
 * - On success:
 *    - BOOKINGS: sets {Master Writeback Completed?}=true, stamps {Master Writeback Timestamp}, writes {Writeback Notes}
 *    - BOOKING REQUESTS (linked): sets {Request Status} = "COMPLETE"
 */

const cfg = input.config();
const bookingRecordId = cfg.recordId;
const masterBaseId = cfg.masterBaseId;
const masterTableName = cfg.masterTableName; // "MASTER SCHEDULE"

// ✅ Secret (set in Automation UI)
const airtableToken = input.secret("RRS5_PAT");

// ---- TABLES (Reservations base) ----
const BOOKINGS_TABLE = "BOOKINGS";
const SLOTS_TABLE = "SLOTS (Operational)";
const REQUESTS_TABLE = "BOOKING REQUESTS";

const bookings = base.getTable(BOOKINGS_TABLE);
const slots = base.getTable(SLOTS_TABLE);
const requests = base.getTable(REQUESTS_TABLE);

function sel(name) { return { name }; }

if (!bookingRecordId) throw new Error('Missing input "recordId".');
if (!masterBaseId) throw new Error('Missing input "masterBaseId" (should look like appXXXXXXXXXXXXXX).');
if (!masterTableName) throw new Error('Missing input "masterTableName" (should be "MASTER SCHEDULE").');
if (!airtableToken) throw new Error('Missing secret RRS5_PAT. Add it in the Automation "Secrets" UI.');

// ---- Load booking ----
const bookingQuery = await bookings.selectRecordsAsync({
  fields: [
    "Booking Status",
    "Master Writeback Completed?",
    "Master Writeback Timestamp",
    "Writeback Notes",
    "Booking ID",
    "Reservation Name",
    "Held Contact Email",
    "Confirmed At",
    "Slot(s)",
    "Booking Request",
  ],
});
const b = bookingQuery.getRecord(bookingRecordId);
if (!b) throw new Error(`BOOKINGS record not found: ${bookingRecordId}`);

const bookingStatus = (b.getCellValueAsString("Booking Status") || "").trim();
const wbDone = b.getCellValue("Master Writeback Completed?");
if (bookingStatus !== "CONFIRMED" || wbDone) return;

const bookingId = (b.getCellValueAsString("Booking ID") || "").trim();
const reservationName = (b.getCellValueAsString("Reservation Name") || "").trim();
const contactEmail = (b.getCellValueAsString("Held Contact Email") || "").trim();
const confirmedAtVal = b.getCellValue("Confirmed At");
const confirmedAt = confirmedAtVal ? new Date(confirmedAtVal) : null;

const slotLinks = b.getCellValue("Slot(s)") || [];
const reqLink = (b.getCellValue("Booking Request") || [])[0];

if (!bookingId || !reservationName || !contactEmail || !confirmedAt || slotLinks.length === 0) {
  throw new Error(`Missing required booking data for writeback (Booking ${bookingRecordId}).`);
}

// ---- Load slots for Master Record IDs ----
const slotQuery = await slots.selectRecordsAsync({
  fields: ["Master Record ID"],
});

const masterRecordIds = [];
for (const l of slotLinks) {
  const s = slotQuery.getRecord(l.id);
  if (!s) continue;

  const mrid = (s.getCellValueAsString("Master Record ID") || "").trim();
  if (mrid) masterRecordIds.push(mrid);
}

if (masterRecordIds.length === 0) {
  throw new Error(`No Master Record IDs found on linked slots for Booking ${bookingId}. Check your lookup wiring.`);
}

// ---- Airtable API PATCH helper ----
async function patchMasterRecord(recordId, fields) {
  const url = `https://api.airtable.com/v0/${masterBaseId}/${encodeURIComponent(masterTableName)}/${recordId}`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${airtableToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Master PATCH failed for ${recordId}: ${res.status} ${res.statusText} | ${text}`);
  }
}

// ---- Writeback payload ----
const now = new Date();
const noteBase = `Writeback OK — Booking ${bookingId} (${reservationName}) at ${now.toISOString()}`;

const masterFields = {
  "Event": reservationName,
  "Reservation Name": reservationName,
  "Reservation Email": contactEmail,
  "Reservation Booking ID": bookingId,
  "Reservation Status": "BOOKED",
  "Confirmed On": confirmedAt,
  "Last Reservation Sync Note": noteBase,
};

// ---- PATCH each master record ----
for (const mrid of masterRecordIds) {
  await patchMasterRecord(mrid, masterFields);
}

// ---- Stamp writeback completion on BOOKINGS ----
await bookings.updateRecordAsync(b.id, {
  "Master Writeback Completed?": true,
  "Master Writeback Timestamp": now,
  "Writeback Notes": `${noteBase} | MasterRecordIDs: ${masterRecordIds.join(" , ")}`,
});

// ---- Close linked request ----
if (reqLink) {
  await requests.updateRecordAsync(reqLink.id, {
    "Request Status": sel("COMPLETE"),
  });
}
