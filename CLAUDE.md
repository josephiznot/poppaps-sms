# CLAUDE.md — Poppa P's Poker Night SMS

## Project overview

An SMS service for a **biweekly** (every 2 weeks) poker night at **Poppa P's**, a
cigar lounge. It is currently a **texting reminder service**: players opt in by
texting **JOIN** to the Twilio number **+16156951691 / (615) 695-1691** in person
at the lounge (they've already been ID'd buying cigars), and get a reminder before
each game. STOP/HELP are handled. The roadmap adds points tracking, a quarterly
special tournament, and attendance-based rewards — operated by a **single host**
via an **admin web app** (SMS stays players-only), with a **public standings
page**, all built for **minimal effort**.

## Current status — read before changing anything

**September 13, 2026 policy change:** [ADR-0009](docs/adr/0009-automatic-tournaments.md)
is authoritative over older manual-tournament descriptions below. The user wants
automatic quarterly off-week tournament scheduling, invitations, season closure,
reminders and clear-cut replacements. Routine host work is entering game results;
date conflicts, missing results, cutoff ties and uncertain texts are exceptions.
Default tournament: first off-week Monday each quarter, 18:30 Central; qualification
and invitations fourteen calendar days before at 10:00; initial invitees have
seven calendar days to reply, until seven days before play at 10:00. Atomic
persistent intent precedes provider sends; no blind retry
of uncertain sends. Expired/replaced offers cannot reclaim seats. The system stays
on Cloudflare/D1/Twilio and is completely separate from Skooped or other projects.
The public footer credit has been removed. Do not load unrelated business records.
Apply migrations 0005, 0006, 0007, then 0008 before deploying. Use Node 24+ for
SQLite tests.
Result edits preserve season attribution and use atomic, version-guarded replacement.
Public profile IDs are stored random identifiers; always minimize public names.
After STOP, START or UNSTOP restores consent without replacing a stored name or
public profile ID. Ask for identity only when the member has no usable name;
honor Twilio OptOutType and avoid duplicate provider lifecycle confirmations.
A signed provider-standard START or UNSTOP (including an authoritative
OptOutType START) also safely requeues that sender's still-current tournament
invite when its only failed send was Twilio opt-out error 21610; the hourly
outbox performs the later send after revalidating the active offer and game.
One-time transition: schedule 2026-Q4 on September 28 so September 7 is the last
scoring game of the current season; September 21 begins the next season. Resume
the default quarterly occurrence rule in 2027.

- **Implemented on Cloudflare Workers + D1 + Cron** (Hono). One Worker serves
  `POST /sms` (Twilio webhook), `/admin/*` (host web app, password-gated), `GET /`
  (public standings), plus an hourly reminder cron. The previous AWS SAM scaffold
  has been **removed**.
- **LIVE in production** at **https://poppaps.cards** (Cloudflare custom domain;
  also reachable at `*.workers.dev`). Real players are subscribed — schema changes
  need an additive migration in `migrations/` applied to the remote D1 **before**
  `npm run deploy` (see README "Upgrading an existing deployment").
- Architecture decisions live in **[docs/adr/](docs/adr/)**; the consolidated spec
  is **[docs/requirements.md](docs/requirements.md)** — read before changing features.
- **Keep capability docs in sync (standing rule):** any feature/behavior change
  must update the capability docs in the same commit — this file (roadmap +
  relevant section), `docs/requirements.md`, and a new/updated ADR if a decision
  was made. README too if commands or host workflow changed.

## Domain model (target, ledger-oriented — see ADR-0002/0004)

- **Members** — one entity per opted-in person, keyed by **phone** (`displayName`
  = first name + last initial, `status`, opt-in/out timestamps). Subscriber +
  Player collapsed: opt-in = tracked; no opt-in = not in the system.
- **Games** — a scheduled game night (`startsAt`, `location`, `isTournament`,
  reminder-sent, etc.).
- **PointsLedger** — append-only: one row per member per game (`memberPhone`,
  `gameId`, `points`, `place`, `awardedAt`). Never mutated; corrections are new
  rows. `place` = finishing rank 1..5; **tournament rows store `place` with
  `points = 0`** so ranks are kept while standings stay untouched (ADR-0007).
- **Attendance** — append-only, **host-marked** on the post-game admin screen
  (`memberPhone`, `gameId`, `timestamp`). No player self-check-in.
- **Seasons** — append-only season-close log (`closedAt`, top-8 `snapshot`);
  current season = after `MAX(closedAt)`. "Reset" is this boundary, not a delete.
- **RewardRules** + **AwardedRewards** — attendance-based promos; earned + redeemed
  (ADR-0004; rule specifics still forming).

