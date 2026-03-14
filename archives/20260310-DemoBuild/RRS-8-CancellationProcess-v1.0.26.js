/**
 * RRS-8-CancellationProcess-v1.0.26
 * CANCELLATION REQUESTS (button) -> If APPROVED, cancel booking + release slots + revert MASTER SCHEDULE to AVAILABLE RESERVATION
 *
 * BUG FIXES: N/A
 *
 * BEHAVIOR:
 * - Triggered by button click on a CANCELLATION REQUESTS record.
 * - Validates {Cancellation Status} == "APPROVED". If not, exits without changes.
 * - Loads linked {Booking} (required) and its linked slot(s).
 * - Updates SLOTS (Operational):
 *    - {Status} -> "AVAILABLE"
 *    - Clears {Hold Token}, {Hold Expires At}, {Held By Email}
 *    - Clears {Booking} link
 * - Reverts corresponding MASTER SCHEDULE records via Airtable API (using each slot’s {Master Record ID} lookup):
 *    - {Event} = "AVAILABLE RESERVATION"
 *    - clears {Reservation Name}, {Reservation Email}, {Reservation Booking ID}
 *    - {Reservation Status} = "AVAILABLE"
 *    - clears {Confirmed On}
 *    - updates {Last Reservation Sync Note}
 * - Clears PAID ROSTER {Booking Confirmation} link (reopens eligibility).
 * - Updates BOOKING:
 *    - Sets {Booking Status}="CANCELLED"
 * - Updates CANCELLATION REQUEST:
 *    - {Cancellation Status}="CANCELLED IN SYSTEM"
 *    - Writes a detailed audit trail to {System Notes}
 */

const cfg = input.config();
const cancelRecordId = cfg.recordId;
const masterBaseId = cfg.masterBaseId;
const masterTableName = cfg.masterTableName; // "MASTER SCHEDULE"
const pat = input.secret("RRS5_PAT");

if (!cancelRecordId) throw new Error('Missing input "recordId".');
if (!masterBaseId) throw new Error('Missing input "masterBaseId" (app...).');
if (!masterTableName) throw new Error('Missing input "masterTableName" (MASTER SCHEDULE).');
if (!pat) throw new Error('Missing secret RRS5_PAT.');

const CANCELS_TABLE = "CANCELLATION REQUESTS";
const BOOKINGS_TABLE = "BOOKINGS";
const SLOTS_TABLE = "SLOTS (Operational)";
const PAID_TABLE = "PAID ROSTER";

const cancels = base.getTable(CANCELS_TABLE);
const bookings = base.getTable(BOOKINGS_TABLE);
const slots = base.getTable(SLOTS_TABLE);
const paid = base.getTable(PAID_TABLE);

function sel(name) { return { name }; }

async function batchUpdate(table, records) {
  const CHUNK = 50;
  for (let i = 0; i < records.length; i += CHUNK) {
    await table.updateRecordsAsync(records.slice(i, i + CHUNK));
  }
}

async function patchMasterRecord(recordId, fields) {
  const url = `https://api.airtable.com/v0/${masterBaseId}/${encodeURIComponent(masterTableName)}/${recordId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${pat}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Master PATCH failed for ${recordId}: ${res.status} ${res.statusText} | ${text}`);
  }
}

// ---- Load cancellation request ----
const cancelQuery = await cancels.selectRecordsAsync({
  fields: ["Cancellation Status", "Booking", "Pre-Paid Reservation", "Contact Email", "System Notes"],
});
const cr = cancelQuery.getRecord(cancelRecordId);
if (!cr) throw new Error(`CANCELLATION REQUESTS record not found: ${cancelRecordId}`);

const status = (cr.getCellValueAsString("Cancellation Status") || "").trim();
if (status !== "APPROVED") {
  console.log(`RRS-8: Cancellation not APPROVED (status=${status}). No action taken.`);
  return;
}

const bookingLink = (cr.getCellValue("Booking") || [])[0];
const paidLink = (cr.getCellValue("Pre-Paid Reservation") || [])[0];
const cancelContactEmail = (cr.getCellValueAsString("Contact Email") || "").trim();

if (!bookingLink) throw new Error("Cancellation request is missing linked {Booking}.");

