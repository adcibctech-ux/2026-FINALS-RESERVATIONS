/**
 * RRS-3-Confirmations-v1.14.26
 *
 * BUG FIX:
 * - Prevent auto-rematch from selecting any slot that belongs to ANY booking the user selected to confirm
 *   in this same confirmation submission, even if that booking is processed later in the loop.
 *   This eliminates rematching into "already-confirmed" (or about-to-be-confirmed) slots.
 *
 * FAILED = stolen slot
 * EXPIRED = timed out (no rematch)
 * Rematch creates new MATCHED bookings + sets slot Status=HELD for 15 minutes + triggers BOOKING REQUESTS rematch email.
 */

const cfg = input.config();
const confirmationRecordId = cfg.recordId;

const CONF_TABLE  = "CONFIRMATIONS";
const REQ_TABLE   = "BOOKING REQUESTS";
const BOOK_TABLE  = "BOOKINGS";
const SLOTS_TABLE = "SLOTS (Operational)";
const PAID_TABLE  = "PAID ROSTER";

const confirmations = base.getTable(CONF_TABLE);
const requests      = base.getTable(REQ_TABLE);
const bookings      = base.getTable(BOOK_TABLE);
const slots         = base.getTable(SLOTS_TABLE);
const paid          = base.getTable(PAID_TABLE);

function sel(name){ return { name }; }

// ---- TZ-safe formatting ----
const TZ = "America/New_York";
const fmtMD   = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "numeric", day: "numeric" });
const fmtTime = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });
function md(d){ return fmtMD.format(d); }
function tm(d){ return fmtTime.format(d); }

function summaryLine(bookingId, lastName, room, start, end){
  return `${bookingId} // ${lastName} // ${room} // ${md(start)} // ${tm(start)} - ${tm(end)} (EST)`;
}
function failLine(bookingId, lastName, room, start, end, reason){
  return `${bookingId} // ${lastName} // ${room} // ${md(start)} // ${tm(start)} - ${tm(end)} (EST) — ${reason}`;
}

function randomToken(len=12){
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out="";
  for(let i=0;i<len;i++) out+=chars[Math.floor(Math.random()*chars.length)];
  return out;
}

function safeField(table, name){ try { return table.getField(name); } catch { return null; } }
function requireField(table, name){
  if(!safeField(table,name)) throw new Error(`Missing required field "${name}" in table "${table.name}"`);
}

requireField(slots, "Temp Hold Token");
requireField(slots, "Temp Hold Expires At");
requireField(slots, "Temp Hold Email");
requireField(bookings, "Auto Rematch Attempted?");
requireField(confirmations, "New Match Booking(s)");
requireField(confirmations, "New Match Summary");
requireField(requests, "Rematch Email Needed");
requireField(requests, "Rematch Summary");
requireField(requests, "Rematch Email Sent At");

const HAS_REMATCH_LINK = !!safeField(bookings, "Auto Rematch From Booking");
const HAS_REQ_BOOKINGS = !!safeField(requests, "BOOKINGS");
const HAS_REQ_MATCH_EXPIRES = !!safeField(requests, "Match Expires At");

// ---- merge updates by id ----
function mergeUpdates(updates) {
  const m = new Map();
  for (const u of updates) {
    if (!u?.id) continue;
    const prev = m.get(u.id);
    if (!prev) m.set(u.id, { id: u.id, fields: { ...(u.fields || {}) } });
    else m.set(u.id, { id: u.id, fields: { ...(prev.fields || {}), ...(u.fields || {}) } });
  }
  return Array.from(m.values());
}
async function batchUpdate(table, updates){
  const merged = mergeUpdates(updates);
  const CHUNK=50;
  for(let i=0;i<merged.length;i+=CHUNK){
    await table.updateRecordsAsync(merged.slice(i,i+CHUNK));
  }
}
async function batchCreate(table, records){
  const CHUNK=50;
  const ids=[];
  for(let i=0;i<records.length;i+=CHUNK){
    const created=await table.createRecordsAsync(records.slice(i,i+CHUNK));
    ids.push(...created);
  }
  return ids;
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
    "Booking Summary",
    "Failed Booking Summary",
    "New Match Booking(s)",
    "New Match Summary",
  ],
});
const conf = confQuery.getRecord(confirmationRecordId);
if(!conf) throw new Error(`CONFIRMATIONS record not found: ${confirmationRecordId}`);

if(!conf.getCellValue("Confirmation Agreement")){
  await confirmations.updateRecordAsync(conf.id, { "Result": sel("INVALID") });
  return;
}

const reqLink = (conf.getCellValue("Booking Request")||[])[0];
const contactEmail = (conf.getCellValueAsString("Contact Email")||"").trim();
const code = (conf.getCellValueAsString("Confirmation Code")||"").trim();
const pickedBookings = conf.getCellValue("Bookings To Confirm")||[];

