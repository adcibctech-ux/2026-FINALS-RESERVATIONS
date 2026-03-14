/**
 * RRS-1-SlotImport-v1.7.26 — Bug fix: validate Status option + single-record diagnostic to identify failing field/value
 *
 * Fixes:
 * - If {Status} single select does not contain "AVAILABLE" exactly, script will not write Status on create
 *   (prevents create failures caused by invalid select option values).
 * - If batchCreate fails, script falls back to single-record creates to identify which record/payload is failing.
 *
 * Tables:
 * - "MASTER SLOTS (Synced)"
 * - "SLOTS (Operational)"
 * - "ROOMS"
 *
 * Fields:
 * MASTER SLOTS (Synced): {Slot Key}, {Start Time}, {End Time}, {Location}
 * SLOTS (Operational):  {Slot Key}, {Master Slot (Synced)}, {Room}, {Start Time}, {End Time}, {Status}
 * ROOMS: primary {Room}
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

// Create records one-at-a-time to diagnose which payload fails
async function createIndividuallyWithLogs(table, records) {
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    try {
      await table.createRecordsAsync([rec]);
      ok++;
    } catch (e) {
      failed++;
      const slotKey = rec?.fields?.["Slot Key"];
      console.log("CREATE FAILED for record payload:");
      console.log(`- Slot Key: ${slotKey}`);
      console.log("- Fields keys:", Object.keys(rec.fields || {}));
      console.log("- Full fields payload:", JSON.stringify(rec.fields || {}, null, 2));
      console.log("- Error:", e?.message || e);
      // Stop after first failure to avoid spamming logs
      break;
    }
  }
  console.log(`Individual create results: ok=${ok}, failed=${failed}`);
}

// ---------- Preflight: validate Status options ----------
let statusOptionAvailable = false;
try {
  const statusField = opTable.getField("Status");
  if (statusField.type === "singleSelect") {
    const choices = statusField.options.choices || [];
    statusOptionAvailable = choices.some(c => (c.name || "").trim() === "AVAILABLE");
    if (!statusOptionAvailable) {
      console.log('⚠️ Status option "AVAILABLE" not found exactly in SLOTS (Operational) → Status will NOT be set on create.');
      console.log("Existing Status choices:", choices.map(c => c.name));
    } else {
      console.log('✅ Status option "AVAILABLE" exists.');
    }
  } else {
    console.log('⚠️ Field "Status" is not singleSelect; script will NOT set Status on create.');
  }
} catch (e) {
  console.log('⚠️ Could not inspect "Status" field options; script will NOT set Status on create.');
}

// ---------- Load ROOMS ----------
const roomsQuery = await roomsTable.selectRecordsAsync();
const roomNameToId = new Map();
for (const r of roomsQuery.records) {
  const roomName = r.getCellValueAsString("Room").trim();
  if (roomName) roomNameToId.set(roomName, r.id);
}
console.log(`ROOMS loaded: ${roomNameToId.size}`);

// ---------- Load MASTER SLOTS ----------
const masterQuery = await masterTable.selectRecordsAsync({
  fields: ["Slot Key", "Start Time", "End Time", "Location"],
});

const masterBySlotKey = new Map();
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
console.log(`MASTER slots loaded: ${masterBySlotKey.size}`);

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
console.log(`OPERATIONAL slots loaded: ${opBySlotKey.size}`);

// ---------- Create missing operational slots ----------
const creates = [];
let skippedNoRoomMatch = 0;

for (const [slotKey, m] of masterBySlotKey.entries()) {
  if (opBySlotKey.has(slotKey)) continue;

  const roomId = roomNameToId.get(m.location);
  if (!roomId) {
    skippedNoRoomMatch++;
    console.log(`SKIP create (no ROOMS match): Location="${m.location}" | Slot Key="${slotKey}"`);
    continue;
  }

  const fields = {
    "Slot Key": slotKey,
    "Master Slot (Synced)": [{ id: m.id }],
    "Room": [{ id: roomId }],
    "Start Time": m.start ?? null,
    "End Time": m.end ?? null,
  };

  // Only set Status if the exact option exists
  if (statusOptionAvailable) {
    fields["Status"] = "AVAILABLE";
  }

  // NOTE: We do NOT set {Operational Slot} because it's a formula in your base.
  creates.push({ fields });
}

console.log(`Prepared creates: ${creates.length} (skipped room mismatch: ${skippedNoRoomMatch})`);

// ---------- Updates + voids (won't matter until some ops exist) ----------
const updates = [];
const voidUpdates = [];

// ---------- Execute creates ----------
if (creates.length) {
  try {
    await batchCreate(opTable, creates);
    console.log(`batchCreate success: created ${creates.length}`);
  } catch (e) {
    console.log("batchCreate FAILED. Switching to individual creates to diagnose...");
    console.log("batchCreate error:", e?.message || e);
    await createIndividuallyWithLogs(opTable, creates);
  }
}

if (updates.length) await batchUpdate(opTable, updates);
if (voidUpdates.length) await batchUpdate(opTable, voidUpdates);

console.log("Done.");
