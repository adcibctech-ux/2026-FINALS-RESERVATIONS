/**
 * RRS-1-SlotImport-v1.3.26 
 * Bug fix: schema validation + type-safe writes
 * Fixes:
 * - Stops batchCreate from failing with: "Field ... cannot accept the provided value"
 *   by verifying field types before writing and skipping mis-typed fields.
 * - Prints a clear preflight report (field name + actual type + expected type).
 *
 * Behavior:
 * - Creates missing Operational slots for new Master {Slot Key}s
 * - Links Operational to Master Slot (Synced)
 * - Copies Start/End into Operational (only if those fields are editable date fields)
 * - Links Room by matching Master {Location} text to ROOMS primary {Room}
 * - Voids Operational slots missing from Master:
 *    - BOOKED => NEEDS REVIEW
 *    - else => VOIDED
 */

const MASTER_TABLE_NAME = "MASTER SLOTS (Synced)";
const OP_TABLE_NAME = "SLOTS (Operational)";
const ROOMS_TABLE_NAME = "ROOMS";

const masterTable = base.getTable(MASTER_TABLE_NAME);
const opTable = base.getTable(OP_TABLE_NAME);
const roomsTable = base.getTable(ROOMS_TABLE_NAME);

// ---------- Helpers ----------
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

function fieldInfo(table, fieldName) {
  try {
    const f = table.getField(fieldName);
    return { exists: true, name: f.name, id: f.id, type: f.type };
  } catch {
    return { exists: false, name: fieldName, id: null, type: null };
  }
}

function expectType(table, fieldName, expectedTypes) {
  const info = fieldInfo(table, fieldName);
  const ok = info.exists && expectedTypes.includes(info.type);
  return { ...info, ok, expected: expectedTypes.join(" | ") };
}

