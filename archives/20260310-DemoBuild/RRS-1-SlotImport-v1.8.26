/**
 * RRS-1-SlotImport-v1.8.26 — Bug fix: map failing fld->field name + incremental create isolate test
 *
 * What it does:
 * - Builds ONE record payload from the first Master Slot not yet in Operational
 * - Attempts incremental creates to identify which field/value causes "cannot accept provided value"
 * - If a fldXXXX id appears, prints the corresponding field name + type
 *
 * After this runs, you’ll know exactly which field is rejecting the value and why.
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

async function tryCreate(table, fields, label) {
  try {
    await table.createRecordsAsync([{ fields }]);
    console.log(`✅ CREATE OK: ${label}`);
    return true;
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
    }
    return false;
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
    start: r.getCellValue("Start Time"),   // should be Date
    end: r.getCellValue("End Time"),       // should be Date
    location: r.getCellValueAsString("Location").trim(),
  }))
  .filter(x => x.slotKey && !existingKeys.has(x.slotKey));

console.log(`MASTER candidate slots (not yet operational): ${masterRecs.length}`);

if (!masterRecs.length) {
  console.log("Nothing to create. Done.");
  return;
}

// Pick first candidate as diagnostic sample
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

// Build the full payload as you intend to create
const fullPayload = {
  "Slot Key": m.slotKey,
  "Status": { name: "AVAILABLE" },                 // more robust than "AVAILABLE"
  "Master Slot (Synced)": [{ id: m.id }],
  "Room": [{ id: roomId }],
  "Start Time": m.start ?? null,                   // Date object
  "End Time": m.end ?? null,                       // Date object
};

// Incremental create steps (to isolate the failing field)
const steps = [
  { label: "Slot Key only", fields: { "Slot Key": fullPayload["Slot Key"] } },
  { label: "Slot Key + Status", fields: { "Slot Key": fullPayload["Slot Key"], "Status": fullPayload["Status"] } },
  { label: "Add Master Slot (Synced)", fields: { "Slot Key": fullPayload["Slot Key"], "Status": fullPayload["Status"], "Master Slot (Synced)": fullPayload["Master Slot (Synced)"] } },
  { label: "Add Room", fields: { "Slot Key": fullPayload["Slot Key"], "Status": fullPayload["Status"], "Master Slot (Synced)": fullPayload["Master Slot (Synced)"], "Room": fullPayload["Room"] } },
  { label: "Add Start Time", fields: { "Slot Key": fullPayload["Slot Key"], "Status": fullPayload["Status"], "Master Slot (Synced)": fullPayload["Master Slot (Synced)"], "Room": fullPayload["Room"], "Start Time": fullPayload["Start Time"] } },
  { label: "Add End Time (FULL)", fields: fullPayload },
];

console.log("Beginning incremental create test...");

// IMPORTANT: Each create will actually create a record if successful.
// To avoid leaving partial test records, we will STOP after the first successful create
// and tell you which step passed. Then you can delete that one test record manually.
for (const step of steps) {
  const ok = await tryCreate(opTable, step.fields, step.label);
  if (ok) {
    console.log("STOPPING after first success to avoid creating multiple test records.");
    console.log("Delete the created test record in SLOTS (Operational), then we’ll finalize the bulk create script.");
    break;
  } else {
    console.log("Continuing to next step...");
  }
}

console.log("Incremental test complete.");
