/**
 * RRS-6-Refunds-v1.0.26
 * REFUND REQUESTS (new) -> Block duplicates + auto-link evidence (Booking + Booking Request(s)) + reciprocally link cancellation if present
 *
 * BUG FIXES: N/A
 *
 * BEHAVIOR:
 * - Trigger: When REFUND REQUESTS record is created.
 * - Duplicate protection:
 *    - If another REFUND REQUEST exists for the same {Pre-Paid Reservation} and its {Refund Status} is NOT
 *      "NOT PROCESSED - EXISTING REQ", then this new record is marked:
 *         {Refund Status} = "NOT PROCESSED - EXISTING REQ"
 *      and the script exits.
 * - Otherwise:
 *    - If {Refund Status} is blank -> sets to "NEW"
 *    - Links {Booking} to the best matching booking for that paid roster record:
 *        1) Prefer Booking Status = CONFIRMED
 *        2) Else AWAITING CONFIRMATION
 *        3) Else most recent (Confirmed At, else Created At)
 *    - Links {Booking Request(s)} from PAID ROSTER -> {Requested Bookings}
 *    - Reciprocal cancellation linking:
 *        - If a cancellation exists for the same Booking (preferred) or same Pre-Paid Reservation,
 *          links it to {Cancellation Request} and sets {Submitted Cancellation Request?}="YES".
 *        - Also updates that cancellation record to link back to this refund request and sets {Submitted Refund Request?}="YES".
 */

const cfg = input.config();
const refundId = cfg.recordId;

const REFUNDS_TABLE = "REFUND REQUESTS";
const PAID_TABLE = "PAID ROSTER";
const BOOKINGS_TABLE = "BOOKINGS";
const CANCELS_TABLE = "CANCELLATION REQUESTS";

const refunds = base.getTable(REFUNDS_TABLE);
const paid = base.getTable(PAID_TABLE);
const bookings = base.getTable(BOOKINGS_TABLE);
const cancels = base.getTable(CANCELS_TABLE);

function sel(name) { return { name }; }

if (!refundId) throw new Error('Missing input "recordId".');

// ----- Load refund request -----
const refundQuery = await refunds.selectRecordsAsync({
  fields: [
    "Pre-Paid Reservation",
    "Refund Status",
    "Booking",
    "Booking Request(s)",
    "Submitted Cancellation Request?",
    "Cancellation Request",
  ],
});
const rr = refundQuery.getRecord(refundId);
if (!rr) throw new Error(`REFUND REQUESTS record not found: ${refundId}`);

const paidLink = (rr.getCellValue("Pre-Paid Reservation") || [])[0];
if (!paidLink) return;

// ----- DUPLICATE CHECK (by Pre-Paid Reservation) -----
const allRefunds = await refunds.selectRecordsAsync({
  fields: ["Pre-Paid Reservation", "Refund Status"],
});

for (const r of allRefunds.records) {
  if (r.id === rr.id) continue;
  const p = (r.getCellValue("Pre-Paid Reservation") || [])[0];
  if (!p || p.id !== paidLink.id) continue;

  const st = (r.getCellValueAsString("Refund Status") || "").trim();
  if (st && st !== "NOT PROCESSED - EXISTING REQ") {
    await refunds.updateRecordAsync(rr.id, { "Refund Status": sel("NOT PROCESSED - EXISTING REQ") });
    return;
  }
}

// ----- Default status NEW if blank -----
const update = {};
const currentStatus = (rr.getCellValueAsString("Refund Status") || "").trim();
if (!currentStatus) update["Refund Status"] = sel("NEW");

// ----- Pull booking requests from PAID ROSTER (backlink) -----
const paidQuery = await paid.selectRecordsAsync({ fields: ["Requested Bookings"] });
const pr = paidQuery.getRecord(paidLink.id);
const reqLinks = (pr?.getCellValue("Requested Bookings") || []).map(x => ({ id: x.id }));
if (reqLinks.length) update["Booking Request(s)"] = reqLinks;

// ----- Choose best booking for this Pre-Paid Reservation -----
const bookingQuery = await bookings.selectRecordsAsync({
  fields: ["Pre-Paid Reservation", "Booking Status", "Created At", "Confirmed At"],
});

const candidates = [];
for (const b of bookingQuery.records) {
  const pl = (b.getCellValue("Pre-Paid Reservation") || [])[0];
  if (!pl || pl.id !== paidLink.id) continue;

  const status = (b.getCellValueAsString("Booking Status") || "").trim();
  const createdAt = b.getCellValue("Created At") ? new Date(b.getCellValue("Created At")) : null;
  const confirmedAt = b.getCellValue("Confirmed At") ? new Date(b.getCellValue("Confirmed At")) : null;

  candidates.push({ id: b.id, status, createdAt, confirmedAt });
}

function rankStatus(s) {
  if (s === "CONFIRMED") return 3;
  if (s === "AWAITING CONFIRMATION") return 2;
  if (s === "EXPIRED") return 1;
  return 0;
}

candidates.sort((a, b) => {
  const rs = rankStatus(b.status) - rankStatus(a.status);
  if (rs !== 0) return rs;
  const atA = (a.confirmedAt || a.createdAt || new Date(0)).getTime();
  const atB = (b.confirmedAt || b.createdAt || new Date(0)).getTime();
  return atB - atA;
});

const bestBookingId = candidates.length ? candidates[0].id : null;
if (bestBookingId) update["Booking"] = [{ id: bestBookingId }];

// ----- Reciprocal cancellation linking (prefer match by Booking, else Paid) -----
const cancelQuery = await cancels.selectRecordsAsync({
  fields: ["Cancellation Status", "Booking", "Pre-Paid Reservation", "Refund Request", "Submitted Refund Request?"],
});

let matchedCancel = null;
for (const c of cancelQuery.records) {
  const cStatus = (c.getCellValueAsString("Cancellation Status") || "").trim();
  if (cStatus === "NOT PROCESSED - EXISTING REQ") continue;

  if (bestBookingId) {
    const bLink = (c.getCellValue("Booking") || [])[0];
    if (bLink && bLink.id === bestBookingId) { matchedCancel = c; break; }
  }
}

if (!matchedCancel) {
  for (const c of cancelQuery.records) {
    const cStatus = (c.getCellValueAsString("Cancellation Status") || "").trim();
    if (cStatus === "NOT PROCESSED - EXISTING REQ") continue;

    const pLink = (c.getCellValue("Pre-Paid Reservation") || [])[0];
    if (pLink && pLink.id === paidLink.id) { matchedCancel = c; break; }
  }
}

if (matchedCancel) {
  update["Cancellation Request"] = [{ id: matchedCancel.id }];
  update["Submitted Cancellation Request?"] = sel("YES");

  await cancels.updateRecordAsync(matchedCancel.id, {
    "Refund Request": [{ id: rr.id }],
    "Submitted Refund Request?": sel("YES"),
  }).catch(() => {});
}

if (Object.keys(update).length) {
  await refunds.updateRecordAsync(rr.id, update);
}