### Points rules (exact — top 5 only)

Host enters the night's finishing order in the admin app; system awards: **1st = 5, 2nd = 4,
3rd = 3, 4th = 2, 5th = 1**. 6th and below score 0. The **finishing place is
recorded for every game** (incl. tournaments, which store the place with 0
points — ADR-0007); standings `SUM(points)` so tournament ranks never count.
**Ties are allowed:** two players can share a place (e.g. an exact chip-count
tie at the 9:00 hard stop) — the post-game screen has an optional **Ties** row,
and the ledger already represents it as two rows at the same `place`/`points`,
which standings `SUM` naturally (ADR-0002).

### Automatic quarterly tournament (ADR-0009)

The hourly Worker schedules the first off-week Monday each quarter at 18:30
Central. Invitations and qualification close happen fourteen days before at 10:00;
initial replies are due seven days before at 10:00. The host records results and
changes dates only for conflicts. Missing results, insufficient standings, cutoff ties and
uncertain delivery appear as exceptions in the admin Tournament page.

The full board, qualifiers, season boundary, seat offers and unique outbound work
are persisted atomically before sending. Opted-out qualifiers remain in historical
records without being texted. Clear vacancies are filled from frozen standings;
replacement ties need host selection. CALL confirms an active seat offer; FOLD
releases it without unsubscribing. Expired or replaced invitations cannot reclaim
seats. Reminder recipients are current offers only. STOP/HELP remain load-bearing.
Per-recipient SID and status distinguish provider acceptance from delivery.
Unknown transport outcomes never automatically retry.
A signed provider-standard Twilio START or UNSTOP may recover only a definite
no-SID 21610 failure for the sender's active, unexpired tournament invitation or
still-current designated-dealer notice;
it queues the existing logical delivery for the hourly outbox and never sends
from the webhook.
A subscribed designated dealer receives separate tournament notice and night-before
reminder copy without a seat offer or CALL/FOLD. A current player offer takes
precedence. Hourly ticks cover plans already ACTIVE; reschedules, cancellations,
STOP and narrow no-SID 21610 recovery follow ADR-0010. Dealer notice eligibility
continues until tournament start and does not end at the player response deadline.

## Interaction surfaces (ADR-0005)

- **SMS = players only.** Out: reminders, tournament invites, promos. In:
  JOIN / STOP / HELP + the JOIN name-capture reply + IN (tournament-seat
  confirm, ADR-0006). **No admin over SMS.**
- **Admin = web app** on the same Worker, **password-gated** (`ADMIN_PASSWORD`;
  Cloudflare Access optional in prod): schedule games (one per day; Skip or Delete
  — delete also removes that game's points + attendance), post-game (winners +
  attendance; re-openable to edit a past game), standings, run-tournament, roster
  (names, games-attended counts, promos). Replaces the old SMS
  command router + phone-allowlist (ADR-0003, superseded).
- **Public** (no login, all on the Worker — not GitHub Pages): current-season
  standings at `/`, a game's winners at `/game/:id`, **season history** (past
  seasons' Special Players + champion) at `/seasons`, **game rules** at `/rules`,
  **program terms** at `/terms`, **privacy** at `/privacy`, and a JSON **`/health`**
  (which git commit is live + how many commits behind `main`; SHA baked in at
  deploy time — see Key commands). Names shown as **first name + last initial
  only**. Standings use **numbered ranks**, an exclusive **face-card chip for the
  top 4** (A/K/Q/J), and a labelled **top-8 "tournament line"** divider.
  The homepage "Next game night" banner (JOIN nudge) always shows the next
  **regular** game; an upcoming Special Players tournament gets a separate
  **invitation-only notice** instead — never framed as the next open game
  (ADR-0008). Ace-of-spades favicon (inline SVG in `lib/html.ts`). The site has no external business credit or integration.

## Roadmap / status

1. **Game-night reminders** — ✅ built (Workers cron + Twilio).
2. **Members + opt-in name capture** — ✅ built (JOIN → name reply → display name).
3. **Points tracking** — ✅ built (admin post-game entry; append-only ledger;
   public standings). (ADR-0002, ADR-0005)
4. **Special Players tournament** — ✅ built (admin: automatic quarterly calendar → frozen qualification → durable invites). (ADR-0002)
   - **Seat RSVPs** — ✅ built (reply IN to confirm; admin tracker + automatic clear-cut next-in-line backfill; invitee-only tournament reminders). (ADR-0006)
   - **Designated dealer** — ✅ built (role-based notice/reminder lifecycle; no ranked seat consumed). (ADR-0010)
5. **Rewards / attendance** — ✅ mechanism built (host-marked attendance →
   data-driven promos via SMS); concrete reward rules still forming —
   `seed.sql` has a placeholder. (ADR-0004)
