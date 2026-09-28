# ADR 0012 — Approved one-time invitation campaigns

Status: Accepted for implementation, 2026-09-27.

## Context

Joseph requested an October 26 event invitation to all opted-in players on
September 28 and a preview of the text. Scheduling an invitation must not silently
release the game's held automatic reminders. The existing outbox sends immediately
and has no campaign approval or scheduled-send record.

## Decision

Use the existing hourly Cloudflare job and durable per-recipient outbox. Add an
`sms_campaigns` row containing the linked game, exact body, send time, expiry,
approval timestamp, cancellation timestamp and a once-only `queued_at` marker.
An approval applies to that exact body, audience (all subscribed members at the
due snapshot), game and send window. No approval is inferred from saving a draft.

On a due hourly tick, atomically snapshot the currently subscribed recipients
into `sms_deliveries` and set `queued_at`. Repeated or concurrent ticks must not
repeat the snapshot or admit later signups to an already-queued campaign. The
logical delivery key is unique for each campaign and recipient. The outbox also
defers any manually prequeued future campaign rows until their send time.

Only `CAMPAIGN_INVITE` work with a matching, approved, queued and uncancelled
campaign may bypass `games.sms_hold`. Before each provider call, check the exact
body and game relationship, send window, current consent and that the game is
future and uncancelled. Missing, unapproved or inconsistent campaign records cannot
authorize a message. Existing reminder paths continue to honor the game's hold.
This is a narrow extension of ADR-0011, not blanket release of game messaging.

Keep the existing 20-message hourly drain limit, one-second pacing, provider
receipts, suppression after expiry and no blind retry of UNKNOWN sends. Campaign
approval/queuing is not proof of delivery. Cancellation suppresses remaining work;
it cannot recall messages already submitted to the provider.

Campaigns must have an explicit expiry. For the proposed September 28 morning
invitation, use a two-hour send window so a missed tick or definite transient
failure can retry once without sending an invitation that evening. The final
time and refund wording remain pending Joseph's answers in the dated
[campaign record](../campaigns/2026-10-26-special-game.md).

## Scope and rollout

No payment verification, cash collection, refunds, new player keywords, public
announcement, campaign editor or release of automatic reminders is introduced.
Apply additive migration `0013_scheduled_sms_campaigns.sql` before deployment.
Deploy and verify the exact revision before writing the approved campaign record.
Tests use SQLite and fake SMS transport; never trigger production sends as a test.

Verify future work is deferred without blocking other due messages, recipient
snapshotting is once-only, approved invitations can send while reminders remain
held, opt-outs/cancellations/expiry/altered copy suppress sending, and repeat ticks
do not duplicate provider acceptance. Verify actual downstream delivery separately
after the real scheduled run.
