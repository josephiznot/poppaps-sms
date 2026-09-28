# ADR 0011 — Hold messages while a one-off campaign awaits approval

Status: Accepted, 2026-09-27.

Extension: [ADR-0012](0012-scheduled-invitation-campaigns.md) permits a separately
approved, scheduled invitation campaign to send without releasing this game's
automatic reminder hold. All other game-linked delivery keeps the hold check.

## Context

Joseph authorized a one-time game on October 26, 2026 at 18:30 Central, with
a $50 advance payment to Joseph by cash or Venmo. He explicitly withheld
authorization to text players until the campaign is confirmed. Saving a game
normally enables the hourly reminder path, so scheduling and SMS approval need
separate state.

## Decision

Add `games.sms_hold`, defaulting to `0` for existing games. A held game remains
scheduled and reserves its date, with its real buy-in and description. It is
visible in admin with a **Texts on hold** label. It is omitted from public
upcoming-game banners while the campaign awaits approval.

Both reminder queue paths exclude held games. The outbox also checks the hold
immediately before sending game-linked messages, protecting against work queued
before the hold was applied. A hold does not pretend a reminder was sent or a
game cancelled, and it does not change existing games' ordinary operation.

One-off games use `series_date=NULL` and do not create a quarterly tournament
plan, freeze standings, close a season, or reserve ranked tournament seats.
This change introduces no recurring event, payment processor, payment-verification
automation, new RSVP keyword, approval button, or automatic invitation sender.
Joseph verifies payment receipt himself; an SMS reply is not proof of payment.

Keep the exact invitation and approval state in a dated campaign record. The
October 26 record is [here](../campaigns/2026-10-26-special-game.md). It is a draft,
not outbox work. Releasing the hold or sending invitations requires Joseph's
subsequent campaign confirmation. Review reminder recipients, wording, and
event/scoring details at that time; merely clearing the hold would otherwise
enable the existing regular-game reminder behavior.

## Rollout and verification

Apply additive migration `0012_game_sms_hold.sql`, deploy the hold-aware Worker,
verify its live revision, then create the one-off game with `sms_hold=1`,
`reminder_sent=0`, and `cancelled=0`. No production SMS tests or manual cron runs.
Verify that the live game has no SMS outbox records and no tournament plan.
Local SQLite tests must show held games remain on the admin calendar, are absent
from public upcoming queries, cannot queue reminders, and cannot dispatch stale
game-linked outbox work. Existing unheld behavior must continue to pass.
