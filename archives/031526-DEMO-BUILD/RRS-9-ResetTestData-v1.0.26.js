/**
 * RRS-9-ResetTestData-v1.0.26
 * Bulk reset script-generated/client data for launch without deleting schedule inventory or roster data.
 *
 * BUG FIXES:
 * N/A (first release)
 *
 * BEHAVIOR:
 * - Deletes all records in:
 *    - BOOKING REQUESTS
 *    - BOOKINGS
 *    - CONFIRMATIONS
 *    - REFUND REQUESTS
 *    - CANCELLATION REQUESTS
 * - Resets SLOTS (Operational):
 *    - Deletes slots where {Status} == "VOIDED"
 *    - For remaining slots:
 *        - Status -> AVAILABLE (except BLOCKED; leaves BLOCKED unchanged)
 *        - Clears hold fields + Booking link + Pre-Paid Reservation link (if present)
 * - Resets PAID ROSTER:
 *    - Clears Booked Slot(s) link
 *    - Clears Booking Confirmation link
 * - Reverts Master Schedule (cross-base) for any Master Record IDs present in remaining SLOTS (Operational):
 *    - Event -> "AVAILABLE RESERVATION"
 *    - Reservation Status -> "AVAILABLE"
 *    - Clears reservation metadata fields
 *    - Clears Confirmed On
 *    - Writes Last Reservation Sync Note
 * - Also deletes VOIDED slots in SLOTS (Operational) (to remove stale/obsolete slots created by schedule changes).
 *
 * SAFETY:
 * - Prompts before running destructive actions.
 * - Skips missing fields gracefully.
 * - Uses batch operations (50 records).
 */

const SETTINGS_TABLE = "RRS SETTINGS";

const TABLES_TO_DELETE = [
  "CONFIRMATIONS",
  "CANCELLATION REQUESTS",
  "REFUND REQUESTS",
  "BOOKINGS",
  "BOOKING REQUESTS",
];

const SLOTS_TABLE = "SLOTS (Operational)";
const PAID_TABLE = "PAID ROSTER";

// ---- helpers ----
function getTableIfExists(name) {
  try { return base.getTable(name); } catch { return null; }
}
function hasField(table, fieldName) {
  try { table.getField(fieldName); return true; } catch { return false; }
}
async function chunkedDelete(table, recordIds) {
  const CHUNK = 50;
  for (let i = 0; i < recordIds.length; i += CHUNK) {
    await table.deleteRecordsAsync(recordIds.slice(i, i + CHUNK));
  }
}
async function chunkedUpdate(table, updates) {
  const CHUNK = 50;
  for (let i = 0; i < updates.length; i += CHUNK) {
    await table.updateRecordsAsync(updates.slice(i, i + CHUNK));
  }
}
function sel(name) { return { name }; }

async function loadConfigFromSettings() {
  const t = getTableIfExists(SETTINGS_TABLE);
  if (!t) throw new Error(`Missing table: ${SETTINGS_TABLE}`);
  const q = await t.selectRecordsAsync();
  const rec = q.records[0];
  if (!rec) throw new Error(`RRS SETTINGS is empty. Add one record.`);

  const masterBaseId = (rec.getCellValueAsString("Master Base ID") || "").trim();
  const masterTableName = (rec.getCellValueAsString("Master Table Name") || "").trim();
  const pat = (rec.getCellValueAsString("RRS5_PAT") || "").trim();

  if (!masterBaseId || !masterTableName || !pat) {
    throw new Error(`RRS SETTINGS missing values. Fill {Master Base ID}, {Master Table Name}, {RRS5_PAT}.`);
  }
  return { masterBaseId, masterTableName, pat };
}

