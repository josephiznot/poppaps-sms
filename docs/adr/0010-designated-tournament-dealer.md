# ADR-0010: Designated host/dealer is a tournament player

- Status: Accepted (revised 2026-09-21)
- Date: 2026-09-14

## Context

The Special Players tournament has one designated host/dealer. The earlier
implementation treated that person as a non-player notification recipient. The
business policy is that the host always plays, must be able to CALL or FOLD, and
must not displace a ranked qualifier when outside the selected top eight.

The active 2026-Q4 plan already delivered the host the exact ordinary player
invitation body as a `DEALER_TOURNAMENT_NOTICE`. That delivery must become evidence
for the host's real offer without a resend or any body, SID, attempt, delivery-state,
schedule-version, or historical-offer rewrite.

## Decision

`members.is_designated_dealer` identifies the single designated host/dealer. At
qualification close, the system creates actionable offers for the selected ranked
top eight. If the host is among them, that selected offer is also marked as the host
offer and the initial total remains eight. If the host is outside them, the system
adds one host offer and the initial total is nine.

Host-offer metadata records whether the offer consumes ranked capacity. A selected
top-eight host counts among the eight; an outside-top-eight host does not. The latter
is excluded from lower-ranked replacement groups, so clear ranked vacancies continue
strictly down the frozen board without a false tie involving an already-offered host.

The host uses the byte-for-byte ordinary player invitation, reminder, reschedule and
cancellation paths. CALL/FOLD acts on the real offer. No separate dealer notice,
night-before reminder, date-change message or cancellation is created for new plans.

An ordinary pending offer expires at the recurring 21:00 Central response cutoff.
The host offer remains active through that cutoff and is not retired merely because
the host unsubscribes from SMS. Consent remains authoritative for delivery: an
unsubscribed host receives no outbound SMS until subscribed. Explicit FOLD may
decline the host offer. A ranked host's FOLD opens a ranked vacancy; an extra host's
FOLD does not.

Migration 0010 first updates the database capacity triggers, then guards on the
exact active 2026-Q4 version-5, schedule-version-1 state. It creates the extra host
offer, links the already-delivered exact-copy dealer delivery to that offer, and
clears the obsolete replacement-tie blocker only when one non-host tied candidate
remains. It is idempotent and performs no send or tournament tick.

## Consequences

There are always eight ranked seats and one guaranteed host player. Initial offer
and SMS counts are eight when the host is selected, otherwise nine. Historical
dealer delivery kinds remain readable for the migrated message, but current
operation is entirely offer-driven. Provider receipt history and frozen tournament
history stay intact.
