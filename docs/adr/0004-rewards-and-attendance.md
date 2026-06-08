# ADR 0004 — Rewards and attendance (forward-looking)

- **Status:** Proposed (reward *rules* not yet specified; attendance-capture
  mechanism now **decided** — see "Attendance capture" below)
- **Date:** 2026-06-08

## Context

The lounge manager will eventually want **attendance-based promos** — e.g., every
X visits a player earns a reward like a 2-for-1 beer. The requirements are not
finalized; more are expected. Two hard constraints are already known:

- **No POS integration.** The reward cannot read or write the lounge's
  point-of-sale or any loyalty system.
- **Minimal effort to operate.** The single host should not have to do bookkeeping
  per visit.

This ADR records the **proposed direction** so the data model (ADR-0002) can
accommodate it without churn, not a committed feature.

## Decision (proposed)

1. **Track attendance as an append-only ledger.** An **Attendance** log (one row
   per member per game: `memberPhone`, `gameId`, `timestamp`) — see ADR-0002 —
   **host-marked** on the post-game admin screen (ADR-0005 §5). A member's visit
   count is `COUNT(*)` over their rows; "visits this season/period" is a
   timestamp-filtered count. Append-only keeps it auditable and
   correction-friendly, same rationale as the points ledger.

2. **Make reward rules data-driven, not hard-coded.** A **RewardRules** table
   (e.g. `everyNVisits`, `rewardText`, `active`) evaluated against the attendance
   ledger, plus an **AwardedRewards** table recording what was granted to whom and
   when (so a reward fires once per threshold crossing, not repeatedly). New promos
   become data, not code changes.

3. **Delivery is SMS + an admin "redeemed" flag (no POS).** When a rule fires, the
   member is **texted their promo** ("You've earned a 2-for-1 beer — show this
   text") — a legitimate *promo* SMS within the opted-in program (ADR-0005) — and
   the admin **Roster** screen shows it as earned with a **"redeemed" checkbox** the
   host taps when it's honored in person. No POS, no loyalty integration; the
   `AwardedRewards` row is the system of record for earned-vs-redeemed.

### Attendance capture — DECIDED: host-marked (ADR-0005 §5)

Resolved 2026-06-08. Attendance is **marked by the host** on the post-game admin
screen (tap who attended, in the same flow as entering the top 5). **Player
self-check-in is rejected** — texting `HERE` is trivially faked from off-site, and
removing self-check-in removes the entire cheating vector while being the
*lowest-effort* option (no new surface, no anti-abuse code). See ADR-0005 for the
anti-cheat rationale and the documented venue-code fallback if the roster ever
outgrows a tap-the-list flow.

## Consequences

- The ledger-oriented model from ADR-0002 already supports this; adding rewards is
  additive (two new tables) with no rework of points or games.
- Reward thresholds and visit counts are relational/report-shaped — another reason
  the D1/SQL choice (ADR-0001) pays off versus a KV/DynamoDB design.
- Attendance capture adds **no SMS surface** — it's a tap on the admin web screen
  (ADR-0005), so there is no command-router or keyword-collision concern.
- Until requirements firm up, **nothing here is built.** It exists to guide the
  data model so we don't paint ourselves into a corner.

## Revisit if / Future revisions

- **Requirements firm up** → promote this ADR from Proposed to Accepted with the
  concrete rule set and the chosen attendance-capture mechanism.
- **Reward logic needs POS / loyalty integration** → reconsider a dedicated
  backend/integration layer rather than SMS-only delivery (and revisit ADR-0001's
  platform choice).
- **Host-marking attendance gets tedious** (roster grows past ~25–30) → add the
  venue-only per-night check-in code from ADR-0005 §5.
- **Reward volume grows** → mind Twilio throughput (10DLC ~1 msg/sec) and batch
  reward notifications.