function safeSet(fieldsObj, table, fieldName, value, expectedTypes) {
  const check = expectType(table, fieldName, expectedTypes);
  if (!check.ok) return { written: false, check };
  fieldsObj[fieldName] = value;
  return { written: true, check };
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

// ---------- Preflight: verify expected schema ----------
const schemaChecks = [
  // Operational table
  expectType(opTable, "Slot Key", ["singleLineText", "multilineText"]), // allow either text type
  expectType(opTable, "Master Slot (Synced)", ["multipleRecordLinks"]),
  expectType(opTable, "Room", ["multipleRecordLinks"]),
  expectType(opTable, "Start Time", ["date"]),
  expectType(opTable, "End Time", ["date"]),
  expectType(opTable, "Status", ["singleSelect"]),
  // Master synced table
  expectType(masterTable, "Slot Key", ["formula", "singleLineText", "multilineText"]),
  expectType(masterTable, "Start Time", ["date"]),
  expectType(masterTable, "End Time", ["date"]),
  expectType(masterTable, "Location", ["singleSelect", "singleLineText", "multilineText"]),
];

const bad = schemaChecks.filter((c) => !c.ok);
if (bad.length) {
  output.markdown("### ⚠️ Slot Sync Preflight: schema mismatch detected");
  for (const b of bad) {
    output.text(
      `- Table: ${b.exists ? (b.id ? "FOUND" : "UNKNOWN") : "MISSING"} | Field: "${b.name}" | Actual type: ${b.type} | Expected: ${b.expected}`
    );
  }
  output.text(
    "Fix the field types above (recommended) or this script will skip writing those fields, which may cause incomplete slot records."
  );
}

// ---------- Load ROOMS ----------
const roomsQuery = await roomsTable.selectRecordsAsync();
const roomNameToId = new Map();
for (const r of roomsQuery.records) {
  const roomName = r.getCellValueAsString("Room").trim();
  if (roomName) roomNameToId.set(roomName, r.id);
}

// ---------- Load MASTER SLOTS (Synced) ----------
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

// ---------- Load OPERATIONAL SLOTS ----------
const opQuery = await opTable.selectRecordsAsync({
  fields: ["Slot Key", "Master Slot (Synced)", "Room", "Start Time", "End Time", "Status"],
});

const opBySlotKey = new Map();
for (const r of opQuery.records) {
  const slotKey = r.getCellValueAsString("Slot Key").trim();
  if (!slotKey) continue;
  opBySlotKey.set(slotKey, r);
}

// ---------- Create missing operational slots ----------
const creates = [];
const createWarnings = [];

for (const [slotKey, m] of masterBySlotKey.entries()) {
  if (opBySlotKey.has(slotKey)) continue;

  const fields = {};
  const roomId = roomNameToId.get(m.location);

  // Slot Key snapshot
  {
    const res = safeSet(fields, opTable, "Slot Key", slotKey, ["singleLineText", "multilineText"]);
    if (!res.written) createWarnings.push(`Create skipped writing "Slot Key" (type mismatch).`);
  }

  // Link to master synced record
  {
    const res = safeSet(fields, opTable, "Master Slot (Synced)", [{ id: m.id }], ["multipleRecordLinks"]);
    if (!res.written) createWarnings.push(`Create skipped writing "Master Slot (Synced)" (type mismatch).`);
  }

  // Copy times (only if Start/End are editable date fields)
  safeSet(fields, opTable, "Start Time", m.start ?? null, ["date"]);
  safeSet(fields, opTable, "End Time", m.end ?? null, ["date"]);

  // Link room (only if Room is a linked record field)
  if (roomId) safeSet(fields, opTable, "Room", [{ id: roomId }], ["multipleRecordLinks"]);

  // Default status (only if single select)
  safeSet(fields, opTable, "Status", "AVAILABLE", ["singleSelect"]);

  // IMPORTANT:
  // We do NOT set {Operational Slot} because it's a formula in your base.

  creates.push({ fields });
}

// ---------- Update existing operational slots ----------
const updates = [];
for (const [slotKey, opRec] of opBySlotKey.entries()) {
  const m = masterBySlotKey.get(slotKey);
  if (!m) continue;

  const fieldsToSet = {};

  // Ensure master link correct
  const existingMasterLinks = opRec.getCellValue("Master Slot (Synced)") || [];
  const alreadyLinked = existingMasterLinks.some((x) => x.id === m.id);
  if (!alreadyLinked) safeSet(fieldsToSet, opTable, "Master Slot (Synced)", [{ id: m.id }], ["multipleRecordLinks"]);

  // Ensure room matches
  const roomId = roomNameToId.get(m.location);
  if (roomId) {
    const existingRoomLinks = opRec.getCellValue("Room") || [];
    const alreadyRoomLinked = existingRoomLinks.some((x) => x.id === roomId);
    if (!alreadyRoomLinked) safeSet(fieldsToSet, opTable, "Room", [{ id: roomId }], ["multipleRecordLinks"]);
  }

  // Copy times
  safeSet(fieldsToSet, opTable, "Start Time", m.start ?? null, ["date"]);
  safeSet(fieldsToSet, opTable, "End Time", m.end ?? null, ["date"]);

  // If anything to set, push update
  if (Object.keys(fieldsToSet).length > 0) updates.push({ id: opRec.id, fields: fieldsToSet });
}

// ---------- Void operational slots missing from master ----------
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

// ---------- Execute ----------
if (creates.length) await batchCreate(opTable, creates);
if (updates.length) await batchUpdate(opTable, updates);
if (voidUpdates.length) await batchUpdate(opTable, voidUpdates);

output.text(
  `Reconcile complete:
- Created: ${creates.length}
- Updated: ${updates.length}
- Voided/Needs Review: ${voidUpdates.length}
- Create warnings: ${createWarnings.length}`
);

if (createWarnings.length) {
  output.markdown("### Create warnings");
  for (const w of createWarnings.slice(0, 50)) output.text(`- ${w}`);
}