async function patchMasterRecord(masterBaseId, masterTableName, pat, recordId, fields) {
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

// ---- confirm ----
const choice = await input.buttonsAsync(
  "RESET TEST DATA (DESTRUCTIVE): Deletes all request/booking/confirmation/credit/cancellation records, resets slots + paid roster, reverts master schedule, AND deletes VOIDED operational slots. Continue?",
  [
    { label: "Cancel", value: "cancel" },
    { label: "Yes — Reset Everything", value: "go", variant: "danger" },
  ]
);

if (choice === "cancel") {
  output.markdown("✅ Cancelled. No changes made.");
  return;
}

// ---- load API config ----
const { masterBaseId, masterTableName, pat } = await loadConfigFromSettings();

// -------------------- 1) Delete transactional tables --------------------
output.markdown("### Step 1/5 — Deleting transactional records…");

for (const name of TABLES_TO_DELETE) {
  const t = getTableIfExists(name);
  if (!t) {
    output.markdown(`- Skipping missing table: **${name}**`);
    continue;
  }
  const q = await t.selectRecordsAsync();
  const ids = q.records.map(r => r.id);
  if (ids.length === 0) {
    output.markdown(`- ${name}: nothing to delete`);
    continue;
  }
  await chunkedDelete(t, ids);
  output.markdown(`- ${name}: deleted **${ids.length}** record(s)`);
}

// -------------------- 2) Delete VOIDED operational slots --------------------
output.markdown("### Step 2/5 — Deleting VOIDED slots in SLOTS (Operational)…");

const slotsTable = getTableIfExists(SLOTS_TABLE);
if (!slotsTable) throw new Error(`Missing table: ${SLOTS_TABLE}`);

const slotFieldsToRead = [
  "Status",
  "Master Record ID",
  "Hold Token",
  "Hold Expires At",
  "Held By Email",
  "Hold Created",
  "Booking",
  "Pre-Paid Reservation",
  "Review Notes",
];

const slotQueryAll = await slotsTable.selectRecordsAsync({
  fields: slotFieldsToRead.filter(f => hasField(slotsTable, f)),
});

const voidedIds = [];
for (const r of slotQueryAll.records) {
  const status = (r.getCellValueAsString("Status") || "").trim();
  if (status === "VOIDED") voidedIds.push(r.id);
}

if (voidedIds.length) {
  await chunkedDelete(slotsTable, voidedIds);
}
output.markdown(`- Deleted **${voidedIds.length}** VOIDED slot(s)`);

// -------------------- 3) Reset remaining operational slots --------------------
output.markdown("### Step 3/5 — Resetting remaining SLOTS (Operational)…");

// Re-query after deletions
const slotQuery = await slotsTable.selectRecordsAsync({
  fields: slotFieldsToRead.filter(f => hasField(slotsTable, f)),
});

const slotUpdates = [];
const masterIds = new Set();

for (const r of slotQuery.records) {
  const status = (r.getCellValueAsString("Status") || "").trim();
  const update = {};

  // Collect master record IDs to revert
  if (hasField(slotsTable, "Master Record ID")) {
    const mrid = (r.getCellValueAsString("Master Record ID") || "").trim();
    if (mrid) masterIds.add(mrid);
  }

  // Reset status for all remaining slots except BLOCKED
  if (hasField(slotsTable, "Status")) {
    if (status !== "BLOCKED") {
      update["Status"] = sel("AVAILABLE");
    }
  }

  // Clear hold metadata
  if (hasField(slotsTable, "Hold Token")) update["Hold Token"] = "";
  if (hasField(slotsTable, "Hold Expires At")) update["Hold Expires At"] = null;
  if (hasField(slotsTable, "Held By Email")) update["Held By Email"] = "";
  if (hasField(slotsTable, "Hold Created")) update["Hold Created"] = null;

  // Clear booking link
  if (hasField(slotsTable, "Booking")) update["Booking"] = [];

  // Clear prepaid link if present on slots
  if (hasField(slotsTable, "Pre-Paid Reservation")) update["Pre-Paid Reservation"] = [];

  // Optional cleanup
  if (hasField(slotsTable, "Review Notes")) update["Review Notes"] = "";

  if (Object.keys(update).length > 0) {
    slotUpdates.push({ id: r.id, fields: update });
  }
}

if (slotUpdates.length) await chunkedUpdate(slotsTable, slotUpdates);
output.markdown(`- Reset **${slotUpdates.length}** slot record(s)`);

// -------------------- 4) Reset PAID ROSTER consumption links --------------------
output.markdown("### Step 4/5 — Resetting PAID ROSTER booking consumption…");

const paidTable = getTableIfExists(PAID_TABLE);
if (!paidTable) throw new Error(`Missing table: ${PAID_TABLE}`);

const paidFields = ["Booked Slot(s)", "Booking Confirmation"];
const paidQuery = await paidTable.selectRecordsAsync({
  fields: paidFields.filter(f => hasField(paidTable, f)),
});

const paidUpdates = [];
for (const r of paidQuery.records) {
  const update = {};
  if (hasField(paidTable, "Booked Slot(s)")) update["Booked Slot(s)"] = [];
  if (hasField(paidTable, "Booking Confirmation")) update["Booking Confirmation"] = [];
  if (Object.keys(update).length > 0) paidUpdates.push({ id: r.id, fields: update });
}

if (paidUpdates.length) await chunkedUpdate(paidTable, paidUpdates);
output.markdown(`- Reset **${paidUpdates.length}** PAID ROSTER record(s)`);

// -------------------- 5) Revert Master Schedule records --------------------
output.markdown("### Step 5/5 — Reverting Master Schedule records (cross-base)…");

const now = new Date();
const revertFields = {
  "Event": "AVAILABLE RESERVATION",
  "Reservation Name": "",
  "Reservation Email": "",
  "Reservation Booking ID": "",
  "Reservation Status": "AVAILABLE",
  "Confirmed On": null,
  "Last Reservation Sync Note": `Reset to AVAILABLE RESERVATION via RRS-9 at ${now.toISOString()}`,
};

let reverted = 0;
let failed = 0;

for (const mrid of masterIds) {
  try {
    await patchMasterRecord(masterBaseId, masterTableName, pat, mrid, revertFields);
    reverted++;
  } catch (e) {
    failed++;
    console.log(`Master revert failed for ${mrid}:`, e?.message || e);
  }
}

output.markdown(`- Reverted **${reverted}** master record(s)`);
if (failed) output.markdown(`- ⚠️ Failed to revert **${failed}** master record(s). See console.`);

output.markdown("✅ Reset complete. Inventory/rosters preserved; transactional/test data cleared; VOIDED operational slots deleted.");
