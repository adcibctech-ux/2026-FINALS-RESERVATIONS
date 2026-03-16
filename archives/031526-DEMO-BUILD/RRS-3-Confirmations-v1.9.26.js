/**
 * RRS-3-Confirmations-v1.9.26
 * CONFIRMATIONS -> Confirm selected bookings + auto-rematch once with HELD status on auto-rematch slot
 *
 * BUG FIXES:
 * - FAILED = stolen slot (slot not AVAILABLE at confirm time)
 * - EXPIRED = timed out (now > Match Expires At)
 * - Auto-rematch creates NEW booking (MATCHED) and sets rematch slot Status=HELD for 15 min (calendar-visible)
 * - Auto-rematch happens at most once using {Auto Rematch Attempted?}
 * - Enforces rematch hold: if slot is HELD with Temp Hold Token != booking Match Token -> treated as unavailable
 *
 * SUMMARY FORMAT:
 * {Booking ID} // {LAST NAME} // {Room} // {M-D} // {Start} - {End} (EST)
 */

const cfg = input.config();
const confirmationRecordId = cfg.recordId;

const CONF_TABLE = "CONFIRMATIONS";
const REQ_TABLE  = "BOOKING REQUESTS";
const BOOK_TABLE = "BOOKINGS";
const SLOTS_TABLE= "SLOTS (Operational)";
const PAID_TABLE = "PAID ROSTER";

const confirmations = base.getTable(CONF_TABLE);
const requests      = base.getTable(REQ_TABLE);
const bookings      = base.getTable(BOOK_TABLE);
const slots         = base.getTable(SLOTS_TABLE);
const paid          = base.getTable(PAID_TABLE);

function sel(name){ return { name }; }

// ---- TZ-safe formatting (America/New_York) ----
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

async function batchUpdate(table, updates){
  const CHUNK=50;
  for(let i=0;i<updates.length;i+=CHUNK){
    await table.updateRecordsAsync(updates.slice(i,i+CHUNK));
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

function safeField(table, name){ try { return table.getField(name); } catch { return null; } }
function requireField(table, name){
  const f = safeField(table, name);
  if(!f) throw new Error(`Missing required field "${name}" in table "${table.name}"`);
  return name;
}

// Required fields for this version:
requireField(slots, "Temp Hold Token");
requireField(slots, "Temp Hold Expires At");
requireField(slots, "Temp Hold Email"); // you added it
requireField(bookings, "Auto Rematch Attempted?");

// Optional link (nice audit trail)
const HAS_REMATCH_LINK = !!safeField(bookings, "Auto Rematch From Booking");

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
    "Failed Booking Summary":"No bookings were selected to confirm. Please select at least one Booking ID and resubmit the confirmation form."
  });
  return;
}

const now = new Date();
const pickedIds = new Set(pickedBookings.map(b=>b.id));

// ------------------ Load request: Requested + Backup slot lists ------------------
const reqQuery = await requests.selectRecordsAsync({ fields:["Requested Slot(s)","Backup Slot(s)"] });
const reqRec = reqQuery.getRecord(reqLink.id);
if(!reqRec) throw new Error(`BOOKING REQUESTS record not found: ${reqLink.id}`);

const requestedSlots = reqRec.getCellValue("Requested Slot(s)") || [];
const backupSlots    = reqRec.getCellValue("Backup Slot(s)")    || [];
const candidateSlotOrder = [...requestedSlots, ...backupSlots];

// ------------------ PAID last names ------------------
const paidQuery = await paid.selectRecordsAsync({ fields:["Last Name"] });
const lastNameByPaidId = new Map();
for(const r of paidQuery.records){
  lastNameByPaidId.set(r.id, (r.getCellValueAsString("Last Name")||"").trim() || "UNKNOWN");
}

// ------------------ Load bookings ------------------
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

// Gather selected candidates + cancel list
const selectedCandidates = [];
const toCancel = [];

