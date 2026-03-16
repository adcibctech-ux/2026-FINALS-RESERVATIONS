/**
 * RRS-3-Confirmations-v1.7.26
 * CONFIRMATIONS -> Confirm selected bookings only (record picker) + book slots if still AVAILABLE
 *
 * BUG FIXES:
 * - Fix summary time formatting to America/New_York using Intl.DateTimeFormat (prevents UTC +4hr shift).
 *
 * BEHAVIOR:
 * - Confirms only {Bookings To Confirm} selected in form.
 * - If now > {Match Expires At} -> booking EXPIRED + failed.
 * - Else if slot Status == AVAILABLE -> slot BOOKED + booking CONFIRMED.
 * - Else -> booking FAILED (someone else booked first).
 * - Writes Result = VALID/PARTIAL/EXPIRED/INVALID.
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

// ---- TIMEZONE SAFE FORMATTERS (America/New_York) ----
const TZ = "America/New_York";

const fmtDateNY = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  month: "2-digit",
  day: "2-digit",
  year: "2-digit",
});

const fmtTimeNY = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

function dateStr(d) { return fmtDateNY.format(d); } // MM/DD/YY
function timeStr(d) { return fmtTimeNY.format(d); } // 9:30 AM

function resLine(n, lastName, room, start, end) {
  return `RESERVATION ${n}: ${lastName} // ${room} // ${dateStr(start)} // ${timeStr(start)} - ${timeStr(end)} (EST)`;
}
function failLine(lastName, room, start, end, reason) {
  return `FAILED: ${lastName} // ${room} // ${dateStr(start)} // ${timeStr(start)} - ${timeStr(end)} (EST) — ${reason}`;
}

async function batchUpdate(table, updates) {
  const CHUNK = 50;
  for (let i = 0; i < updates.length; i += CHUNK) {
    await table.updateRecordsAsync(updates.slice(i, i + CHUNK));
  }
}

// ------------------ Load confirmation ------------------
const confQuery = await confirmations.selectRecordsAsync({
  fields: [
    "Booking Request",
    "Contact Email",
    "Confirmation Code",
    "Confirmation Agreement",
    "Bookings To Confirm",
    "Result",
    "Booking",
    "Confirmed Booking(s)",
    "Failed Booking(s)",
    "Booking Summary",
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
const pickedBookings = conf.getCellValue("Bookings To Confirm") || [];

if (!reqLink || !contactEmail || !code) {
  await confirmations.updateRecordAsync(conf.id, { "Result": sel("INVALID") });
  return;
}
if (pickedBookings.length === 0) {
  await confirmations.updateRecordAsync(conf.id, {
    "Result": sel("INVALID"),
    "Failed Booking Summary": "No bookings were selected to confirm. Please select at least one Booking ID and resubmit the confirmation form.",
  });
  return;
}

const now = new Date();

// ------------------ Load PAID last names ------------------
const paidQuery = await paid.selectRecordsAsync({ fields: ["Last Name"] });
const lastNameByPaidId = new Map();
for (const r of paidQuery.records) {
  lastNameByPaidId.set(r.id, (r.getCellValueAsString("Last Name") || "").trim() || "UNKNOWN");
}

// ------------------ Load bookings ------------------
const bookingQuery = await bookings.selectRecordsAsync({
  fields: [
    "Booking Request",
    "Booking Status",
    "Match Expires At",
    "Match Token",
    "Confirmation Code",
    "Held Contact Email",
    "Slot(s)",
    "Pre-Paid Reservation",
    "Booking Summary",
    "Confirmed?",
    "Confirmed At",
  ],
});

const pickedIds = new Set(pickedBookings.map(b => b.id));
const candidates = [];

for (const b of bookingQuery.records) {
  if (!pickedIds.has(b.id)) continue;

  const bReq = (b.getCellValue("Booking Request") || [])[0];
  if (!bReq || bReq.id !== reqLink.id) continue;

  const bCode = (b.getCellValueAsString("Confirmation Code") || "").trim();
  if (bCode !== code) continue;

  const bHeldEmail = (b.getCellValueAsString("Held Contact Email") || "").trim();
  if (bHeldEmail && bHeldEmail.toLowerCase() !== contactEmail.toLowerCase()) continue;

  candidates.push(b);
}

if (candidates.length === 0) {
  await confirmations.updateRecordAsync(conf.id, { "Result": sel("INVALID") });
  return;
}

// ------------------ Load slots ------------------
const slotQuery = await slots.selectRecordsAsync({
  fields: ["Status", "Start Time", "End Time", "Room"],
});
function roomName(slotRec) { return (slotRec.getCellValueAsString("Room") || "").trim(); }

// ------------------ Process confirmations ------------------
const slotUpdates = [];
const bookingUpdates = [];

const confirmedBookings = [];
const failedBookings = [];

const confirmedSummary = [];
const failedSummary = [];

let confN = 0;

for (const b of candidates) {
  const exp = b.getCellValue("Match Expires At");
  const slotLink = (b.getCellValue("Slot(s)") || [])[0];
  const paidLink = (b.getCellValue("Pre-Paid Reservation") || [])[0];
  const lastName = paidLink?.id ? (lastNameByPaidId.get(paidLink.id) || "UNKNOWN") : "UNKNOWN";

  // Expired match window
  if (exp && new Date(exp) < now) {
    failedBookings.push(b);
    bookingUpdates.push({ id: b.id, fields: { "Booking Status": sel("EXPIRED") } });

    if (slotLink) {
      const slotRec = slotQuery.getRecord(slotLink.id);
      if (slotRec) {
        const sStart = new Date(slotRec.getCellValue("Start Time"));
        const sEnd = new Date(slotRec.getCellValue("End Time"));
        failedSummary.push(failLine(lastName, roomName(slotRec), sStart, sEnd, "Match expired before confirmation."));
      } else {
        failedSummary.push(`FAILED: ${lastName} — Match expired before confirmation.`);
      }
    } else {
      failedSummary.push(`FAILED: ${lastName} — Match expired before confirmation.`);
    }

    continue;
  }

  if (!slotLink) {
    failedBookings.push(b);
    failedSummary.push(`FAILED: ${lastName} — Booking has no linked slot.`);
    bookingUpdates.push({ id: b.id, fields: { "Booking Status": sel("FAILED") } });
    continue;
  }

  const slotRec = slotQuery.getRecord(slotLink.id);
  if (!slotRec) {
    failedBookings.push(b);
    failedSummary.push(`FAILED: ${lastName} — Slot record not found.`);
    bookingUpdates.push({ id: b.id, fields: { "Booking Status": sel("FAILED") } });
    continue;
  }

  const sStart = new Date(slotRec.getCellValue("Start Time"));
  const sEnd = new Date(slotRec.getCellValue("End Time"));
  const room = roomName(slotRec);

  const slotStatus = (slotRec.getCellValueAsString("Status") || "").trim();
  if (slotStatus !== "AVAILABLE") {
    failedBookings.push(b);
    failedSummary.push(failLine(lastName, room, sStart, sEnd, `Slot is no longer available (current status: ${slotStatus}).`));
    bookingUpdates.push({ id: b.id, fields: { "Booking Status": sel("FAILED") } });
    continue;
  }

  // SUCCESS: book slot + confirm booking
  confirmedBookings.push(b);
  confN++;
  confirmedSummary.push(resLine(confN, lastName, room, sStart, sEnd));

  slotUpdates.push({ id: slotRec.id, fields: { "Status": sel("BOOKED") } });

  bookingUpdates.push({
    id: b.id,
    fields: {
      "Booking Status": sel("CONFIRMED"),
      "Confirmed?": true,
      "Confirmed At": now,
      // per booking summary stays readable (no RESERVATION prefix)
      "Booking Summary": (b.getCellValueAsString("Booking Summary") || "").trim() ||
        `${lastName} // ${room} // ${dateStr(sStart)} // ${timeStr(sStart)} - ${timeStr(sEnd)} (EST)`,
    }
  });
}

// Apply updates
if (slotUpdates.length) await batchUpdate(slots, slotUpdates);
if (bookingUpdates.length) await batchUpdate(bookings, bookingUpdates);

// Optional: update request status if any confirmed
await requests.updateRecordAsync(reqLink.id, { "Request Status": sel("CONFIRMED") }).catch(() => {});

// Result
let result;
if (confirmedBookings.length > 0 && failedBookings.length === 0) result = "VALID";
else if (confirmedBookings.length > 0 && failedBookings.length > 0) result = "PARTIAL";
else if (confirmedBookings.length === 0 && failedBookings.length > 0) result = "EXPIRED";
else result = "INVALID";

const confirmedLinks = confirmedBookings.map(b => ({ id: b.id }));
const failedLinks = failedBookings.map(b => ({ id: b.id }));
const allLinks = [...confirmedLinks, ...failedLinks];

await confirmations.updateRecordAsync(conf.id, {
  "Result": sel(result),
  "Booking": allLinks,
  "Confirmed Booking(s)": confirmedLinks,
  "Failed Booking(s)": failedLinks,
  "Booking Summary": confirmedSummary.join("\n"),
  "Failed Booking Summary": failedSummary.join("\n"),
});

console.log(`RRS-3 v1.7.26 complete: result=${result}, confirmed=${confirmedBookings.length}, failed=${failedBookings.length}`);
