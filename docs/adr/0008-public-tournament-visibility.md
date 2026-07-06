# ADR 0008 — Upcoming tournament shown as an invite-only notice, never as "next game"

- **Status:** Accepted (implemented)
- **Date:** 2026-07-05
- **Extends:** ADR-0005 (public board), ADR-0006 (tournament RSVPs)

## Context

The public homepage banner advertised whatever game came next
(`nextUpcomingGame`) as "**Next game: …** — text JOIN for a reminder." When the
next game was the quarterly Special Players tournament, the only distinction
was a small 🏆 pill — the banner still read as an open invitation, JOIN nudge
included. First observed with the July 6, 2026 tournament: regular players
could reasonably show up expecting an open game night when the table is
reserved for the eight invited qualifiers (ADR-0006).

Two ways to fix it were considered:

1. **Hide the tournament from the public board entirely** until it's played.
2. **Show it, clearly marked invitation-only**, alongside the next regular
   night.

## Decision

**Show it, distinguished — never hidden, never framed as the next game.**

Hiding would fight the rest of the public surface: the standings page already
advertises the "Top 8 · Special Players tournament line," `/seasons` documents
every tournament, and the qualification race is the board's main draw. The
date isn't a secret; the mistake was the framing.

On the homepage:

- The "**Next game night**" banner (with the JOIN-for-a-reminder nudge) is
  always the next **regular** game (`nextUpcomingGame` gained a `regularOnly`
  filter). A tournament can never occupy it.
- When the next scheduled game is a tournament, a separate **oxblood** hero
  (visually distinct from the green next-game hero) appears above it:
  "🏆 Special Players tournament: <date> — Invitation only … Not a regular
  game night," pointing at the regular-game banner below it and at `/seasons`.
  No JOIN link.

Everything else already behaved correctly and is unchanged: tournament
reminders go to the invited RSVP roster only (ADR-0006), and the JOIN welcome
text names no date.

## Consequences

- A regular player reading the board on a tournament week sees their actual
  next game night, and sees the tournament explicitly marked as not for
  walk-ins.
- The tournament stays public marketing for the points race rather than a
  source of confusion.
- If no regular game is scheduled after the tournament (auto-scheduler gap),
  only the tournament notice shows — still marked invitation-only.

## Revisit if

- The host ever wants the tournament date genuinely secret (move to option 1:
  filter tournaments from the public banner and recent-games list until
  played).
- Spectators become a thing (the lounge might *want* walk-in spectators — the
  notice copy could then invite watching, not playing).
