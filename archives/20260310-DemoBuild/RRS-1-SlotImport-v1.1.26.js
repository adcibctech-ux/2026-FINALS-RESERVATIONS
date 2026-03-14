/**
 * RRS-1-SlotImport-v1.1.26 — FULL DROP-IN SCRIPT
 * Reconcile "MASTER SLOTS (Synced)" ➜ "SLOTS (Operational)"
 *
 * What it does:
 * 1) Creates missing Operational slot records for new Master {Slot Key}s
 * 2) Ensures existing Operational slots are linked to the correct Master synced record
 * 3) Copies {Start Time}/{End Time} from Master into Operational (per your preference)
 * 4) Links {Room} by matching Master {Location} text to ROOMS primary field {Room}
 * 5) Voids Operational slots whose {Slot Key} no longer exists in Master:
 *    - if Status=BOOKED ➜ NEEDS REVIEW
 *    - else ➜ VOIDED
 *
 * Notes:
 * - Requires these exact table names:
 *   - "MASTER SLOTS (Synced)"
 *   - "SLOTS (Operational)"
 *   - "ROOMS"
 * - Requires these exact fields:
 *   MASTER SLOTS (Synced): {Slot Key}, {Start Time}, {End Time}, {Location}
 *   SLOTS (Operational):  {Operational Slot}, {Slot Key}, {Master Slot (Synced)}, {Room},
 *                         {Start Time}, {End Time}, {Status}
 *   ROOMS: primary field {Room}
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
  // Uses your delimiter choice: " // "
  return `${location} // ${fmtNY(startVal)} // ${fmtNY(endVal)}`;
}

// ---------------- Main ----------------
const roomsQuery = await roomsTable.selectRecordsAsync();
const roomNameToId = new Map();
for (const r of roomsQuery.records) {
  const roomName = r.getCellValueAsString("Room").trim();
  if (roomName) roomNameToId.set(roomName, r.id);
}

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

const opQuery = await opTable.selectRecordsAsync({
  fields: ["Operational Slot", "Slot Key", "Master Slot (Synced)", "Room", "Start Time", "End Time", "Status"],
});

const opBySlotKey = new Map(); // slotKey -> op record
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

  // Primary field {Operational Slot} must be set or create will error
  const fields = {
    "Operational Slot": opName,
    "Slot Key": slotKey,
    "Master Slot (Synced)": [{ id: m.id }],
    "Start Time": m.start ?? null,
    "End Time": m.end ?? null,
    "Status": "AVAILABLE",
  };

  if (roomId) fields["Room"] = [{ id: roomId }];

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
  if (!alreadyLinked) fieldsToSet["Master Slot (Synced)"] = [{ id: m.id }];

  // Ensure room link matches location
  const roomId = roomNameToId.get(m.location);
  if (roomId) {
    const existingRoomLinks = opRec.getCellValue("Room") || [];
    const alreadyRoomLinked = existingRoomLinks.some((x) => x.id === roomId);
    if (!alreadyRoomLinked) fieldsToSet["Room"] = [{ id: roomId }];
  }

  // Copy times from master (per your preference)
  fieldsToSet["Start Time"] = m.start ?? null;
  fieldsToSet["End Time"] = m.end ?? null;

  // Ensure primary name exists (only fill if blank)
  const currentOpName = opRec.getCellValueAsString("Operational Slot").trim();
  if (!currentOpName) fieldsToSet["Operational Slot"] = buildOperationalSlot(m.location, m.start, m.end);

  // Only push update if something is set
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
