# ADR-0010: Designated tournament dealer notifications

- Status: Accepted
- Date: 2026-09-14

## Context

The Special Players tournament needs a designated dealer who may not qualify as
a player. Treating that person as an invitee would incorrectly reserve one of the
eight ranked seats and ask for an RSVP the dealer does not need. The already-active
2026-Q4 plan also means this cannot depend only on qualification close.

## Decision

Members have a reusable `is_designated_dealer` role flag. Production assignment is
a separate operation after migration 0008; no identity or phone is stored here.

Every normal tournament tick ensures each subscribed designated dealer has one
schedule-versioned notice for the current ACTIVE plan until the future tournament
starts. To validate the player-facing copy, its body is byte-for-byte the same
`automaticTournamentInvite` body sent to an initially qualified player, including
CALL/FOLD wording. The delivery remains a `DEALER_TOURNAMENT_NOTICE`: it has no
offer, consumes no seat, and CALL/FOLD cannot act on it. Dealer attendance never
creates a `tournament_offers` row.

Changing that shared copy does not create or replace current-version dealer work.
The existing logical key and schedule version remain authoritative, so a previously
created or delivered 2026-Q4 notice is not resent by a later tick.

An ACTIVE or CONFIRMED player offer takes precedence: normal player invitation and
reminder behavior applies and queued dealer work is suppressed. Otherwise the dealer
gets dealer-specific night-before copy. Reschedules create a versioned update.
Cancellation creates one dealer cancellation only when a prior dealer notice had a
provider-possible outcome (`SENDING`, `ACCEPTED`, `DELIVERED`, or `UNKNOWN`).

STOP and dispatch-time subscription checks always apply. Signed provider-standard
START or UNSTOP can requeue an existing dealer notice only after a definite no-SID
Twilio 21610 failure, while the dealer role, plan and future game remain current and
no player offer supersedes it. Unknown or provider-accepted sends
are never recovered.

## Consequences

Dealer attendance is independent of the eight-seat offer invariant and CALL/FOLD.
Hourly ticks cover role assignment after a plan is ACTIVE, while unique logical keys
make repeated ticks and copy-only code changes idempotent.
