# Room Reservation System (RRS) Architecture

## Overview

RRS is an Airtable-based room reservation system for ADC | IBC Finals that supports:
	•	Public browsing of available practice room slots
	•	Reservation requests with 15-minute holds
	•	Confirmation to finalize bookings
	•	Automatic writeback to the official Master Schedule
	•	Expiration of unconfirmed holds
	•	Account credit requests (internal “refunds”) with staff review
	•	Cancellation requests and a staff-run cancellation processing tool that reverts bookings and returns slots to availability

The system is split across two Airtable bases to keep the competition master schedule clean:
	**1.	2026 FINALS RESERVATIONS** (Reservations Engine)
	**2.	2026 FINALS LOGISTICS** (Master Schedule Output)

⸻

## Data Flow (Start → Finish)

**0) Slot Source of Truth (Master Base)**
	•	The MASTER SCHEDULE (2026 FINALS LOGISTICS) contains placeholder records representing reservation availability.
	•	These reservation blocks use:
	•	{Category} = "RESERVED"
	•	{Event} = "AVAILABLE RESERVATION" (when unbooked)

A formula field {Master Record ID} = RECORD_ID() is used for durable cross-base writeback.

**1) Master Slots Sync → Operational Slots**

Script 1 (RRS-1) keeps SLOTS (Operational) aligned with synced MASTER SLOTS (Synced):
	•	Create missing operational slot records
	•	Update existing operational slots when master slot details change
	•	Mark slots missing from master as:
	•	NEEDS REVIEW if booked/linked to booking
	•	otherwise VOIDED

**2) Booking Request → Hold Creation**

Script 2 (RRS-2) runs when a booking request is submitted:
	•	Validates required fields + acknowledgements
	•	Validates email matching rules (as configured)
	•	Selects the best available slot(s) using request preferences
	•	Places hold(s) for 15 minutes:
	•	updates slot status to HELD
	•	sets hold token + expiration + held-by email
	•	Creates/updates a provisional booking:
	•	Booking Status = AWAITING CONFIRMATION
	•	Writes a clean text summary (held slots) used in emails
	•	Sets request status and drives email notifications

**3) Confirmation → Booking Finalization**

Script 3 (RRS-3) runs when a confirmation is submitted:
	•	Matches the confirmation to the correct booking/request
	•	Validates hold token / confirmation code + expiration
	•	If valid:
	•	sets booking to CONFIRMED
	•	sets slot(s) to BOOKED and clears hold metadata
	•	links paid roster/eligibility records as configured
	•	sets confirmation Result = VALID
	•	If invalid or expired:
	•	sets confirmation Result = INVALID or EXPIRED

**4) Expire Holds (Scheduled)**

Script 4 (RRS-4) runs every 15 minutes:
	•	Finds expired HELD slot(s) / AWAITING CONFIRMATION bookings
	•	Releases slot(s) back to AVAILABLE and clears hold metadata
	•	Updates related booking requests to EXPIRED
	•	Updates booking status to EXPIRED

**5) Writeback → Master Schedule**

Script 5 (RRS-5) runs in the Reservations base and PATCHes the Master Schedule via Airtable API:
	•	Uses each slot’s {Master Record ID} to update exact master schedule records
	•	Writes:
	•	{Event} / reservation metadata
	•	reservation status & timestamps
	•	sync notes
	•	Marks booking as writeback completed
	•	Sets booking request status to COMPLETE

This API approach avoids Airtable sync “origin edit” issues and is durable year-to-year.

**6) Account Credit Requests (Internal “Refunds”)**

Script 6 (RRS-6) runs when an account credit request is created:
	•	Blocks duplicates (“one active request per anchor record”)
	•	Links evidence (booking + booking requests)
	•	Reciprocally links to cancellation requests if present
	•	Sets initial processing status

**7) Cancellation Requests**

Script 7 (RRS-7) runs when a cancellation request is created:
	•	Blocks duplicates
	•	Reciprocally links to account credit requests if present
	•	Sets initial status for staff review

**8) Cancellation Processing Tool** (Button / Scripting Extension)

Script 8 (RRS-8) is run by staff after a cancellation is approved:
	•	Cancels the booking and releases slot(s) back to AVAILABLE
	•	Reverts master schedule records back to “AVAILABLE RESERVATION”
	•	Clears downstream links (e.g., paid roster booking confirmation)
	•	Sets cancellation request status to CANCELLED IN SYSTEM
	•	Writes an audit trail into {System Notes}

⸻

## Configuration & Secrets

**RRS SETTINGS**

The Reservations base includes a RRS SETTINGS table used by staff-run scripts:
	•	{Master Base ID}
	•	{Master Table Name}
	•	{RRS5_PAT} (Airtable Personal Access Token)

⸻

## Status Lifecycles

**Slots (SLOTS (Operational))**
	•	AVAILABLE → HELD → BOOKED
	•	HELD → AVAILABLE (expired)
	•	AVAILABLE/HELD → VOIDED (slot removed from master)
	•	BOOKED → NEEDS REVIEW (master slot changed/deleted)

**Booking Requests (BOOKING REQUESTS)**
	•	SUBMITTED → HOLD CREATED → CONFIRMED → COMPLETE
	•	SUBMITTED → FAILED - INVALID EMAIL
	•	SUBMITTED → FAILED - UNAVAILABLE SLOT
	•	SUBMITTED → NEEDS HELP
	•	HOLD CREATED → EXPIRED

**Bookings (BOOKINGS)**
	•	AWAITING CONFIRMATION → CONFIRMED
	•	AWAITING CONFIRMATION → EXPIRED
	•	CONFIRMED → CANCELLED

⸻

## Year-to-Year Setup Checklist (High Level)
	•	Import new Master Schedule and reservation blocks
	•	Ensure {Master Record ID} = RECORD_ID() exists in Master Schedule
	•	Sync the reserved-slot view into Reservations base
	•	Run Slot Sync (RRS-1) to rebuild operational inventory
	•	Verify RRS SETTINGS values (new master base ID if changed)
	•	Test one full booking cycle before opening to the public
