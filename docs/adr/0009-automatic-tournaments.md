# ADR 0009 — Automatic quarterly tournaments with exception-only host work

Status: Accepted for implementation, 2026-09-13. Supersedes the manual scheduling,
send-before-close and unrestricted RSVP reclaim decisions in ADRs 0002 and 0006.
The user's current instruction authorizes implementation of automatic scheduling
and normal tournament operation; no test may send real SMS. Cloudflare Worker,
D1 and Twilio remain this project's only runtime services. No Skooped integration,
branding, business records or shared automation is involved.

## Default operation

- One-time launch transition: the 2026-Q4 slot is September 28, 2026. Its
  September 14 qualification cutoff makes September 7 the final scoring game of
  the current season. The September 21 regular game starts the next season.
  Beginning in 2027, the ordinary first-off-week quarterly rule applies.
- Schedule the first Monday in each calendar quarter that is seven days offset
  from the regular 14-day cadence, at 18:30 America/Chicago. Materialize the next
  future occurrence; never catch up a past tournament or send overdue historical
  invitations on startup. A first-time plan needs at least fourteen days' notice;
  if the quarter's nominal occurrence is already past/too close, use the next
  quarter rather than silently inventing a late-quarter championship.
- Invitations / qualification close: 10:00 Central fourteen calendar days before
  the tournament. Results from regular games after this cutoff belong to the new
  season, even if played before the tournament. Initial invitees have exactly seven
  calendar days to respond, until 10:00 Central seven days before the tournament.
  Deadlines and dates are stored as UTC instants and shown
  in Central time. Quarterly date generation uses the recurrence rule even beyond
  the currently materialized regular-game horizon.
- Routine host work is recording game results. The scheduler creates games,
  freezes qualification, opens the next season, queues invitations, handles RSVP,
  fills available seats and sends reminders. The admin exposes the next date and
  rescheduling, plus a clear list of exceptions. No recurring approval step.
- Qualification waits for all uncancelled regular games in the scoring window
  whose start precedes cutoff to have recorded results. Empty or undersized fields
  (fewer than eight scoring players) and equal-point ties across the eighth seat
  block automatic close/invitations. Explicit host selection resolves a cutoff tie
  only; it cannot omit higher scoring qualifiers or include arbitrary members.
- Freeze the complete ranked board, scores, scoring tie-break, selected qualifiers,
  opt-out status, date and deadline. Opted-out qualifiers retain their historical
  earned place but receive no message. Eligible replacements come from this frozen
  board. A replacement tie blocks for host choice. No automatic promotion across
  an unresolved equal-score group.
- Declines and opted-out seats may be replaced automatically in clear board order.
  Pending invitations expire at the stored deadline. Replacement invitations get
  twenty-four hours to respond, capped at twenty-four hours before play; do not dispatch
  new invites inside 24 hours of play. Original offers are retired atomically when
  replaced; a later CALL cannot reclaim a reassigned seat. STOP always wins, FOLD
  keeps the player subscribed. Past/cancelled games never accept RSVPs.

## Durability and exceptions

Persist a unique plan/run, full snapshot, season boundary, seat offers and outbound
intent atomically BEFORE provider sends. Uniqueness is per quarter, game, season
boundary and logical recipient/message. Repeated cron ticks or form posts do not
create additional boundaries or messages. Re-read and validate state at commitment.
Each recipient has queued/sending/accepted/failed/unknown/suppressed delivery state,
SID when available, attempt timestamps and diagnostic errors. Accepted does not
mean delivered. Persist and verify signed Twilio status callbacks when available.
Do not retry ambiguous network/provider outcomes automatically; show an exception
and provide explicit reconciliation/retry controls. Recheck subscription and event
validity immediately before sending. Pace SMS conservatively at one request/sec.

Reminder intents are per current offer/recipient, exclude declined/replaced/opted-out
players, and remain recoverable independently. An event with no invites must not
consume its eventual reminder. Fast CALL after accepted send works because offers
exist before transport. Legacy season/RSVP records remain readable; completed legacy
events reject responses. Do not automatically resend legacy invitations/reminders.

Rescheduling preserves the same quarterly plan and game identity, rejects occupied
regular dates, recalculates pre-invite cutoff/deadline, and never reopens a closed
season. After invites, retain the frozen season and active seat offers, update dates
and deadlines, invalidate stale unsent work and queue one versioned date-change
notice to current subscribed invitees. Cancellation suppresses pending work and
retires offers; already-invited players receive one reviewed cancellation notice
when the host explicitly cancels. Automated scheduling must not replace the host's
override or regenerate a cancelled quarterly occurrence.

## Data corrections and public semantics

Result replacement is atomic and guarded against stale concurrent edits. Preserve
existing effective season timestamps; new/backfilled games use stable game time,
with entry time recorded separately. Zero-point placements cannot alter scoring
tie-breaks. Equal scores retain an explicit stable display order but ties spanning
the qualification boundary require host choice. Public names are minimized on all
surfaces, including historical snapshots. Public copy shows qualification cutoff,
tournament date, points rules, provisional qualification and player actions.

## Verification

Use local D1-compatible fixtures and fake Twilio transport only. Cover repeated and
concurrent cron/form requests, partial persistence/send failure, unknown sends,
cutoff ties, missing results, STOP/FOLD/late CALL, replacement capacity, rescheduling,
quarters/DST, legacy migration and historical edits. Run typecheck, all tests, local
Worker build and mobile/desktop checks. Deployment requires migration preflight and
read-only post-deploy verification; do not trigger production sends as a test.
