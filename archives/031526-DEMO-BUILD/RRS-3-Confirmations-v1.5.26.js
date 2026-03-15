/**
 * RRS-3-Confirmations-v1.5.26
 * PATCH: PARTIAL includes manually EXPIRED bookings + LastName-inclusive summaries
 */

const cfg = input.config();
const confirmationRecordId = cfg.recordId;

const CONF_TABLE = "CONFIRMATIONS";
const REQ_TABLE = "BOOKING REQUESTS";
const BOOK_TABLE = "BOOKINGS";
const SLOTS_TABLE = "SLOTS (Operational)";
const PAID_TABLE = "PAID ROSTER";

const confirmations = base.getTable(CONF_TABLE);
const requests = base.getTable(REQ_TABLE);
const bookings = base.getTable(BOOK_TABLE);
const slots = base.getTable(SLOTS_TABLE);
const paid = base.getTable(PAID_TABLE);

function sel(name) { return { name }; }

function fmtDate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${mm}/${dd}/${yy}`;
}
function fmtTime(d) {
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m} ${ampm}`;
}
function resLine(n, lastName, room, start, end) {
  return `RESERVATION ${n}: ${lastName} // ${room} // ${fmtDate(start)} // ${fmtTime(start)} - ${fmtTime(end)} (EST)`;
}
function failLine(lastName, room, start, end, reason) {
  return `FAILED: ${lastName} // ${room} // ${fmtDate(start)} // ${fmtTime(start)} - ${fmtTime(end)} (EST) — ${reason}`;
}

async function batchUpdate(table, updates) {
  const CHUNK = 50;
  for (let i = 0; i < updates.length; i += CHUNK) {
    await table.updateRecordsAsync(updates.slice(i, i + CHUNK));
  }
}

// Load confirmation
const confQuery = await confirmations.selectRecordsAsync({
  fields: [
    "Booking Request",
    "Contact Email",
    "Confirmation Code",
    "Confirmation Agreement",
    "Result",
    "Booking",
    "Hold Token",
    "Booking Summary",
    "Confirmed Booking(s)",
    "Failed Booking(s)",
    "Failed Booking Summary",
  ],
});
const conf = confQuery.getRecord(confirmationRecordId);
if (!conf) throw new Error(`CONFIRMATIONS record not found: ${confirmationRecordId}`);

if (!conf.getCellValue("Confirmation Agreement")) {
  await confirmations.updateRecordAsync(conf.id, { "Result": sel("INVALID") });
  return;
}

const reqLink = (conf.getCellValue("Booking Request") || [])[0];
const contactEmail = (conf.getCellValueAsString("Contact Email") || "").trim();
const code = (conf.getCellValueAsString("Confirmation Code") || "").trim();
if (!reqLink || !contactEmail || !code) {
  await confirmations.updateRecordAsync(conf.id, { "Result": sel("INVALID") });
  return;
}

const now = new Date();

// Load PAID map for last names
const paidQuery = await paid.selectRecordsAsync({ fields: ["Last Name"] });
const lastNameByPaidId = new Map();
for (const r of paidQuery.records) {
  lastNameByPaidId.set(r.id, (r.getCellValueAsString("Last Name") || "").trim() || "UNKNOWN");
}

// Load bookings (include EXPIRED so PARTIAL works)
const bookQuery = await bookings.selectRecordsAsync({
  fields: [
    "Booking Request",
    "Booking Status",
    "Hold Expires At",
    "Hold Token",
    "Confirmation Code",
    "Held Contact Email",
    "Slot(s)",
    "Pre-Paid Reservation",
    "Booking Summary",
    "Confirmed?",
    "Confirmed At",
  ],
});

const candidates = [];
for (const b of bookQuery.records) {
  const bReq = (b.getCellValue("Booking Request") || [])[0];
  if (!bReq || bReq.id !== reqLink.id) continue;

  const bCode = (b.getCellValueAsString("Confirmation Code") || "").trim();
  if (bCode !== code) continue;

  const bHeldEmail = (b.getCellValueAsString("Held Contact Email") || "").trim();
  if (bHeldEmail && bHeldEmail.toLowerCase() !== contactEmail.toLowerCase()) continue;

  // include AWAITING + EXPIRED + CONFIRMED (for completeness)
  candidates.push(b);
}

if (candidates.length === 0) {
  await confirmations.updateRecordAsync(conf.id, { "Result": sel("INVALID") });
  return;
}

// Load slots
const slotQuery = await slots.selectRecordsAsync({
  fields: ["Status", "Start Time", "End Time", "Room", "Hold Token", "Hold Expires At", "Held By Email", "Hold Created"],
});
function roomName(slotRec) { return (slotRec.getCellValueAsString("Room") || "").trim(); }

const confirmedBookings = [];
const failedBookings = [];
const slotUpdates = [];
const bookingUpdates = [];
const paidUpdatesMap = new Map(); // paidId -> Set(slotId)

const confirmedSummary = [];
const failedSummary = [];

let confN = 0;

function addFailed(b, reason, slotRec, lastName) {
  failedBookings.push(b);
  if (slotRec) {
    const sStart = slotRec.getCellValue("Start Time") ? new Date(slotRec.getCellValue("Start Time")) : null;
    const sEnd = slotRec.getCellValue("End Time") ? new Date(slotRec.getCellValue("End Time")) : null;
    const room = roomName(slotRec);
    if (sStart && sEnd && room) {
      failedSummary.push(failLine(lastName || "UNKNOWN", room, sStart, sEnd, reason));
      return;
    }
  }
  failedSummary.push(`FAILED: ${lastName || "UNKNOWN"} — ${reason}`);
}

