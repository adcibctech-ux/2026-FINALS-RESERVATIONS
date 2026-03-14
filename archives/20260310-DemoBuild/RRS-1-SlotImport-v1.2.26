/**
 * RRS-1-SlotImport-v1.2.26 
 *
 * Bug fix: avoid writing to computed fields (formula/lookup/rollup/etc.)
 *
 * Fixes the error:
 *   "Cannot modify a computed field."
 * by dynamically checking field types in "SLOTS (Operational)" and only setting values
 * for fields that are editable.
 *
 * Tables:
 * - "MASTER SLOTS (Synced)"
 * - "SLOTS (Operational)"
 * - "ROOMS"
 *
 * MASTER SLOTS (Synced) fields used:
 * - {Slot Key}, {Start Time}, {End Time}, {Location}
 *
 * SLOTS (Operational) fields used (only if editable):
 * - {Operational Slot}, {Slot Key}, {Master Slot (Synced)}, {Room},
 *   {Start Time}, {End Time}, {Status}
 *
 * ROOMS:
 * - Primary field {Room} (values match Master {Location} text)
 */

const MASTER_TABLE_NAME = "MASTER SLOTS (Synced)";
const OP_TABLE_NAME = "SLOTS (Operational)";
const ROOMS_TABLE_NAME = "ROOMS";

const masterTable = base.getTable(MASTER_TABLE_NAME);
const opTable = base.getTable(OP_TABLE_NAME);
const roomsTable = base.getTable(ROOMS_TABLE_NAME);

// ---------------- Helpers ----------------
async function batchUpdate(table, records) {
  const CHUNK = 50;
  for (let i = 0; i < records.length; i += CHUNK) {
    await table.updateRecordsAsync(records.slice(i, i + CHUNK));
  }
}

async function batchCreate(table, records) {
  const CHUNK = 50;
  for (let i = 0; i < records.length; i += CHUNK) {
    await table.createRecordsAsync(records.slice(i, i + CHUNK));
  }
}

// Field types that cannot be directly written to (computed/system)
const NON_EDITABLE_TYPES = new Set([
  "formula",
  "rollup",
  "lookup",
  "multipleLookupValues",
  "count",
  "autoNumber",
  "createdTime",
  "lastModifiedTime",
  "createdBy",
  "lastModifiedBy",
  "button",
]);

function isEditableField(table, fieldName) {
  let f;
  try {
    f = table.getField(fieldName);
  } catch (e) {
    return false; // field doesn't exist
  }
  return !NON_EDITABLE_TYPES.has(f.type);
}

function safeSet(fieldsObj, table, fieldName, value) {
  if (!isEditableField(table, fieldName)) return;
  fieldsObj[fieldName] = value;
}

