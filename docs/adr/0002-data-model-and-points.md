# ADR 0002 — Append-event data model and points scoring

- **Status:** Accepted (pending implementation)
- **Date:** 2026-06-08

## Context

Today the system stores only **SMS subscribers** keyed by phone number, plus a
list of **Games** (see `src/types.ts`). The roadmap adds three report-shaped,
relational requirements:

1. **Points per player**, awarded after each game.
2. **Season standings** (cumulative points).
3. A **quarterly "Special Players" tournament** (4× a year): the **top 8 players
   by points** are invited to a special game on an off week. It is
   **host-initiated and manually planned — not auto-scheduled**; the system only
   needs to be *aware*, i.e. able to surface the top 8 on demand when the host
   plans one.

These need points recorded with timestamps so they can be aggregated by quarter,
a "top N this quarter" query, and a notion of a **Player** that is distinct from
a raw phone subscriber. The current subscriber-only, phone-keyed model cannot
express any of this cleanly.

The game runs **biweekly** (every 2 weeks) and is operated by a **single host**
with minimal effort.

## Decision

Adopt a **ledger / append-event oriented** data model, stored in **D1 (SQLite)**
(per ADR-0001), rather than mutable per-player counters.

### Entities

- **Members** — one entity per opted-in person, **keyed by phone** (`phone`,
  `displayName` = first name + last initial, `status` SUBSCRIBED/UNSUBSCRIBED,
  opt-in/opt-out timestamps, `source`, `createdAt`). **Revision 2026-06-08:**
  Players and Subscribers are **collapsed into Members** — opt-in *is* the tracking
  boundary (opted-in → tracked; not opted-in → not in the system at all), so the
  earlier Player/Subscriber split is gone (ADR-0005 §4). Points and attendance
  reference a member's `phone`.
- **Games** — a scheduled game night (existing: `startsAt`, `location`, `buyIn`,
  `description`, reminder-sent flag). Plus a future **recurring schedule** (anchor
  date + 14-day interval) that auto-generates upcoming games — see roadmap, not
  built yet.
- **PointsLedger** — **append-only**, one row per member per game:
  `memberPhone`, `gameId`, `points`, `awardedAt` (timestamp). Never updated in
  place; corrections are new compensating rows.
- **Attendance** — **append-only** log: `memberPhone`, `gameId`, `timestamp`,
  **host-marked** on the post-game admin screen (ADR-0005 §5 — no player
  self-check-in). Feeds reward rules (ADR-0004).
- **Seasons** — **append-only** season-close log: `id`, `closedAt`, `snapshot`
  (the top-8 of the season being closed). Each row is a logical reset boundary;
  the current season is everything after `MAX(closedAt)`. See "Reset is a logical
  season boundary" below.
- **RewardRules** + **AwardedRewards** — future, defined in ADR-0004.

### Points scoring (exact rule — top 5 only)

After each game the host submits that night's finishing order. Points are awarded
to the **top 5 finishers only**:

| Place | Points |
| ----- | ------ |
| 1st   | 5      |
| 2nd   | 4      |
| 3rd   | 3      |
| 4th   | 2      |
| 5th   | 1      |

6th and below score 0. Each award is written as one row in **PointsLedger** with
`awardedAt`.

### Season window, top-8 tournament, and reset — on demand, host-initiated

The tournament is **planned manually by the host ~4× a year**; nothing schedules
it automatically. The system's only job is to **answer "who are the top 8 right
now?" on demand** and to support the close/reset sequence below. Because every
award row carries `awardedAt`, the top-8 query is `SUM(points) ... WHERE awardedAt
> lastSeasonClose`, `GROUP BY memberPhone`, `ORDER BY total DESC` with an explicit
tie-break (see Revisit), surfacing 8 players. The host runs this when planning a
tournament, then fires a **targeted broadcast** to those 8 inviting them to the
off-week game.

The scoring window is the **current season — i.e. all awards since the last
season close** (evaluated in **America/Chicago, Central Time**). This **replaces
the earlier "default to calendar quarter" wording**: the host has decided the
window is *since the last special tournament*, not a calendar quarter, so that
new/returning players get a fresh shot each season.

#### Reset is a logical season boundary, not a physical delete

When a tournament is scheduled, "reset all points" is implemented as a **recorded
season-close event**, never a `DELETE`. This preserves the append-only,
auditable-ledger principle: nothing is removed, and all history (past standings,
past winners) stays queryable.

- A **`Seasons` (season-close) record** is appended: `{ id, closedAt, snapshot }`,
  where `snapshot` captures the top 8 of the *closing* season. Standings thereafter
  are `SUM(points) WHERE awardedAt > (SELECT MAX(closedAt) FROM seasons)`.
- The snapshot is stored on the close record so it is **immune to awards that
  arrive later** (or between scheduling and tournament night).

**Required sequence (order matters):**

1. Host **schedules** the tournament game.
2. System **snapshots the top 8** of the closing season (pre-reset standings).
3. System **sends invites** to those 8.
4. System **opens a new season** (append the season-close boundary).

Doing the snapshot *before* the boundary guarantees invites use pre-reset
standings. Two related policy points are now **decided** (2026-06-08): the
**tie-break at the 8th seat** is the **host's pick** on the Run-tournament screen,
and the **tournament game awards no points**. See `docs/requirements.md` §6.

## Consequences

- **Auditability and corrections.** The append-only ledger is the source of truth
  for standings. **Scoped exception:** the admin *edit* flow fixes a mis-entered
  result by **re-entering it** — deleting and re-inserting that one `game_id`'s
  points + attendance rows. For a single host correcting a same-night mistake this
  is simpler and clearer than stacking compensating rows; the mutation is confined
  to one game and everything else stays append-only.
- **Aggregations are just queries.** Season standings and quarterly top-8 are SQL
  `GROUP BY` over the ledger — no counter maintenance, no schema churn when new
  report shapes appear. This is a concrete reason **D1/SQL fits better than the
  original DynamoDB single-table design** (ADR-0001).
- **Player vs Subscriber gap is closed.** Players and Subscribers are one
  **Members** entity keyed by phone (ADR-0005 §4); display names are captured at
  JOIN and tidied on the admin Roster screen. Winner entry is **tapping names in
  the web UI** (ADR-0005), not typing IDs over SMS — so the old minimal-typing /
  disambiguation problem is moot.
- More tables than the original two, but each is small and the relationships are
  simple.

## Revisit if / Future revisions

- **Standings need to be queried very frequently or the ledger grows large** →
  add a materialized/cached standings table refreshed on write, keeping the
  ledger as source of truth.
- **Tie-break at the 8th seat — DECIDED: host picks.** When two members tie for the
  8th seat, the Run-tournament screen surfaces the tie and the **host chooses** —
  never an arbitrary `LIMIT 8`. (requirements.md D4.)
- **Does the special (tournament) game award points? — DECIDED: No (2026-06-08).**
  The tournament night writes **no** PointsLedger rows; it's a one-off championship
  and the new season starts clean at the next regular game. (requirements.md D5.)
- **A visual dashboard is wanted** to view/edit standings → see ADR-0001's
  Supabase trigger.
- **Player-identity entry proves error-prone** for the host → consider a
  confirmation/echo-back step or a tiny authenticated web form (see ADR-0003).