6. **Recurring schedule** — ✅ built. A biweekly rule (`src/lib/schedule.ts`:
   anchor + 14-day interval, fixed time/place/buy-in) is materialized by the cron;
   the host can Skip/Cancel any occurrence (row kept → not regenerated).

## Repo structure

```
wrangler.toml            Worker config: D1 binding, cron, vars
schema.sql / seed.sql    D1 tables + example reward rule
src/
  index.ts               Worker entry: route mounting + scheduled (cron) handler
  types.ts               Env bindings + domain types
  routes/
    sms.ts               Twilio webhook (player intents + name capture)
    admin.ts             Host web app (login, games, post-game, tournament, roster)
    public.ts            Public standings page
    health.ts            Public /health: live commit + commits-behind-main check
  lib/
    db.ts                All D1 queries
    twilio.ts            Send (fetch) + signature validation (Web Crypto) + TwiML
    messages.ts          Keyword parsing (parseIntent) + SMS copy
    jobs.ts              Cron: recurring-game generator + reminders + reward engine
    schedule.ts          Recurring biweekly rule (config) + date helpers (pure)
    points.ts            Scoring (pure)
    phone.ts             E.164 (pure)
    auth.ts              Admin session cookie
    html.ts              Server-rendered HTML layout
  views/                 policies.ts (privacy/terms) + rules.ts (game rules)
migrations/              D1 migrations for already-deployed databases
scripts/deploy.mjs       Deploy wrapper: bakes git SHA into the Worker for /health
docs/                    requirements.md + ADRs + opt-in/privacy pages
tests/                   Vitest unit tests (messages, phone, points, schedule)
```

## Key commands

| Command | What it does |
| --- | --- |
| `npm install` | Install deps |
| `npm run dev` | Local dev (Miniflare + local D1) at :8787 |
| `npm run deploy` | Deploy via `scripts/deploy.mjs` — bakes git SHA in for `/health` (`deploy:plain` = bare `wrangler deploy`, no SHA) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest (messages, phone, points) |
| `npm run db:schema:local` / `:remote` | Apply `schema.sql` |
| `npm run db:seed:local` / `:remote` | Apply `seed.sql` |

> Full setup/deploy (D1 create, secrets, Twilio webhook) is in the README.

## Conventions & constraints

- **Compliance framing is load-bearing.** Players buy cigars up front and compete
  for cigars — **no money wagered, no cash payouts**. All SMS copy is framed as
  **"game-night reminders," not gambling** (carriers scrutinize gambling content).
  Keep `messages.ts` copy and any Twilio campaign description matching this.
- **Opt-out/HELP are mandatory and built in.** Never repurpose reserved carrier
  keywords (STOP/HELP/etc.); player keywords win over admin commands. STOP is
  recorded but gets **no app reply** (empty TwiML): Twilio's built-in opt-out
  handling already sends the standard confirmation, and an app reply would be
  blocked with error 21610.
- **Validate the Twilio signature** on every inbound webhook (`X-Twilio-Signature`)
  — HMAC-SHA1 via Web Crypto in `lib/twilio.ts` (toggle with
  `VALIDATE_TWILIO_SIGNATURE`).
- **Secrets never in code.** Twilio creds + `ADMIN_PASSWORD` via
  `wrangler secret put` (local: `.dev.vars`, git-ignored). Don't commit secrets.
- **Admin is a password-gated web app** (`lib/auth.ts`), optionally fronted by
  Cloudflare Access in production. SMS is players-only. (ADR-0005; ADR-0003 superseded.)
- **Privacy:** the public board shows first name + last initial only; opt-in copy
  discloses reminders + promos, points tracking, and public name display.
- **Time zone is America/Chicago (Central Time)** for scheduling, reminder
  display, and season-close boundaries.
- **Cadence is biweekly** (every 2 weeks).
- **Twilio throughput:** 10DLC is ~1 msg/sec — mind this for broadcasts as the
  list grows (Messaging Service / batching).

## Where decisions live

See **[docs/adr/](docs/adr/)** and **[docs/requirements.md](docs/requirements.md)**
(consolidated spec). ADRs: `0001` platform, `0002` data model & points, `0003`
SMS admin *(superseded)*, `0004` rewards & attendance, `0005` interaction channels
(SMS players-only + web admin + public board), `0006` tournament RSVPs
(IN confirm + host-paced backfill), `0007` tournament placements (ranks saved
with 0 points; real champion on /seasons), `0008` public tournament visibility
(invite-only notice, never "next game").
`0009` defines automatic tournament operations; `0010` defines designated-dealer messaging.
