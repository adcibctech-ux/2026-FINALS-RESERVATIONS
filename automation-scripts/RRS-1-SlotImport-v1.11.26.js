/**
 * RRS-1-SlotImport-v1.11.26
 * Bug fix: protect NEEDS REVIEW (and any slot with a linked Booking) from being auto-VOIDED on subsequent reconciliations.
 *
 * Fixes:
 * - Previously: missing-from-master rule was:
 *      BOOKED => NEEDS REVIEW
 *      else   => VOIDED
 *   which caused NEEDS REVIEW to be VOIDED on the next run.
 * - Now: missing-from-master rule is:
 *      if Status is BOOKED OR NEEDS REVIEW OR slot has linked Booking => NEEDS REVIEW
 *      else => VOIDED
 *
 * Behavior:
 * - Create missing SLOTS (Operational) for each MASTER SLOTS (Synced) Slot Key not present
 * - Update existing matching Slot Keys with correct master link/room link and copy Start/End
 * - If Operational Slot Key no longer exists in Master:
 *    - BOOKED / NEEDS REVIEW / has Booking link => NEEDS REVIEW
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

async function createIndividually(table, records) {
  let ok = 0;
  for (const rec of records) {
    await table.createRecordsAsync([rec]);
    ok++;
  }
  return ok;
}

function sel(name) {
  return { name };
}

// ---------- Load ROOMS map ----------
const roomsQuery = await roomsTable.selectRecordsAsync();
const roomNameToId = new Map();
for (const r of roomsQuery.records) {
  const roomName = r.getCellValueAsString("Room").trim();
  if (roomName) roomNameToId.set(roomName, r.id);
}
console.log(`ROOMS loaded: ${roomNameToId.size}`);

// ---------- Load MASTER slots ----------
const masterQuery = await masterTable.selectRecordsAsync({
  fields: ["Slot Key", "Start Time", "End Time", "Location"],
});

const masterBySlotKey = new Map();
for (const r of masterQuery.records) {
  const slotKey = r.getCellValueAsString("Slot Key").trim();
  if (!slotKey) continue;

  masterBySlotKey.set(slotKey, {
    id: r.id,
    start: r.getCellValue("Start Time"), // Date
    end: r.getCellValue("End Time"),     // Date
    location: r.getCellValueAsString("Location").trim(),
  });
}
console.log(`MASTER slots loaded: ${masterBySlotKey.size}`);

// ---------- Load OPERATIONAL slots ----------
const opQuery = await opTable.selectRecordsAsync({
  fields: ["Slot Key", "Master Slot (Synced)", "Room", "Start Time", "End Time", "Status", "Booking"], // <-- added Booking
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

  creates.push({
    fields: {
      "Slot Key": slotKey,
      "Master Slot (Synced)": [{ id: m.id }],
      "Room": [{ id: roomId }],
      "Start Time": m.start ?? null,
      "End Time": m.end ?? null,
      "Status": sel("AVAILABLE"),
    },
  });
}

console.log(`Prepared creates: ${creates.length} (skipped room mismatch: ${skippedNoRoomMatch})`);

// ---------- Update existing operational slots ----------
const updates = [];
for (const [slotKey, opRec] of opBySlotKey.entries()) {
  const m = masterBySlotKey.get(slotKey);
  if (!m) continue;

  const fieldsToSet = {};

  // Ensure master link correct
  const existingMasterLinks = opRec.getCellValue("Master Slot (Synced)") || [];
  const alreadyLinked = existingMasterLinks.some((x) => x.id === m.id);
  if (!alreadyLinked) fieldsToSet["Master Slot (Synced)"] = [{ id: m.id }];

  // Ensure room matches
  const roomId = roomNameToId.get(m.location);
  if (roomId) {
    const existingRoomLinks = opRec.getCellValue("Room") || [];
    const alreadyRoomLinked = existingRoomLinks.some((x) => x.id === roomId);
    if (!alreadyRoomLinked) fieldsToSet["Room"] = [{ id: roomId }];
  } else {
    // If we can't map the room anymore, flag for review
    fieldsToSet["Status"] = sel("NEEDS REVIEW");
    console.log(`WARN: No ROOMS match for existing slot: Location="${m.location}" | Slot Key="${slotKey}"`);
  }

  // Copy times
  fieldsToSet["Start Time"] = m.start ?? null;
  fieldsToSet["End Time"] = m.end ?? null;

  if (Object.keys(fieldsToSet).length > 0) updates.push({ id: opRec.id, fields: fieldsToSet });
}

// ---------- Void operational slots missing from master (patched) ----------
const voidUpdates = [];
for (const [slotKey, opRec] of opBySlotKey.entries()) {
  if (masterBySlotKey.has(slotKey)) continue;

  const status = (opRec.getCellValueAsString("Status") || "").trim();
  const bookingLinks = opRec.getCellValue("Booking") || [];
  const hasBooking = bookingLinks.length > 0;

  // PATCH: protect BOOKED + NEEDS REVIEW + any slot linked to a Booking from being VOIDED
  if (hasBooking || status === "BOOKED" || status === "NEEDS REVIEW") {
    voidUpdates.push({ id: opRec.id, fields: { Status: sel("NEEDS REVIEW") } });
  } else {
    voidUpdates.push({ id: opRec.id, fields: { Status: sel("VOIDED") } });
  }
}

// ---------- Execute ----------
if (creates.length) {
  try {
    await batchCreate(opTable, creates);
    console.log(`batchCreate success: created ${creates.length}`);
  } catch (e) {
    console.log("batchCreate FAILED; falling back to individual creates.");
    console.log("batchCreate error:", e?.message || e);
    const ok = await createIndividually(opTable, creates);
    console.log(`individual create success count: ${ok}`);
  }
}

if (updates.length) await batchUpdate(opTable, updates);
if (voidUpdates.length) await batchUpdate(opTable, voidUpdates);

console.log("Reconcile complete:");
console.log(`- Created attempted: ${creates.length}`);
console.log(`- Updated: ${updates.length}`);
console.log(`- Voided/Needs Review: ${voidUpdates.length}`);
console.log(`- Skipped (no ROOMS match): ${skippedNoRoomMatch}`);
