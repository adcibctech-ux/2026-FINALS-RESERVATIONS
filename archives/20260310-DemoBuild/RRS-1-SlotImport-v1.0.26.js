// RRS-1-SlotImport-v1.0.26
// Airtable Automation Script: Reconcile MASTER SLOTS (Synced) -> SLOTS (Operational)
// Tables (confirmed exact names):
// - "MASTER SLOTS (Synced)"
// - "SLOTS (Operational)"
// - "ROOMS"
//
// Fields used (confirmed exact names):
// MASTER SLOTS (Synced): {Slot Key}, {Start Time}, {End Time}, {Location}
// SLOTS (Operational): {Slot Key}, {Master Slot (Synced)}, {Room}, {Start Time}, {End Time}, {Status}
// ROOMS: Primary field {Room}

const MASTER_TABLE_NAME = "MASTER SLOTS (Synced)";
const OP_TABLE_NAME = "SLOTS (Operational)";
const ROOMS_TABLE_NAME = "ROOMS";

const masterTable = base.getTable(MASTER_TABLE_NAME);
const opTable = base.getTable(OP_TABLE_NAME);
const roomsTable = base.getTable(ROOMS_TABLE_NAME);

// Helper: batch update/create to respect limits
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

// 1) Load ROOMS into a name -> recordId map
const roomsQuery = await roomsTable.selectRecordsAsync();
const roomNameToId = new Map();
for (const r of roomsQuery.records) {
  const roomName = r.getCellValueAsString("Room").trim();
  if (roomName) roomNameToId.set(roomName, r.id);
}

// 2) Load master slots
const masterQuery = await masterTable.selectRecordsAsync({
  fields: ["Slot Key", "Start Time", "End Time", "Location"]
});

const masterBySlotKey = new Map(); // slotKey -> {recordId, start, end, location}
for (const r of masterQuery.records) {
  const slotKey = r.getCellValueAsString("Slot Key").trim();
  if (!slotKey) continue;
  masterBySlotKey.set(slotKey, {
    id: r.id,
    start: r.getCellValue("Start Time"),
    end: r.getCellValue("End Time"),
    location: r.getCellValueAsString("Location").trim()
  });
}

// 3) Load operational slots
const opQuery = await opTable.selectRecordsAsync({
  fields: ["Slot Key", "Master Slot (Synced)", "Room", "Start Time", "End Time", "Status"]
});

const opBySlotKey = new Map(); // slotKey -> opRecord
for (const r of opQuery.records) {
  const slotKey = r.getCellValueAsString("Slot Key").trim();
  if (!slotKey) continue;
  opBySlotKey.set(slotKey, r);
}

// 4) Create missing operational slots for new master keys
const creates = [];
for (const [slotKey, m] of masterBySlotKey.entries()) {
  if (opBySlotKey.has(slotKey)) continue;

  const roomId = roomNameToId.get(m.location);
  // If room is missing, we still create the op record, just without the Room link
  creates.push({
    fields: {
      "Slot Key": slotKey,
      "Master Slot (Synced)": [{ id: m.id }],
      "Start Time": m.start ?? null,
      "End Time": m.end ?? null,
      ...(roomId ? { "Room": [{ id: roomId }] } : {}),
      "Status": "AVAILABLE",
    }
  });
}

// 5) Update existing operational slots to ensure link + copied times + room link are correct
// (Only for records that still exist in master by exact Slot Key)
const updates = [];
for (const [slotKey, opRec] of opBySlotKey.entries()) {
  const m = masterBySlotKey.get(slotKey);
  if (!m) continue;

  // Ensure it is linked to the correct master record
  const existingMasterLinks = opRec.getCellValue("Master Slot (Synced)") || [];
  const alreadyLinked = existingMasterLinks.some(x => x.id === m.id);

  // Ensure room link matches the master location
  const roomId = roomNameToId.get(m.location);
  const existingRoomLinks = opRec.getCellValue("Room") || [];
  const alreadyRoomLinked = roomId ? existingRoomLinks.some(x => x.id === roomId) : true;

  // Always copy Start/End (you requested copy-from-sync)
  // (This won’t affect “changed” slots, because their Slot Key changes and they won’t match here.)
  const fieldsToSet = {};
  if (!alreadyLinked) fieldsToSet["Master Slot (Synced)"] = [{ id: m.id }];
  if (roomId && !alreadyRoomLinked) fieldsToSet["Room"] = [{ id: roomId }];
  fieldsToSet["Start Time"] = m.start ?? null;
  fieldsToSet["End Time"] = m.end ?? null;

  if (Object.keys(fieldsToSet).length > 0) {
    updates.push({ id: opRec.id, fields: fieldsToSet });
  }
}

// 6) Void operational slots that no longer exist in master
const voidUpdates = [];
for (const [slotKey, opRec] of opBySlotKey.entries()) {
  if (masterBySlotKey.has(slotKey)) continue;

  const status = opRec.getCellValueAsString("Status").trim();
  if (status === "BOOKED") {
    voidUpdates.push({ id: opRec.id, fields: { "Status": "NEEDS REVIEW" } });
  } else {
    voidUpdates.push({ id: opRec.id, fields: { "Status": "VOIDED" } });
  }
}

// Execute changes
if (creates.length) await batchCreate(opTable, creates);
if (updates.length) await batchUpdate(opTable, updates);
if (voidUpdates.length) await batchUpdate(opTable, voidUpdates);

output.text(
  `Reconcile complete:
- Created: ${creates.length}
- Updated: ${updates.length}
- Voided/Needs Review: ${voidUpdates.length}`
);