if(!reqLink || !contactEmail || !code){
  await confirmations.updateRecordAsync(conf.id, { "Result": sel("INVALID") });
  return;
}
if(pickedBookings.length===0){
  await confirmations.updateRecordAsync(conf.id,{
    "Result": sel("INVALID"),
    "Failed Booking Summary":"No bookings were selected to confirm.",
    "New Match Booking(s)": [],
    "New Match Summary": "",
  });
  return;
}

const now = new Date();
const pickedIds = new Set(pickedBookings.map(b=>b.id));

// ------------------ Load request ------------------
const reqQuery = await requests.selectRecordsAsync({ fields:[
  "Requested Slot(s)",
  "Backup Slot(s)",
  ...(HAS_REQ_BOOKINGS?["BOOKINGS"]:[]),
  "Rematch Email Needed",
  "Rematch Summary",
  "Rematch Email Sent At",
  ...(HAS_REQ_MATCH_EXPIRES?["Match Expires At"]:[]),
]});
const reqRec = reqQuery.getRecord(reqLink.id);
if(!reqRec) throw new Error(`BOOKING REQUESTS record not found: ${reqLink.id}`);

const candidateSlotOrder = [
  ...(reqRec.getCellValue("Requested Slot(s)") || []),
  ...(reqRec.getCellValue("Backup Slot(s)") || []),
];

// ------------------ PAID last names ------------------
const paidQuery = await paid.selectRecordsAsync({ fields:["Last Name"] });
const lastNameByPaidId = new Map();
for(const r of paidQuery.records){
  lastNameByPaidId.set(r.id, (r.getCellValueAsString("Last Name")||"").trim() || "UNKNOWN");
}

// ------------------ Load bookings for this request/code/email ------------------
const bookingQuery = await bookings.selectRecordsAsync({
  fields: [
    "Booking ID",
    "Booking Request",
    "Booking Status",
    "Match Expires At",
    "Match Token",
    "Confirmation Code",
    "Held Contact Email",
    "Slot(s)",
    "Pre-Paid Reservation",
    "Studio",
    "Auto Rematch Attempted?",
  ],
});

const selectedCandidates = [];
const toCancel = [];

// slots already confirmed by same request/code/email
const alreadyConfirmedSlotIds = new Set();

for(const b of bookingQuery.records){
  const bReq = (b.getCellValue("Booking Request")||[])[0];
  if(!bReq || bReq.id!==reqLink.id) continue;

  const bCode = (b.getCellValueAsString("Confirmation Code")||"").trim();
  if(bCode!==code) continue;

  const bHeldEmail = (b.getCellValueAsString("Held Contact Email")||"").trim();
  if(bHeldEmail && bHeldEmail.toLowerCase()!==contactEmail.toLowerCase()) continue;

  const bStatus = (b.getCellValueAsString("Booking Status")||"").trim();

  if(bStatus === "CONFIRMED"){
    const sl = (b.getCellValue("Slot(s)")||[])[0];
    if(sl?.id) alreadyConfirmedSlotIds.add(sl.id);
  }

  if(pickedIds.has(b.id)) selectedCandidates.push(b);
  else if(bStatus==="MATCHED") toCancel.push(b);
}

if(selectedCandidates.length===0){
  await confirmations.updateRecordAsync(conf.id,{ "Result": sel("INVALID") });
  return;
}

// ✅ NEW: exclude ALL slots belonging to the selected bookings (regardless of loop order)
const selectedSlotIds = new Set();
for (const b of selectedCandidates) {
  const sl = (b.getCellValue("Slot(s)") || [])[0];
  if (sl?.id) selectedSlotIds.add(sl.id);
}

// ------------------ Load slots ------------------
const slotQuery = await slots.selectRecordsAsync({
  fields: ["Status","Start Time","End Time","Room","Temp Hold Token","Temp Hold Expires At","Temp Hold Email"],
});
function roomName(slotRec){ return (slotRec.getCellValueAsString("Room")||"").trim(); }
function statusOf(slotRec){ return (slotRec.getCellValueAsString("Status")||"").trim(); }

function isSlotAvailableForBooking(slotRec, bookingMatchToken){
  const st = statusOf(slotRec);

  if(st !== "AVAILABLE" && st !== "HELD") return false;

  if(st === "HELD"){
    const tok = (slotRec.getCellValueAsString("Temp Hold Token")||"").trim();
    const exp = slotRec.getCellValue("Temp Hold Expires At");
    if(!tok || !exp) return false;
    if(new Date(exp) < now) return false;
    return tok === bookingMatchToken;
  }

  const tok = (slotRec.getCellValueAsString("Temp Hold Token")||"").trim();
  const exp = slotRec.getCellValue("Temp Hold Expires At");
  if(tok && exp && new Date(exp) >= now) return false;

  return true;
}

