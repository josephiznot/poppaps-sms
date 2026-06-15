# ADR 0006 — Tournament seat RSVPs: player-confirmed, host-paced backfill

- **Status:** Accepted (implemented)
- **Date:** 2026-06-12
- **Extends:** ADR-0002 (seasons/snapshot), ADR-0005 (SMS = players only)

## Context

The Special Players tournament invite was fire-and-forget: the top 8 got a text
and the host had no idea who was actually coming. Seats are scarce and *earned*
(top 8 by points), so a no-show wastes a seat that the #9 player would have
taken. Two sub-problems:

1. **Confirmation** — invitees need a way to say "I'm coming."
2. **Backfill** — when a seat goes unclaimed, the next player on the *closed*
   season's leaderboard should be considered.

A fully automated design (a confirm-by timestamp + a cron that reassigns seats
and texts #9 when the deadline passes) was considered and rejected: the
tournament runs ~4×/yr with ~8 people the host sees in person every two weeks.
A seat-reassignment state machine fights the project's north star (*minimal
effort*, NFR-1) and adds edge cases — confirmations a minute past deadline, a
backfilled player confirming after the original shows up anyway.

There's also a related leak: the hourly reminder cron texted **every**
subscriber about **every** upcoming game — including the invite-only tournament
on its off week, which read as an open invitation to the whole roster.

## Decision

**Players confirm by SMS; the deadline lives in the message; the host paces the
backfill. The system never gives a seat away on its own.**

1. **`IN` is the confirmation keyword** (also `confirm`, "I'm in"; a bare `YES`
   from a member with a pending invite confirms too, since people reply YES no
   matter what the message asks — for everyone else YES keeps its carrier
   opt-in meaning). Carrier keywords (STOP/HELP/…) always win over confirmation
   parsing. A non-invitee texting IN falls through to the normal
   unknown/name-capture handling, so the keyword is invisible outside an
   active invite.
2. **Invite copy carries a host-picked confirm-by date** ("Reply IN by Sunday,
   June 21 to lock your seat — unclaimed seats go to the next player"), chosen
   from a **calendar date picker** on the Run-tournament form and formatted into
   the message (`formatConfirmBy`, parsed at UTC so a date-only value never slips
   a day). No timestamp is stored or enforced; the host decides when the deadline
   has truly passed. Sending is also guarded by a **confirmation prompt** ("…the
   texts cannot be unsent. Your past points and attendance are NOT deleted."),
   since the send is the one irreversible step (the season reset only inserts a
   close marker — see ADR-0002).
3. **`tournament_rsvps` table** — one row per invited player per season close
   (`season_id`, `member_phone`, `invited_at`, `confirmed_at`). Rows are created
   only for players actually texted; an opted-out top-8 player keeps their
   snapshot seat (ADR-0002 honest history) but has no RSVP row.
4. **Admin tracker on `/admin/tournament`** — until the tournament game is
   played, the page shows each invitee as ✅ confirmed / ⏳ no reply / 🚫 opted
   out, plus the **next players in line** computed from the *closed* season's
   standings (the standings query gained an upper time bound for this), each
   with a one-click **Send invite** that texts a "seat opened up" message and
   adds them to the RSVP roster.
5. **Tournament reminders go to invitees only.** The reminder cron resolves a
   tournament game to the season close that references it (`snapshot.gameId`)
   and texts only that RSVP roster. If a tournament game has no linked invites,
   **nobody** is reminded (better silent than leaking an open invite), and the
   skip is logged.

## Consequences

- The host gets attendance certainty without any new recurring obligation; the
  one new (optional) action is clicking "Send invite" on a backfill candidate.
- Confirmation state is operational, not historical: the season `snapshot`
  remains the authoritative record of who earned seats; `tournament_rsvps`
  records who was texted/confirmed (including backfills beyond the top 8).
- `IN` joins the reserved player keywords — display-name capture still works
  because confirmation only short-circuits for members with a pending invite.
- The invite flow now wants the tournament game scheduled *first* (FR-T2's
  order matters more): the admin page nudges this so invites carry a real date.
