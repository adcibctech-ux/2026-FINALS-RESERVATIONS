# RRS Field Map (Tables + Required Fields)

**Important: Scripts depend on exact table/field names. Update scripts if schema names change.**

⸻

## Base: 2026 FINALS LOGISTICS (Master Base)

**Table: MASTER SCHEDULE**

Required fields used by writeback / revert:
	•	{Master Record ID} (formula RECORD_ID())
	•	{Slot Key} (formula; used in some diagnostics)
	•	{Event}
	•	{Category}
	•	{Location}
	•	{Start Time}
	•	{End Time}

Reservation writeback fields:
	•	{Reservation Name}
	•	{Reservation Email}
	•	{Reservation Booking ID}
	•	{Reservation Status}
	•	{Confirmed On}
	•	{Last Reservation Sync Note}

⸻

## Base: 2026 FINALS RESERVATIONS (Reservations Engine)

**Table: ADMIN**
•	{Run Slot Sync Now} (uncheck to run)

**Table: RRS SETTINGS**
	•	{Master Base ID}
	•	{Master Table Name}
	•	{RRS5_PAT}

**Table: ROOMS**
	•	{Room} (primary or field referenced by scripts)
	•	(optional) {Notes}

**Table: MASTER SLOTS (Synced)**

Synced from Master Schedule reserved view:
	•	{Slot Key}
	•	{Start Time}
	•	{End Time}
	•	{Location}
	•	{Master Record ID} (synced from master formula)

**Table: SLOTS (Operational)**
	•	{Slot Key} (primary recommended)
	•	{Master Slot (Synced)} (link to MASTER SLOTS (Synced))
	•	{Master Record ID} (lookup from master slot)
	•	{Room} (link to ROOMS)
	•	{Start Time}
	•	{End Time}
	•	{Status} (single select: AVAILABLE, HELD, BOOKED, VOIDED, NEEDS REVIEW, etc.)
Hold metadata:
	•	{Hold Token}
	•	{Hold Expires At}
	•	{Held By Email}
Booking link:
	•	{Booking} (link to BOOKINGS)

**Table: PAID ROSTER**

(Used as entitlement anchor in current system; may evolve with STUDIO ROSTER)
	•	{Studio Name}
	•	{First Name}
	•	{Last Name}
	•	{Pre-Paid Hours}
	•	{DCG Email}
	•	{Reservation Name} (formula; e.g., {Studio Name} // {Last Name})
	•	{Requested Bookings} (link/backlink to BOOKING REQUESTS)
	•	{Booking Confirmation} (link to BOOKINGS)

**Table: BOOKING REQUESTS**
	•	{Pre-Paid Reservation} (link to PAID ROSTER) (or Studio anchor in future)
	•	{Reservation Email}
	•	{Contact Email}
	•	{Slot Choice #1}, {Slot Choice #2}, {Slot Choice #3} (links to SLOTS)
	•	{Held Slot(s)} (link to SLOTS)
	•	{Held Slot Summary} (text)
	•	{Hold Token}
	•	{Hold Expires At}
	•	{Confirmation Code}
	•	{Request Status}
	•	{Booking Acknowledgement} (checkbox)
	•	{BOOKINGS} (link/backlink to BOOKINGS)

**Table: BOOKINGS**
	•	{Booking Autonumber}
	•	{Booking ID} (formula: RES-xxxxxx)
	•	{Booking Status} (AWAITING CONFIRMATION, CONFIRMED, EXPIRED, CANCELLED, NEEDS REVIEW)
	•	{Booking Request} (link to BOOKING REQUESTS)
	•	{Pre-Paid Reservation} (link to PAID ROSTER)
	•	{Slot(s)} (link to SLOTS)
	•	{Total Minutes} (rollup)
	•	{Confirmed?} (checkbox)
	•	{Confirmed At}
	•	{Expired At}
	•	{Created At} (created time)
Hold metadata (written by Script 2):
	•	{Hold Token}
	•	{Hold Expires At}
	•	{Held Contact Email}
	•	{Confirmation Code}
Writeback metadata:
	•	{Master Writeback Completed?}
	•	{Master Writeback Timestamp}
	•	{Writeback Notes}

**Table: CONFIRMATIONS**
	•	{Booking Request} (link to BOOKING REQUESTS)
	•	{Contact Email}
	•	{Confirmation Code}
	•	{Confirmation Agreement} (checkbox)
	•	{Result} (VALID/INVALID/EXPIRED)
	•	{Booking} (link to BOOKINGS)
	•	{Hold Token} (copied/mapped)
	•	{Booking Summary} (text)

**Table: REFUND REQUESTS** (Account Credits)
	•	{Refund Request ID} (formula)
	•	{Submitted At} (created time)
	•	{Refund Status} (NEW, IN REVIEW, APPROVED, DENIED, CREDITED TO ACCT, NOT PROCESSED - EXISTING REQ)
	•	{Pre-Paid Reservation} (link to PAID ROSTER)
	•	{DCG Email} (lookup)
	•	{Contact Email} (recommended for email comms)
	•	{Reason} (ONLY BOOKED 30MIN, NO SUITABLE AVAILABILITY, EXTENUATING CIRCUMSTANCE)
	•	{Reason Extenuating Circumstance} (long text)
	•	{Booking} (link to BOOKINGS)
	•	{Booking Request(s)} (link to BOOKING REQUESTS)
	•	{Total Minutes Booked} (lookup from Booking)
	•	{Credit Requested} (formula)
	•	{Eligible?} (formula)
Reciprocal cancellation linkage:
	•	{Submitted Cancellation Request?} (YES/NO)
	•	{Cancellation Request} (link to CANCELLATION REQUESTS)

**Table: CANCELLATION REQUESTS**
	•	{Cancellation Autonumber}
	•	{Cancellation Request ID} (formula)
	•	{Cancellation Status} (NEW, IN REVIEW, APPROVED, DENIED, CANCELLED IN SYSTEM, NOT PROCESSED - EXISTING REQ)
	•	{Submitted At} (created time)
	•	{Contact Email}
	•	{Pre-Paid Reservation} (link to PAID ROSTER)
	•	{Booking} (link to BOOKINGS)
	•	{Cancellation Reason} (long text)
	•	{Cancellation Agreement} (checkbox)
	•	{System Notes} (long text)
Admin fields:
	•	{Approved By}
	•	{Approved At}
	•	{Processed By}
	•	{Processed At}
Reciprocal refund linkage:
	•	{Submitted Refund Request?} (YES/NO)
	•	{Refund Request} (link to REFUND REQUESTS)
