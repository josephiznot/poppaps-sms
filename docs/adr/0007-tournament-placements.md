# ADR 0007 — Record tournament placements with zero points

- **Status:** Accepted (implemented)
- **Date:** 2026-06-15
- **Extends:** ADR-0002 (data model & points; D5 = tournaments award no season points)

## Context

D5 (ADR-0002) settled that the Special Players tournament awards **no season
points**. The implementation enforced that by simply *not writing* any result
rows for a tournament game — the post-game screen collected the finishing order
but only persisted it as points-ledger rows for regular games. Consequences:

- A tournament's **finishing order was lost**: re-opening the game showed empty
  rank fields (nothing to prefill from), so it looked like the ranks "wouldn't
  save."
- The public `/seasons` page showed a "Champion" that was actually the **top
  seed** (points leader at season close), not the player who won the tournament.

The host wants a complete record of every game — including the marquee
tournament — without those results affecting the standings.

## Decision

**Store the finishing `place` (1..5) on every result row; tournament rows carry
`points = 0`.**

- `points_ledger` gains a nullable `place` column (migration 0003; existing rows
  backfilled `place = 6 - points`, valid because every prior row was written
  with points in 1..5).
- The post-game handler now records a row for **every** filled place on **any**
  game. Regular games store `points = pointsForPlace(place)`; tournament games
  store `points = 0` with the real `place`.
- **Standings need no tournament filter.** They `SUM(points)`, and a column of
  zeros sums to zero, so tournament rows can't reach a season total — and a
  player whose only rows are tournament rows is dropped by `HAVING total > 0`.
  Timing reinforces this: the tournament is entered at the *start* of the new
  season (after the season-close boundary), so its zero rows never become a
  player's `MAX(awarded_at)` tie-break either.

### Why zero-points instead of "store real points, filter them out"

Both produce identical standings. Storing the real 5/4/3/2/1 and excluding
tournaments in every aggregate works, but the exclusion must be repeated in
each query that totals points (standings now, plus anything added later) — miss
one and tournament points silently count. With zero-points there is nothing to
filter: the counting-points don't exist, and the placement lives in a separate
column the season math never reads. The mistake is structurally impossible
rather than merely avoided.

## Consequences

- Tournament ranks save and re-open like any other game; the edit screen
  prefills from `place`.
- `/seasons` shows the **actual tournament champion** (the linked game's
  1st-place finisher) once results are entered, falling back to the top seed
  (labelled as such) until then.
- The public `/game/:id` page renders tournament **final standings** (places,
  points shown as "—"); tournament games now also appear under "Recent games"
  with their champion. Winner/champion lookups key off `place = 1` (with a
  `COALESCE(place, 6 - points)` fallback for pre-0003 rows).
- `place` is the source of truth for finishing order going forward; `points`
  remains the source of truth for the season standings.