// Format datetime as "YYYY-MM-DD HH:mm" in America/New_York
function fmtNY(dtVal) {
  if (!dtVal) return "";
  const d = dtVal instanceof Date ? dtVal : new Date(dtVal);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function buildOperationalSlot(location, startVal, endVal) {
  return `${location} // ${fmtNY(startVal)} // ${fmtNY(endVal)}`;
}

// ---------------- Main ----------------

// Build ROOMS name -> id map
const roomsQuery = await roomsTable.selectRecordsAsync();
const roomNameToId = new Map();
for (const r of roomsQuery.records) {
  const roomName = r.getCellValueAsString("Room").trim();
  if (roomName) roomNameToId.set(roomName, r.id);
}

// Load master slots
const masterQuery = await masterTable.selectRecordsAsync({
  fields: ["Slot Key", "Start Time", "End Time", "Location"],
});

const masterBySlotKey = new Map(); // slotKey -> {id, start, end, location}
for (const r of masterQuery.records) {
  const slotKey = r.getCellValueAsString("Slot Key").trim();
  if (!slotKey) continue;

  masterBySlotKey.set(slotKey, {
    id: r.id,
    start: r.getCellValue("Start Time"),
    end: r.getCellValue("End Time"),
    location: r.getCellValueAsString("Location").trim(),
  });
}

// Load operational slots
const opQuery = await opTable.selectRecordsAsync({
  fields: ["Operational Slot", "Slot Key", "Master Slot (Synced)", "Room", "Start Time", "End Time", "Status"],
});

const opBySlotKey = new Map();
for (const r of opQuery.records) {
  const slotKey = r.getCellValueAsString("Slot Key").trim();
  if (!slotKey) continue;
  opBySlotKey.set(slotKey, r);
}

// 1) Create missing operational slots
const creates = [];
for (const [slotKey, m] of masterBySlotKey.entries()) {
  if (opBySlotKey.has(slotKey)) continue;

  const roomId = roomNameToId.get(m.location);
  const opName = buildOperationalSlot(m.location, m.start, m.end);

  const fields = {};

  // Primary field may be computed in your base; only set if editable
  safeSet(fields, opTable, "Operational Slot", opName);

  safeSet(fields, opTable, "Slot Key", slotKey);
  safeSet(fields, opTable, "Master Slot (Synced)", [{ id: m.id }]);

  // Copy times only if Start/End are editable (not lookup/formula)
  safeSet(fields, opTable, "Start Time", m.start ?? null);
  safeSet(fields, opTable, "End Time", m.end ?? null);

  if (roomId) safeSet(fields, opTable, "Room", [{ id: roomId }]);

  // Default status on create
  safeSet(fields, opTable, "Status", "AVAILABLE");

  creates.push({ fields });
}

// 2) Update existing operational slots that still exist in master
const updates = [];
for (const [slotKey, opRec] of opBySlotKey.entries()) {
  const m = masterBySlotKey.get(slotKey);
  if (!m) continue;

  const fieldsToSet = {};

  // Ensure master link is correct
  const existingMasterLinks = opRec.getCellValue("Master Slot (Synced)") || [];
  const alreadyLinked = existingMasterLinks.some((x) => x.id === m.id);
  if (!alreadyLinked) safeSet(fieldsToSet, opTable, "Master Slot (Synced)", [{ id: m.id }]);

  // Ensure room link matches location
  const roomId = roomNameToId.get(m.location);
  if (roomId) {
    const existingRoomLinks = opRec.getCellValue("Room") || [];
    const alreadyRoomLinked = existingRoomLinks.some((x) => x.id === roomId);
    if (!alreadyRoomLinked) safeSet(fieldsToSet, opTable, "Room", [{ id: roomId }]);
  }

  // Copy times from master if editable
  safeSet(fieldsToSet, opTable, "Start Time", m.start ?? null);
  safeSet(fieldsToSet, opTable, "End Time", m.end ?? null);

  // Fill Operational Slot only if editable AND currently blank
  const currentOpName = opRec.getCellValueAsString("Operational Slot").trim();
  if (!currentOpName) safeSet(fieldsToSet, opTable, "Operational Slot", buildOperationalSlot(m.location, m.start, m.end));

  if (Object.keys(fieldsToSet).length > 0) {
    updates.push({ id: opRec.id, fields: fieldsToSet });
  }
}

// 3) Void operational slots missing from master
const voidUpdates = [];
for (const [slotKey, opRec] of opBySlotKey.entries()) {
  if (masterBySlotKey.has(slotKey)) continue;

  const status = opRec.getCellValueAsString("Status").trim();
  if (status === "BOOKED") {
    voidUpdates.push({ id: opRec.id, fields: { Status: "NEEDS REVIEW" } });
  } else {
    voidUpdates.push({ id: opRec.id, fields: { Status: "VOIDED" } });
  }
}

if (creates.length) await batchCreate(opTable, creates);
if (updates.length) await batchUpdate(opTable, updates);
if (voidUpdates.length) await batchUpdate(opTable, voidUpdates);

output.text(
  `Reconcile complete:
- Created: ${creates.length}
- Updated: ${updates.length}
- Voided/Needs Review: ${voidUpdates.length}`
);
