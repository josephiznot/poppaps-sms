# ADR 0005 — Interaction channels: SMS for players, web app for admin + public standings

- **Status:** Accepted (pending implementation)
- **Date:** 2026-06-08
- **Supersedes:** ADR-0003 (SMS command router + admin-by-phone-allowlist)

## Context

ADR-0003 proposed running host/admin actions (winner entry, scheduling, run
tournament) *over SMS* via a command router authorized by a phone allowlist. The
requirements-hashing pass (`docs/requirements.md`) surfaced that this is the wrong
shape for most admin work:

- **Scheduling over SMS is fragile** — a free-typed date/time/location has no
  validation, no parsed-value echo, an implicit timezone, and a fat-finger
  silently sends reminders on the wrong night.
- **Winner entry over SMS needs player identity + disambiguation + a PIN** — all
  apparatus (numeric IDs, echo-back, shared secret) to work around the fact that
  text is a poor authoring surface.
- The host also wants **two things SMS can't do well**: capture **attendance**
  in a way players can't fake, and publish a **public season leaderboard** with a
  short history of past winners.

Meanwhile the player-facing side genuinely *is* a good SMS fit: reminders,
tournament invites, and promos going out; JOIN / STOP / HELP coming in.

So the system should be split by **audience**, not bolted onto one channel.

## Decision

Split into three surfaces, all served by the **same Cloudflare Worker + D1**
(ADR-0001):

### 1. SMS — players only
- **Outbound:** game-night reminders, tournament invites, attendance/visit promos.
- **Inbound:** `JOIN` (opt-in), `STOP`/aliases (opt-out), `HELP`, plus the
  one-step **name reply** that follows JOIN (see §4). Nothing else — there is **no
  admin command surface over SMS**. This removes the command router, the
  phone-allowlist admin auth, the in-message PIN, and SMS player-identity
  disambiguation entirely.

### 2. Admin — authenticated web app (same Worker)
A small web UI, **not** public, gating every admin action:
- **Schedule games** — regular and tournament games via native date/time pickers
  (eliminates the SMS date-parsing problem). Accepts **past dates** for backfill.
- **Post-game screen** — for a given game, **tap who attended** (roster checklist)
  and **tap/order the top 5** finishers. Attendance + winners in one ~minute flow.
- **Standings** — current season at a glance.
- **Run tournament** — surfaces the top 8 (host breaks any tie at the 8th seat),
  sends invites, and closes the season (the snapshot→invite→reset of ADR-0002).
- **Roster** — view/tidy member display names; mark earned promos **redeemed**.

**Auth (as shipped):** a **password login → signed session cookie** (the
`ADMIN_PASSWORD` secret; 30-day cookie; `src/lib/auth.ts`), so admin works
immediately with no external setup. **Cloudflare Access** (Zero-Trust SSO on
`/admin/*`) is the recommended production hardening layered on top — add it when
convenient; it does not replace the password gate.

### 3. Public — read-only standings page (same Worker, no login)
- Current **season standings** and a brief **history of past game winners / season
  champions**.
- **Privacy:** display **first name + last initial only** (e.g. "Mike R."). Never
  full names beyond that, never phone numbers. The opt-in disclosure (§4) must say
  a member's first name + last initial may appear here.

### 4. Member identity, captured at opt-in
- Opt-in **is** the tracking boundary: opted-in → tracked; not opted-in → not in
  the system at all. Subscriber and Player therefore collapse into one **Members**
  entity (see ADR-0002 update).
- Capture flow: player texts `JOIN` → system replies asking for **first name +
  last initial** → stored as the member's display name. The host can tidy/dedupe
  names on the admin Roster screen (since they show publicly).
- **Consent disclosure** (opt-in page + JOIN copy) must state that opting in means:
  reminders **and occasional promos**, results **tracked for points**, and **first
  name + last initial may appear on a public standings page**.

### 5. Attendance is host-marked — no player self-check-in
The host ticks attendance on the post-game screen. **Players do not check
themselves in.** This is the anti-cheat decision: you cannot fake what you do not
control, so removing player self-check-in removes the entire cheating vector while
*also* being the lowest-effort option (it rides the same post-game flow as winner
entry). The earlier "player texts HERE" idea (ADR-0004) is **rejected** — text
check-in is trivially faked from off-site.

**Documented fallback (not built):** if the roster ever grows past ~25–30 and
ticking a list becomes a chore, add a **per-night code shown only at the lounge**
(a table card / announced number) entered on a check-in page. Geofencing is
explicitly *not* pursued — spoofable and high-friction for negligible benefit at
this scale.

## Consequences

- **Large net simplification.** The SMS command router, admin-by-phone-allowlist,
  in-message PIN, and SMS player-ID disambiguation (all of ADR-0003) are deleted.
  Inbound SMS stays the small player-intent switch that already exists, plus the
  JOIN name reply.
- The Worker now serves three route groups: `/sms` (Twilio webhook), `/admin/*`
  (password-gated), and `/` public standings — plus the Cron reminder.
- **Anti-cheat is structural, not a feature.** No self-check-in means no cheat
  surface and no anti-abuse code to maintain.
- **A public surface adds a privacy obligation** — minimized names + an explicit
  consent disclosure (§4). This is the main new compliance item.
- The web admin becomes the natural home for the lounge manager's future rewards
  UI (ADR-0004) — viewing visits, earned/redeemed promos.

## Revisit if / Future revisions

- **Roster grows past ~25–30 and host-marking attendance gets tedious** → add the
  venue-only per-night check-in code (above).
- **Multiple admins / multiple venues** → Cloudflare Access already supports more
  users/roles; scope D1 writes by venue.
- **The public page needs richer interactivity** (filtering, player profiles) →
  consider a small SPA or the Supabase dashboard trigger in ADR-0001.
- **Players want self-service beyond viewing standings** (e.g. RSVP) → that's new
  inbound SMS or authenticated player web — re-evaluate the channel split.