for(const b of bookingQuery.records){
  const bReq = (b.getCellValue("Booking Request")||[])[0];
  if(!bReq || bReq.id!==reqLink.id) continue;

  const bCode = (b.getCellValueAsString("Confirmation Code")||"").trim();
  if(bCode!==code) continue;

  const bHeldEmail = (b.getCellValueAsString("Held Contact Email")||"").trim();
  if(bHeldEmail && bHeldEmail.toLowerCase()!==contactEmail.toLowerCase()) continue;

  const bStatus = (b.getCellValueAsString("Booking Status")||"").trim();

  if(pickedIds.has(b.id)) selectedCandidates.push(b);
  else if(bStatus==="MATCHED") toCancel.push(b);
}

if(selectedCandidates.length===0){
  await confirmations.updateRecordAsync(conf.id,{ "Result": sel("INVALID") });
  return;
}

// ------------------ Load slots (includes HELD + temp hold fields) ------------------
const slotQuery = await slots.selectRecordsAsync({
  fields: ["Status","Start Time","End Time","Room","Temp Hold Token","Temp Hold Expires At","Temp Hold Email"],
});
function roomName(slotRec){ return (slotRec.getCellValueAsString("Room")||"").trim(); }
function statusOf(slotRec){ return (slotRec.getCellValueAsString("Status")||"").trim(); }

function isSlotAvailableForBooking(slotRec, bookingMatchToken){
  const st = statusOf(slotRec);

  // BOOKED or BLOCKED etc
  if(st !== "AVAILABLE" && st !== "HELD") return false;

  // If HELD, only available to the booking whose Match Token matches the Temp Hold Token and hold is unexpired
  if(st === "HELD"){
    const tok = (slotRec.getCellValueAsString("Temp Hold Token")||"").trim();
    const exp = slotRec.getCellValue("Temp Hold Expires At");
    if(!tok || !exp) return false;
    if(new Date(exp) < now) return false;
    return tok === bookingMatchToken;
  }

  // AVAILABLE: ok if no active temp hold, or temp hold expired/blank
  const tok = (slotRec.getCellValueAsString("Temp Hold Token")||"").trim();
  const exp = slotRec.getCellValue("Temp Hold Expires At");
  if(tok && exp && new Date(exp) >= now){
    // someone has temp hold
    return false;
  }
  return true;
}

// Prevent using same slot twice in this run
const usedSlotIds = new Set();

// ------------------ Prepare updates ------------------
const slotUpdates = [];
const bookingUpdates = [];
const cancelUpdates = toCancel.map(b=>({ id:b.id, fields:{ "Booking Status": sel("CANCELLED") }}));

const confirmedBookings = [];
const failedBookings = [];
const confirmedSummary = [];
const failedSummary = [];

const rematchCreates = [];
let anyNewMatches = false;

const REMATCH_MINUTES = 15;

function getBookingIdStr(b){ return (b.getCellValueAsString("Booking ID")||"").trim() || b.id; }

