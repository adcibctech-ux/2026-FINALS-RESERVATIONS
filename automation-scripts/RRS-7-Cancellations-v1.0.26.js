/**
 * RRS-7-Cancellations-v1.0.26
 * CANCELLATION REQUESTS (new) -> Block duplicates + reciprocally link refund request if present
 *
 * BUG FIXES: N/A
 *
 * BEHAVIOR:
 * - Trigger: When CANCELLATION REQUESTS record is created.
 * - Duplicate protection:
 *    - If another cancellation exists for the same {Booking} OR same {Pre-Paid Reservation}
 *      and its {Cancellation Status} is NOT "NOT PROCESSED - EXISTING REQ",
 *      then this record is marked:
 *         {Cancellation Status} = "NOT PROCESSED - EXISTING REQ"
 *      and exits.
 * - Otherwise:
 *    - If {Cancellation Status} is blank -> sets to "NEW"
 *    - Attempts to find an existing refund request for the same Pre-Paid Reservation:
 *        - Chooses the first refund request whose {Refund Status} is not "NOT PROCESSED - EXISTING REQ"
 *        - Links it on the cancellation:
 *            {Refund Request} = refund
 *            {Submitted Refund Request?} = "YES"
 *        - Also updates the refund request:
 *            {Cancellation Request} = this cancellation
 *            {Submitted Cancellation Request?} = "YES"
 */

const cfg = input.config();
const cancelId = cfg.recordId;

const CANCELS_TABLE = "CANCELLATION REQUESTS";
const REFUNDS_TABLE = "REFUND REQUESTS";

const cancels = base.getTable(CANCELS_TABLE);
const refunds = base.getTable(REFUNDS_TABLE);

function sel(name) { return { name }; }

if (!cancelId) throw new Error('Missing input "recordId".');

// ----- Load cancellation -----
const cancelQuery = await cancels.selectRecordsAsync({
  fields: [
    "Pre-Paid Reservation",
    "Booking",
    "Cancellation Status",
    "Submitted Refund Request?",
    "Refund Request",
  ],
});
const cr = cancelQuery.getRecord(cancelId);
if (!cr) throw new Error(`CANCELLATION REQUESTS record not found: ${cancelId}`);

const paidLink = (cr.getCellValue("Pre-Paid Reservation") || [])[0];
const bookingLink = (cr.getCellValue("Booking") || [])[0];

if (!paidLink && !bookingLink) return;

// ----- DUPLICATE CHECK -----
for (const c of cancelQuery.records) {
  if (c.id === cr.id) continue;

  const st = (c.getCellValueAsString("Cancellation Status") || "").trim();
  if (st === "NOT PROCESSED - EXISTING REQ") continue;

  const cb = (c.getCellValue("Booking") || [])[0];
  const cp = (c.getCellValue("Pre-Paid Reservation") || [])[0];

  if (bookingLink && cb && cb.id === bookingLink.id) {
    await cancels.updateRecordAsync(cr.id, { "Cancellation Status": sel("NOT PROCESSED - EXISTING REQ") });
    return;
  }

  if (paidLink && cp && cp.id === paidLink.id) {
    await cancels.updateRecordAsync(cr.id, { "Cancellation Status": sel("NOT PROCESSED - EXISTING REQ") });
    return;
  }
}

// ----- Default status NEW if blank -----
const currentStatus = (cr.getCellValueAsString("Cancellation Status") || "").trim();
if (!currentStatus) {
  await cancels.updateRecordAsync(cr.id, { "Cancellation Status": sel("NEW") }).catch(() => {});
}

// ----- Find matching refund request for same paid roster -----
const refundQuery = await refunds.selectRecordsAsync({
  fields: [
    "Pre-Paid Reservation",
    "Refund Status",
    "Submitted Cancellation Request?",
    "Cancellation Request",
  ],
});

let bestRefund = null;
for (const r of refundQuery.records) {
  const p = (r.getCellValue("Pre-Paid Reservation") || [])[0];
  if (!p || p.id !== paidLink.id) continue;

  const st = (r.getCellValueAsString("Refund Status") || "").trim();
  if (st === "NOT PROCESSED - EXISTING REQ") continue;

  bestRefund = r;
  break;
}

if (!bestRefund) return;

// ----- Reciprocal linking -----
await cancels.updateRecordAsync(cr.id, {
  "Refund Request": [{ id: bestRefund.id }],
  "Submitted Refund Request?": sel("YES"),
}).catch(() => {});

await refunds.updateRecordAsync(bestRefund.id, {
  "Cancellation Request": [{ id: cr.id }],
  "Submitted Cancellation Request?": sel("YES"),
}).catch(() => {});