for (const b of candidates) {
  const status = (b.getCellValueAsString("Booking Status") || "").trim();
  const slotLink = (b.getCellValue("Slot(s)") || [])[0];
  const paidLink = (b.getCellValue("Pre-Paid Reservation") || [])[0];
  const lastName = paidLink?.id ? (lastNameByPaidId.get(paidLink.id) || "UNKNOWN") : "UNKNOWN";

  const slotRec = slotLink ? slotQuery.getRecord(slotLink.id) : null;

  // If booking already expired (manual test), count as failed
  if (status === "EXPIRED") {
    addFailed(b, "Booking was marked EXPIRED before confirmation.", slotRec, lastName);
    continue;
  }

  // If booking already confirmed, include as confirmed (don’t re-book)
  if (status === "CONFIRMED") {
    confirmedBookings.push(b);
    confN++;
    if (slotRec) {
      const sStart = new Date(slotRec.getCellValue("Start Time"));
      const sEnd = new Date(slotRec.getCellValue("End Time"));
      confirmedSummary.push(resLine(confN, lastName, roomName(slotRec), sStart, sEnd));
    }
    continue;
  }

  // Must be awaiting confirmation to attempt confirm
  if (status !== "AWAITING CONFIRMATION") {
    addFailed(b, `Booking status not eligible for confirmation: ${status}`, slotRec, lastName);
    continue;
  }

  const exp = b.getCellValue("Hold Expires At");
  if (exp && new Date(exp) < now) {
    addFailed(b, "Hold expired before confirmation.", slotRec, lastName);
    continue;
  }

  if (!slotRec) {
    addFailed(b, "Slot record not found.", null, lastName);
    continue;
  }

  const slotStatus = (slotRec.getCellValueAsString("Status") || "").trim();
  if (slotStatus !== "HELD") {
    addFailed(b, `Slot is not currently held (current status: ${slotStatus}).`, slotRec, lastName);
    continue;
  }

  // Confirm booking
  confirmedBookings.push(b);
  confN++;

  const sStart = new Date(slotRec.getCellValue("Start Time"));
  const sEnd = new Date(slotRec.getCellValue("End Time"));
  confirmedSummary.push(resLine(confN, lastName, roomName(slotRec), sStart, sEnd));

  slotUpdates.push({
    id: slotRec.id,
    fields: {
      "Status": sel("BOOKED"),
      "Hold Token": "",
      "Hold Expires At": null,
      "Held By Email": "",
      "Hold Created": null,
    }
  });

  bookingUpdates.push({
    id: b.id,
    fields: {
      "Booking Status": sel("CONFIRMED"),
      "Confirmed?": true,
      "Confirmed At": now,
      "Booking Summary": (b.getCellValueAsString("Booking Summary") || "").trim() || resLine(1, lastName, roomName(slotRec), sStart, sEnd),
    }
  });

  if (paidLink?.id) {
    if (!paidUpdatesMap.has(paidLink.id)) paidUpdatesMap.set(paidLink.id, new Set());
    paidUpdatesMap.get(paidLink.id).add(slotRec.id);
  }
}

// Apply updates
if (slotUpdates.length) await batchUpdate(slots, slotUpdates);
if (bookingUpdates.length) await batchUpdate(bookings, bookingUpdates);

// Append slot consumption to PAID ROSTER
if (paidUpdatesMap.size > 0) {
  const paidRecs = await paid.selectRecordsAsync({ fields: ["Booked Slot(s)"] });
  const paidUpdates = [];

  for (const [paidId, slotSet] of paidUpdatesMap.entries()) {
    const pr = paidRecs.getRecord(paidId);
    if (!pr) continue;

    const existing = pr.getCellValue("Booked Slot(s)") || [];
    const existingIds = new Set(existing.map(x => x.id));
    for (const sid of slotSet) existingIds.add(sid);

    paidUpdates.push({
      id: paidId,
      fields: { "Booked Slot(s)": Array.from(existingIds).map(id => ({ id })) }
    });
  }

  if (paidUpdates.length) await batchUpdate(paid, paidUpdates);
}

// Update request status
await requests.updateRecordAsync(reqLink.id, {
  "Request Status": confirmedBookings.length > 0 ? sel("CONFIRMED") : sel("EXPIRED"),
});

// Determine Result
let result;
if (confirmedBookings.length > 0 && failedBookings.length === 0) result = "VALID";
else if (confirmedBookings.length > 0 && failedBookings.length > 0) result = "PARTIAL";
else if (confirmedBookings.length === 0 && failedBookings.length > 0) result = "EXPIRED";
else result = "INVALID";

const confirmedLinks = confirmedBookings.map(b => ({ id: b.id }));
const failedLinks = failedBookings.map(b => ({ id: b.id }));
const allLinks = [...confirmedLinks, ...failedLinks];

const holdToken = (confirmedBookings[0]?.getCellValueAsString("Hold Token") || "").trim()
  || (failedBookings[0]?.getCellValueAsString("Hold Token") || "").trim()
  || "";

await confirmations.updateRecordAsync(conf.id, {
  "Result": sel(result),
  "Booking": allLinks,
  "Confirmed Booking(s)": confirmedLinks,
  "Failed Booking(s)": failedLinks,
  "Hold Token": holdToken,
  "Booking Summary": confirmedSummary.join("\n"),
  "Failed Booking Summary": failedSummary.join("\n"),
});

console.log(`RRS-3 complete: result=${result}, confirmed=${confirmedBookings.length}, failed=${failedBookings.length}`);