function pickNextRematchSlot(){
  for(const sl of candidateSlotOrder){
    const s = slotQuery.getRecord(sl.id);
    if(!s) continue;
    if(usedSlotIds.has(s.id)) continue;

    // can only rematch to AVAILABLE slots that are not currently temp-held
    if(statusOf(s) !== "AVAILABLE") continue;

    const tok = (s.getCellValueAsString("Temp Hold Token")||"").trim();
    const exp = s.getCellValue("Temp Hold Expires At");
    if(tok && exp && new Date(exp) >= now) continue;

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

  // Match timed out -> EXPIRED
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
    continue; // no rematch on timeout (keeps model simple/consistent)
  }

  // Slot missing
  if(!slotRec){
    failedBookings.push(b);
    failedSummary.push(`${bookingId} // ${lastName} — Slot record not found.`);
    bookingUpdates.push({ id:b.id, fields:{ "Booking Status": sel("FAILED") }});
    // allow rematch
  } else {
    const room = roomName(slotRec);
    const sStart = new Date(slotRec.getCellValue("Start Time"));
    const sEnd   = new Date(slotRec.getCellValue("End Time"));

    // Stolen/unavailable -> FAILED
    if(!isSlotAvailableForBooking(slotRec, matchToken)){
      failedBookings.push(b);
      const st = statusOf(slotRec);
      const reason = st === "HELD" ? "Slot is temporarily held by another confirmation." : `Slot is no longer available (status: ${st}).`;
      failedSummary.push(failLine(bookingId, lastName, room, sStart, sEnd, reason));
      bookingUpdates.push({ id:b.id, fields:{ "Booking Status": sel("FAILED") }});
    } else {
      // SUCCESS: book it
      usedSlotIds.add(slotRec.id);

      confirmedBookings.push(b);
      confirmedSummary.push(summaryLine(bookingId, lastName, room, sStart, sEnd));

      // Clear temp hold + set BOOKED
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

  // ------------------ Auto-rematch ONCE (only for FAILED, not for EXPIRED) ------------------
  if(!alreadyRematched && paidLink?.id){
    const newSlot = pickNextRematchSlot();
    if(newSlot){
      usedSlotIds.add(newSlot.id);

      const newToken = `MATCH-${randomToken(12)}`;
      const newExpires = new Date(now.getTime() + REMATCH_MINUTES*60*1000);

      // Create new booking MATCHED
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
      anyNewMatches = true;

      // HOLD slot for rematch window (calendar-visible)
      slotUpdates.push({
        id: newSlot.id,
        fields: {
          "Status": sel("HELD"),
          "Temp Hold Token": newToken,
          "Temp Hold Expires At": newExpires,
          "Temp Hold Email": contactEmail,
        }
      });

      // Mark original as rematched attempted for audit
      bookingUpdates.push({ id:b.id, fields:{ "Auto Rematch Attempted?": true }});
    }
  }
}

// Apply updates
if(slotUpdates.length) await batchUpdate(slots, slotUpdates);
if(bookingUpdates.length) await batchUpdate(bookings, bookingUpdates);
if(cancelUpdates.length) await batchUpdate(bookings, cancelUpdates);

// Create rematch bookings
let newBookingIds = [];
let newMatchLines = [];
if(rematchCreates.length){
  newBookingIds = await batchCreate(bookings, rematchCreates);

  // Re-read new bookings to get Booking ID for messaging
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

  if(newMatchLines.length){
    failedSummary.push("");
    failedSummary.push("NEW MATCHES CREATED (ACTION REQUIRED):");
    failedSummary.push("One or more selected confirmations failed because the slot was taken first.");
    failedSummary.push("We temporarily held new slot(s) for 15 minutes. Submit the confirmation form again to confirm them:");
    failedSummary.push(...newMatchLines);
  }
}

// Determine Result
let result;
if(confirmedBookings.length>0 && failedBookings.length===0 && !anyNewMatches) result="VALID";
else if(confirmedBookings.length>0 && (failedBookings.length>0 || anyNewMatches)) result="PARTIAL";
else if(confirmedBookings.length===0 && (failedBookings.length>0 || anyNewMatches)) result="PARTIAL";
else result="INVALID";

const confirmedLinks = confirmedBookings.map(b=>({ id:b.id }));
const failedLinks = failedBookings.map(b=>({ id:b.id }));
const allLinks = [...confirmedLinks, ...failedLinks];

await confirmations.updateRecordAsync(conf.id,{
  "Result": sel(result),
  "Booking": allLinks,
  "Confirmed Booking(s)": confirmedLinks,
  "Failed Booking(s)": failedLinks,
  "Booking Summary": confirmedSummary.join("\n"),
  "Failed Booking Summary": failedSummary.join("\n"),
});

console.log(`RRS-3 v1.9.26 complete: result=${result}, confirmed=${confirmedBookings.length}, failed=${failedBookings.length}, cancelledUnselected=${toCancel.length}, newMatches=${newBookingIds.length}`);