function isSlotEligibleForRematch(slotRec){
  if(statusOf(slotRec) !== "AVAILABLE") return false;

  // ✅ NEW: never rematch into any slot already selected to confirm this run
  if(selectedSlotIds.has(slotRec.id)) return false;

  // never rematch into a slot already confirmed by this client earlier
  if(alreadyConfirmedSlotIds.has(slotRec.id)) return false;

  const tok = (slotRec.getCellValueAsString("Temp Hold Token")||"").trim();
  const exp = slotRec.getCellValue("Temp Hold Expires At");
  if(tok && exp && new Date(exp) >= now) return false;

  return true;
}

// Seed used slots with both sets
const usedSlotIds = new Set([...alreadyConfirmedSlotIds, ...selectedSlotIds]);

// ------------------ Prepare updates ------------------
const slotUpdates = [];
const bookingUpdates = [];
const cancelUpdates = toCancel.map(b=>({ id:b.id, fields:{ "Booking Status": sel("CANCELLED") }}));

const confirmedBookings = [];
const failedBookings = [];
const confirmedSummary = [];
const failedSummary = [];

const rematchCreates = [];
const REMATCH_MINUTES = 15;

function getBookingIdStr(b){ return (b.getCellValueAsString("Booking ID")||"").trim() || b.id; }

function pickNextRematchSlot(){
  for(const sl of candidateSlotOrder){
    const s = slotQuery.getRecord(sl.id);
    if(!s) continue;
    if(usedSlotIds.has(s.id)) continue;
    if(!isSlotEligibleForRematch(s)) continue;
    return s;
  }
  return null;
}

// ------------------ Process confirmations ------------------
for(const b of selectedCandidates){
  const bookingId = getBookingIdStr(b);
  const matchToken = (b.getCellValueAsString("Match Token")||"").trim();
  const exp = b.getCellValue("Match Expires At");

  const slotLink = (b.getCellValue("Slot(s)")||[])[0];
  const paidLink = (b.getCellValue("Pre-Paid Reservation")||[])[0];
  const lastName = paidLink?.id ? (lastNameByPaidId.get(paidLink.id) || "UNKNOWN") : "UNKNOWN";
  const alreadyRematched = !!b.getCellValue("Auto Rematch Attempted?");

  const slotRec = slotLink ? slotQuery.getRecord(slotLink.id) : null;

  if(exp && new Date(exp) < now){
    failedBookings.push(b);
    if(slotRec){
      const room = roomName(slotRec);
      const sStart = new Date(slotRec.getCellValue("Start Time"));
      const sEnd   = new Date(slotRec.getCellValue("End Time"));
      failedSummary.push(failLine(bookingId, lastName, room, sStart, sEnd, "Match expired before confirmation."));
    } else {
      failedSummary.push(`${bookingId} // ${lastName} — Match expired before confirmation.`);
    }
    bookingUpdates.push({ id:b.id, fields:{ "Booking Status": sel("EXPIRED") }});
    continue;
  }

  if(!slotRec){
    failedBookings.push(b);
    failedSummary.push(`${bookingId} // ${lastName} — Slot record not found.`);
    bookingUpdates.push({ id:b.id, fields:{ "Booking Status": sel("FAILED") }});
  } else {
    const room = roomName(slotRec);
    const sStart = new Date(slotRec.getCellValue("Start Time"));
    const sEnd   = new Date(slotRec.getCellValue("End Time"));

    if(!isSlotAvailableForBooking(slotRec, matchToken)){
      const st = statusOf(slotRec);
      const reason = st === "HELD" ? "Slot is temporarily held by another confirmation." : `Slot is no longer available (status: ${st}).`;
      failedBookings.push(b);
      failedSummary.push(failLine(bookingId, lastName, room, sStart, sEnd, reason));
      bookingUpdates.push({ id:b.id, fields:{ "Booking Status": sel("FAILED") }});
    } else {
      usedSlotIds.add(slotRec.id);
      confirmedBookings.push(b);
      confirmedSummary.push(summaryLine(bookingId, lastName, room, sStart, sEnd));

      slotUpdates.push({
        id: slotRec.id,
        fields: {
          "Status": sel("BOOKED"),
          "Temp Hold Token": "",
          "Temp Hold Expires At": null,
          "Temp Hold Email": "",
        }
      });

      bookingUpdates.push({
        id:b.id,
        fields:{
          "Booking Status": sel("CONFIRMED"),
          "Confirmed?": true,
          "Confirmed At": now,
          "Booking Summary": summaryLine(bookingId, lastName, room, sStart, sEnd),
        }
      });

      continue;
    }
  }

  // Auto-rematch ONCE for FAILED only
  if(!alreadyRematched && paidLink?.id){
    const newSlot = pickNextRematchSlot();
    if(newSlot){
      usedSlotIds.add(newSlot.id);

      const newToken = `MATCH-${randomToken(12)}`;
      const newExpires = new Date(now.getTime() + REMATCH_MINUTES*60*1000);

      const studioLink = (b.getCellValue("Studio")||[])[0];
      const fields = {
        "Booking Status": sel("MATCHED"),
        "Booking Request": [{ id:reqLink.id }],
        ...(studioLink ? { "Studio":[{ id:studioLink.id }] } : {}),
        "Pre-Paid Reservation": [{ id:paidLink.id }],
        "Slot(s)": [{ id:newSlot.id }],
        "Held Contact Email": contactEmail,
        "Confirmation Code": code,
        "Match Token": newToken,
        "Match Expires At": newExpires,
        "Auto Rematch Attempted?": true,
      };
      if(HAS_REMATCH_LINK){
        fields["Auto Rematch From Booking"] = [{ id:b.id }];
      }
      rematchCreates.push({ fields });

      slotUpdates.push({
        id: newSlot.id,
        fields: {
          "Status": sel("HELD"),
          "Temp Hold Token": newToken,
          "Temp Hold Expires At": newExpires,
          "Temp Hold Email": contactEmail,
        }
      });

      bookingUpdates.push({ id:b.id, fields:{ "Auto Rematch Attempted?": true }});
    }
  }
}

