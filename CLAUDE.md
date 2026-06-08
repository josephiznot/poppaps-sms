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

- The repo is an **AWS SAM scaffold** (Lambda + API Gateway + DynamoDB,
  Node.js/TypeScript, Twilio SDK). It works as a reminder service on paper but was
  **never deployed**: no AWS resources exist, no AWS keys were ever provided, and
  the files are only git-**staged**, not committed. **Zero switching cost.**
- **Decided direction: rebuild on Cloudflare Workers + D1 (managed SQLite) + Cron
  Triggers** — *not yet implemented*. The AWS code is reference material to port
  from, not the deploy target. See **[docs/adr/0001-cloud-platform.md](docs/adr/0001-cloud-platform.md)**.
- All architectural decisions live in **[docs/adr/](docs/adr/)** — read these
  before designing features (platform, data model, command router, rewards).

## Domain model (target, ledger-oriented — see ADR-0002/0004)

- **Members** — one entity per opted-in person, keyed by **phone** (`displayName`
  = first name + last initial, `status`, opt-in/out timestamps). Subscriber +
  Player collapsed: opt-in = tracked; no opt-in = not in the system.
- **Games** — a scheduled game night (`startsAt`, `location`, `isTournament`,
  reminder-sent, etc.).
- **PointsLedger** — append-only: one row per member per game (`memberPhone`,
  `gameId`, `points`, `awardedAt`). Never mutated; corrections are new rows.
- **Attendance** — append-only, **host-marked** on the post-game admin screen
  (`memberPhone`, `gameId`, `timestamp`). No player self-check-in.
- **Seasons** — append-only season-close log (`closedAt`, top-8 `snapshot`);
  current season = after `MAX(closedAt)`. "Reset" is this boundary, not a delete.
- **RewardRules** + **AwardedRewards** — attendance-based promos; earned + redeemed
  (ADR-0004; rule specifics still forming).

### Points rules (exact — top 5 only)

Host texts the night's finishing order; system awards: **1st = 5, 2nd = 4,
3rd = 3, 4th = 2, 5th = 1**. 6th and below score 0.

### Quarterly "Special Players" tournament

Held **4× a year, host-initiated** — the host plans/schedules it manually; the
system does **not** auto-schedule it (no cron for the tournament). The system only
needs to **be aware**: on demand, when the host is planning a tournament, it
surfaces the **top 8 players by points** (`SUM(points)` over the scoring window,
in Central Time) so the host can invite them via targeted broadcast to a special
game on an off week.

## Interaction surfaces (ADR-0005)

- **SMS = players only.** Out: reminders, tournament invites, promos. In:
  JOIN / STOP / HELP + the JOIN name-capture reply. **No admin over SMS.**
- **Admin = web app** on the same Worker, behind **Cloudflare Access**: schedule
  games, post-game (winners + attendance in one flow), standings, run-tournament,
  roster. Replaces the old SMS command router + phone-allowlist (ADR-0003, superseded).
- **Public = read-only standings page** (no login): current season + past winners,
  **first name + last initial only** (privacy; disclosed at opt-in).

## Roadmap

1. **Game-night reminders** — scaffolded (on AWS; to be ported to Workers).
2. **Members + opt-in name capture** — JOIN captures consent + display name.
3. **Points tracking** — host enters winners on the **admin web app**; append-only
   points ledger; public standings page. (ADR-0002, ADR-0005)
4. **Quarterly special tournament** — *host-initiated* (4×/yr); on-demand top-8 →
   invite → logical season reset. (ADR-0002)
5. **Rewards / attendance** — host-marked attendance → data-driven promos via SMS;
   reward rule specifics still forming. (ADR-0004)
- **Recurring schedule** (anchor + 14-day interval auto-generating games) is a
  natural near-term feature — **not built yet**.

## Repo structure (current — AWS scaffold)

```
template.yaml            SAM infra: Lambdas, API, DynamoDB, hourly schedule, IAM
samconfig.toml           Deploy settings
src/
  handlers/
    inboundSms.ts        Twilio webhook (JOIN/STOP/HELP) — becomes a command router
    broadcast.ts         Ad-hoc broadcast (invoked, not public)
    sendGameReminders.ts Hourly scheduled reminders
  lib/
    config.ts            Env + Twilio token from SSM (cached)
    dynamo.ts            DynamoDB repositories  (-> replace with D1)
    twilio.ts            Client, sender, signature validation, TwiML
    broadcaster.ts       Send-to-all-subscribers
    messages.ts          Keyword parsing (parseIntent) + message copy
    phone.ts             E.164 normalization
  types.ts               Subscriber, Game, BroadcastResult
scripts/                 Local admin CLIs (tsx): add-game, list-games,
                         list-subscribers, broadcast
docs/                    Opt-in page + privacy (GitHub Pages); adr/ = decisions
events/                  Sample webhook event for local invoke
tests/                   Vitest unit tests (messages, phone)
```

## Key commands (from package.json — current AWS scaffold)

| Command | What it does |
| --- | --- |
| `npm install` | Install deps |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest (keyword parsing + phone normalization) |
| `npm run test:watch` | Vitest watch |
| `npm run build` | `sam build` |
| `npm run deploy` / `deploy:guided` | `sam deploy` (do NOT run without confirmation) |
| `npm run validate` | `sam validate --lint` |
| `npm run local:api` | `sam local start-api` (signature check off) |
| `npm run invoke:inbound` | Run webhook handler against `events/inbound-sms.json` |
| `npm run game:add -- --when "2026-06-07 19:00" --location "..."` | Schedule a game |
| `npm run games:list` / `subscribers:list` | List games / subscribers |
| `npm run broadcast -- --message "..." [--dry-run]` | Ad-hoc blast (dry-run first) |

> Note: these are SAM/AWS commands. When the Workers rebuild lands, expect
> `wrangler dev` / `wrangler deploy` / `wrangler d1 ...` to replace them.

## Conventions & constraints

- **Compliance framing is load-bearing.** Players buy cigars up front and compete
  for cigars — **no money wagered, no cash payouts**. All SMS copy is framed as
  **"game-night reminders," not gambling** (carriers scrutinize gambling content).
  Keep `messages.ts` copy and any Twilio campaign description matching this.
- **Opt-out/HELP are mandatory and built in.** Never repurpose reserved carrier
  keywords (STOP/HELP/etc.); player keywords win over admin commands.
- **Validate the Twilio signature** on every inbound webhook (`X-Twilio-Signature`).
  In the Workers port, do the HMAC-SHA1 check with Web Crypto (no Twilio SDK).
- **Secrets never in code.** Twilio Auth Token via SSM today; via
  `wrangler secret put` after the port. Don't commit tokens or `.env`.
- **Admin is a web app behind Cloudflare Access** (not SMS, not a phone allowlist).
  SMS is players-only. (ADR-0005; ADR-0003 superseded.)
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
(SMS players-only + web admin + public board).
