/**
 * RRS-1-SlotImport-v1.9.26 — Bug fix: incremental create test now auto-deletes successful test records and continues until first failure
 *
 * Purpose:
 * - Identify the exact field/value that causes "Field fld... cannot accept provided value"
 * - No manual cleanup: deletes test record after each successful step
 */

const MASTER_TABLE_NAME = "MASTER SLOTS (Synced)";
const OP_TABLE_NAME = "SLOTS (Operational)";
const ROOMS_TABLE_NAME = "ROOMS";

const masterTable = base.getTable(MASTER_TABLE_NAME);
const opTable = base.getTable(OP_TABLE_NAME);
const roomsTable = base.getTable(ROOMS_TABLE_NAME);

function parseFieldIdFromError(err) {
  const msg = (err && err.message) ? err.message : String(err);
  const m = msg.match(/fld[a-zA-Z0-9]+/);
  return m ? m[0] : null;
}

function fieldNameFromId(table, fieldId) {
  const fields = table.fields || [];
  const f = fields.find(x => x.id === fieldId);
  return f ? { name: f.name, type: f.type, id: f.id } : null;
}

async function createOne(table, fields) {
  const ids = await table.createRecordsAsync([{ fields }]);
  // createRecordsAsync returns array of recordIds
  return ids[0];
}

async function tryCreateAndDelete(table, fields, label) {
  try {
    const recId = await createOne(table, fields);
    console.log(`✅ CREATE OK: ${label} (created ${recId})`);
    // delete immediately to keep table clean
    await table.deleteRecordAsync(recId);
    console.log(`🧹 Deleted test record: ${recId}`);
    return { ok: true };
  } catch (err) {
    console.log(`❌ CREATE FAIL: ${label}`);
    console.log("Error message:", err?.message || err);

    const fid = parseFieldIdFromError(err);
    if (fid) {
      const info = fieldNameFromId(table, fid);
      if (info) {
        console.log(`Failing field id: ${fid}`);
        console.log(`Failing field name: "${info.name}"`);
        console.log(`Failing field type: ${info.type}`);
      } else {
        console.log(`Failing field id: ${fid} (could not map to a field name)`);
      }
    } else {
      console.log("Could not parse a field id from the error.");
    }

    return { ok: false };
  }
}

// ---------- Load ROOMS map ----------
const roomsQuery = await roomsTable.selectRecordsAsync();
const roomNameToId = new Map();
for (const r of roomsQuery.records) {
  const roomName = r.getCellValueAsString("Room").trim();
  if (roomName) roomNameToId.set(roomName, r.id);
}
console.log(`ROOMS loaded: ${roomNameToId.size}`);

// ---------- Load OP existing keys ----------
const opQuery = await opTable.selectRecordsAsync({ fields: ["Slot Key"] });
const existingKeys = new Set(opQuery.records.map(r => r.getCellValueAsString("Slot Key").trim()).filter(Boolean));
console.log(`OPERATIONAL slots loaded: ${existingKeys.size}`);

// ---------- Load MASTER slots ----------
const masterQuery = await masterTable.selectRecordsAsync({
  fields: ["Slot Key", "Start Time", "End Time", "Location"]
});

const masterRecs = masterQuery.records
  .map(r => ({
    slotKey: r.getCellValueAsString("Slot Key").trim(),
    id: r.id,
    start: r.getCellValue("Start Time"),
    end: r.getCellValue("End Time"),
    location: r.getCellValueAsString("Location").trim(),
  }))
  .filter(x => x.slotKey && !existingKeys.has(x.slotKey));

console.log(`MASTER candidate slots (not yet operational): ${masterRecs.length}`);

if (!masterRecs.length) {
  console.log("Nothing to test. Done.");
  return;
}

const m = masterRecs[0];
const roomId = roomNameToId.get(m.location);

console.log("Diagnostic sample:");
console.log(`- Slot Key: ${m.slotKey}`);
console.log(`- Location: ${m.location}`);
console.log(`- Room match id: ${roomId || "NONE"}`);
console.log(`- Start Time raw: ${m.start}`);
console.log(`- End Time raw: ${m.end}`);

if (!roomId) {
  console.log("Room did not match ROOMS table. Fix ROOMS names or location values first.");
  return;
}

const payloads = [
  { label: "Slot Key only", fields: { "Slot Key": m.slotKey } },
  { label: "Slot Key + Status (string)", fields: { "Slot Key": m.slotKey, "Status": "AVAILABLE" } },
  { label: "Slot Key + Status (name obj)", fields: { "Slot Key": m.slotKey, "Status": { name: "AVAILABLE" } } },
  { label: "Add Master Slot (Synced)", fields: { "Slot Key": m.slotKey, "Status": { name: "AVAILABLE" }, "Master Slot (Synced)": [{ id: m.id }] } },
  { label: "Add Room", fields: { "Slot Key": m.slotKey, "Status": { name: "AVAILABLE" }, "Master Slot (Synced)": [{ id: m.id }], "Room": [{ id: roomId }] } },
  { label: "Add Start Time", fields: { "Slot Key": m.slotKey, "Status": { name: "AVAILABLE" }, "Master Slot (Synced)": [{ id: m.id }], "Room": [{ id: roomId }], "Start Time": m.start } },
  { label: "Add End Time (FULL)", fields: { "Slot Key": m.slotKey, "Status": { name: "AVAILABLE" }, "Master Slot (Synced)": [{ id: m.id }], "Room": [{ id: roomId }], "Start Time": m.start, "End Time": m.end } },
];

console.log("Beginning incremental create test (auto-cleanup each success)...");

for (const p of payloads) {
  const res = await tryCreateAndDelete(opTable, p.fields, p.label);
  if (!res.ok) {
    console.log("Stopped at first failure. This identifies the culprit field/value.");
    break;
  }
}

console.log("Incremental test complete.");