// ---- Load booking ----
const bookingQuery = await bookings.selectRecordsAsync({
  fields: ["Booking Status", "Slot(s)", "Pre-Paid Reservation", "Booking ID", "Reservation Name"],
});
const b = bookingQuery.getRecord(bookingLink.id);
if (!b) throw new Error(`BOOKINGS record not found: ${bookingLink.id}`);

const bookingId = (b.getCellValueAsString("Booking ID") || "").trim();
const reservationName = (b.getCellValueAsString("Reservation Name") || "").trim();

const slotLinks = b.getCellValue("Slot(s)") || [];
if (slotLinks.length === 0) throw new Error("Linked booking has no {Slot(s)}.");

// Use booking's paid roster link if cancellation didn't provide it
const bookingPaidLink = (b.getCellValue("Pre-Paid Reservation") || [])[0];
const paidRecId = (paidLink?.id) || (bookingPaidLink?.id) || null;

// ---- Load slots (need master record IDs) ----
const slotQuery = await slots.selectRecordsAsync({
  fields: ["Status", "Hold Token", "Hold Expires At", "Held By Email", "Booking", "Master Record ID"],
});

const slotUpdates = [];
const masterIds = [];
const releasedSlotIds = [];

for (const l of slotLinks) {
  const s = slotQuery.getRecord(l.id);
  if (!s) continue;

  const mrid = (s.getCellValueAsString("Master Record ID") || "").trim();
  if (mrid) masterIds.push(mrid);

  releasedSlotIds.push(s.id);

  slotUpdates.push({
    id: s.id,
    fields: {
      "Status": sel("AVAILABLE"),
      "Hold Token": "",
      "Hold Expires At": null,
      "Held By Email": "",
      "Booking": [], // clear link
    }
  });
}

if (slotUpdates.length) await batchUpdate(slots, slotUpdates);

// ---- Revert master schedule records ----
const now = new Date();
const revertFields = {
  "Event": "AVAILABLE RESERVATION",
  "Reservation Name": "",
  "Reservation Email": "",
  "Reservation Booking ID": "",
  "Reservation Status": "AVAILABLE",
  "Confirmed On": null,
  "Last Reservation Sync Note": `Reverted to AVAILABLE RESERVATION via cancellation at ${now.toISOString()} (Booking ${bookingId || "UNKNOWN"})`,
};

for (const mrid of masterIds) {
  await patchMasterRecord(mrid, revertFields);
}

// ---- Clear PAID ROSTER Booking Confirmation (reopens eligibility) ----
let paidCleared = false;
if (paidRecId) {
  try {
    paid.getField("Booking Confirmation");
    await paid.updateRecordAsync(paidRecId, { "Booking Confirmation": [] });
    paidCleared = true;
  } catch (e) {
    console.log("RRS-8: PAID ROSTER field 'Booking Confirmation' not found; skipping clear.");
  }
}

// ---- Update booking status to CANCELLED ----
await bookings.updateRecordAsync(b.id, { "Booking Status": sel("CANCELLED") }).catch(() => {});

// ---- Write System Notes + mark cancellation complete ----
const existingNotes = (cr.getCellValueAsString("System Notes") || "").trim();
const auditLines = [
  `Processed at: ${now.toISOString()}`,
  `Cancellation Contact Email: ${cancelContactEmail || "N/A"}`,
  `Booking ID: ${bookingId || "N/A"}`,
  `Reservation Name: ${reservationName || "N/A"}`,
  `Released Slot IDs: ${releasedSlotIds.join(" , ") || "N/A"}`,
  `Reverted Master Record IDs: ${masterIds.join(" , ") || "N/A"}`,
  `Cleared PAID ROSTER Booking Confirmation: ${paidCleared ? "YES" : "NO/NOT FOUND"}`,
  `Set Booking Status to CANCELLED: YES`,
];

await cancels.updateRecordAsync(cr.id, {
  "Cancellation Status": sel("CANCELLED IN SYSTEM"),
  "System Notes": existingNotes
    ? `${existingNotes}\n\n---\n${auditLines.join("\n")}`
    : auditLines.join("\n"),
});

console.log(`RRS-8: Cancellation processed. Released ${slotUpdates.length} slot(s); reverted ${masterIds.length} master record(s).`);