// Apply updates
if(slotUpdates.length) await batchUpdate(slots, slotUpdates);
if(bookingUpdates.length) await batchUpdate(bookings, bookingUpdates);
if(cancelUpdates.length) await batchUpdate(bookings, cancelUpdates);

// Create rematch bookings + write summaries + trigger request email
let newBookingIds = [];
let newMatchLines = [];

if(rematchCreates.length){
  newBookingIds = await batchCreate(bookings, rematchCreates);

  const nbQuery = await bookings.selectRecordsAsync({ fields:["Booking ID","Slot(s)","Pre-Paid Reservation"] });
  for(const nbid of newBookingIds){
    const nb = nbQuery.getRecord(nbid);
    if(!nb) continue;

    const nbBookingId = (nb.getCellValueAsString("Booking ID")||"").trim() || nbid;
    const slotLink = (nb.getCellValue("Slot(s)")||[])[0];
    const paidLink = (nb.getCellValue("Pre-Paid Reservation")||[])[0];
    const lastName = paidLink?.id ? (lastNameByPaidId.get(paidLink.id) || "UNKNOWN") : "UNKNOWN";

    const s = slotLink ? slotQuery.getRecord(slotLink.id) : null;
    if(!s) continue;

    const room = roomName(s);
    const sStart = new Date(s.getCellValue("Start Time"));
    const sEnd   = new Date(s.getCellValue("End Time"));

    newMatchLines.push(summaryLine(nbBookingId, lastName, room, sStart, sEnd));
  }

  if(HAS_REQ_BOOKINGS){
    const existingReqBookings = reqRec.getCellValue("BOOKINGS") || [];
    const existingIds = new Set(existingReqBookings.map(x=>x.id));
    for(const id of newBookingIds) existingIds.add(id);
    await requests.updateRecordAsync(reqRec.id, { "BOOKINGS": Array.from(existingIds).map(id=>({ id })) });
  }

  const reqUpdate = {
    "Rematch Email Needed": true,
    "Rematch Summary": newMatchLines.join("\n"),
    "Rematch Email Sent At": null,
  };
  if(HAS_REQ_MATCH_EXPIRES){
    reqUpdate["Match Expires At"] = new Date(now.getTime() + REMATCH_MINUTES*60*1000);
  }
  await requests.updateRecordAsync(reqRec.id, reqUpdate);
}

let result;
if(confirmedBookings.length>0 && failedBookings.length===0 && newBookingIds.length===0) result="VALID";
else if(confirmedBookings.length>0 && (failedBookings.length>0 || newBookingIds.length>0)) result="PARTIAL";
else if(confirmedBookings.length===0 && (failedBookings.length>0 || newBookingIds.length>0)) result="PARTIAL";
else result="INVALID";

await confirmations.updateRecordAsync(conf.id,{
  "Result": sel(result),
  "Booking Summary": confirmedSummary.join("\n"),
  "Failed Booking Summary": failedSummary.join("\n"),
  "New Match Booking(s)": newBookingIds.map(id=>({ id })),
  "New Match Summary": newMatchLines.join("\n"),
});

console.log(`RRS-3 v1.14.26 complete: confirmed=${confirmedBookings.length} failed=${failedBookings.length} rematches=${newBookingIds.length}`);
