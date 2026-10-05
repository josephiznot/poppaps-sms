# October 26, 2026 — one-time special game

## Status

- Event scheduling authorized by Joseph on September 27, 2026.
- Campaign is **APPROVED AND SCHEDULED — NOT YET SENT**.
- Joseph requested the reviewed invitation be sent this evening at 9 PM on
  **October 5, 2026**. This replaces the unapproved September 28 proposal.
- Send: **Monday, October 5 at 9:00 PM Central (CDT)**,
  `2026-10-06T02:00:00.000Z`. The approved send window ends at 11:00 PM CDT,
  `2026-10-06T04:00:00.000Z`.
- Campaign ID: `oneoff-2026-10-26-invite-2026-10-05`.
- Approval persisted at `2026-10-05T19:07:53.647Z`.
- Keep the game's `sms_hold=1`: this approved invitation may send through the
  campaign path; automatic game reminders have not been released.
- Event record identifier: `5c15e20f-c0d1-484f-aab2-7b2af8653735`.
- Admin calendar: <https://poppaps.cards/admin/games>.
- Local operational receipt: `.codex/review-fixtures/adhoc-2026-10-26-verification.json`.
- Scheduling receipt: `.codex/review-fixtures/scheduled-invite-2026-10-05-verification.json`.
- Current audience check on October 5: **19 subscribed, 1 unsubscribed**.
  Actual recipients will be all subscribed players at the due snapshot, with
  consent checked again before each send.
- Approving this invitation will not release the game's automatic reminder hold.

## Event

- Monday, October 26, 2026, 6:30 PM America/Chicago (CDT).
- UTC start: `2026-10-26T23:30:00.000Z`.
- Venue: Poppa P's Smoke Shoppe & Lounge.
- One-time off-week game, separate from the quarterly Special Players tournament.
- Buy-in: **$50 paid in advance to Joseph**, in cash or by Venmo.
- Venmo username supplied by Joseph: **PayUpRightNow**.
- Profile link supplied by Joseph: <https://venmo.com/code?user_id=2404799576276992006&created=1790557943>.
- Seat reservation requires Joseph to receive payment **by October 19**.
- **Minimum turnout: 12 paid players** for the planned prize package. Joseph
  confirmed the 12-player requirement on September 27; because registration
  requires received payment, unpaid RSVPs do not meet this minimum.
- No player cap was requested in the earlier discussion.

Joseph previously considered deep stack, no buybacks and longer blinds. Those
details, a specific prize, reminder audience and season-points treatment have not been finalized
for this campaign. Do not invent them in the invitation. The payment link and an
SMS reply do not verify receipt; Joseph must verify it himself. No automatic
`PAID` response handling has been added.

## Approved invitation — scheduled, unsent

Exact approved copy stored in the production campaign:

> Poppa P's Poker Night: One-time special game Mon, Oct 26 at 6:30 PM Central at Poppa P's. $50 buy-in. Your seat is reserved only after Joseph receives payment by Oct 19, in cash or via Venmo @PayUpRightNow:
> https://venmo.com/code?user_id=2404799576276992006&created=1790557943
>
> At least 12 paid players are needed for the planned prizes. If we fall short, choose a full refund or a smaller game with a reduced buy-in and prizes, with the difference refunded.
>
> Reply STOP to opt out.

The reviewed invitation includes an October 19 payment deadline. If fewer than
12 have paid, each paid player may choose a full refund or a smaller game with
a reduced buy-in and prizes, with the difference refunded. The smaller game's
actual price and prize package would need to be disclosed before a player chooses
it. Scheduling this invitation does not execute any payment or refund.

Verification on October 5: live campaign-aware Worker `2c9fb33`, exact approved
campaign/body/time persisted, `queued_at=NULL`, zero campaign delivery rows,
future send time and automatic reminder hold intact. Scheduled is not delivered.

Next action: after the real 9:00 PM Central hourly run, check per-recipient
provider receipts; resolve definite failures separately from UNKNOWN outcomes.

## Approval boundary

The event may be saved in the admin calendar while messages remain on hold.
Joseph's October 5 instruction authorizes this reviewed invitation to all opted-in
players at 9:00 PM Central. It does not release automatic game reminders or verify
any payment. Existing opt-in/STOP and message-content requirements remain applicable.
