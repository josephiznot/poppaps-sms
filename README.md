# Poppa P's Poker Night — SMS

Players text **JOIN** to opt in and get reminders before each biweekly poker
night at the lounge. The host runs everything from a small web app: schedule
games, enter the top-5 winners + attendance after each game, run the quarterly
**Special Players** tournament, and manage promos. A public page shows the
season standings.

Built as **one Cloudflare Worker** (Hono) + **D1** (SQLite) + a **Cron Trigger**.
SMS goes out via Twilio's REST API. See [`docs/`](docs/) for the design + ADRs.

```
 📱 Player ──JOIN/STOP/HELP──▶  POST /sms  ─┐
     ▲  reminders / promos / invites        │   ┌────────────────────┐
     └──────────────────────────────────────┼──▶│  Cloudflare Worker │──▶ D1
                                             │   │  Hono router       │   (SQLite)
 🧑‍💼 Host ──▶  /admin/*  (password) ─────────┤   │  + Cron (hourly)   │
 🌐 Public ──▶  /        (standings) ────────┘   └─────────┬──────────┘
                                                           └──▶ Twilio REST (send SMS)
```

## Surfaces

| Route | Who | What |
| --- | --- | --- |
| `POST /sms` | Players (Twilio webhook) | JOIN / STOP / HELP, the one-step name reply, and IN to confirm a tournament seat. Signature-verified. |
| `/admin/*` | Host (password) | Schedule games; post-game winners + attendance; standings; run tournament; roster + promos. |
| `GET /` | Public | Season standings + recent winners (first name + last initial only). |
| `GET /rules` `/terms` `/privacy` | Public | Game rules + blind structure; program terms; privacy policy. |
| `GET /health` | Public | JSON: which git commit is live, when it was built, and how many commits it is behind `main` on GitHub. The running SHA is baked in at deploy time (see below). |
| Cron `0 * * * *` | — | Hourly: keep the biweekly game on the calendar, then text reminders for games within the lead window (tournament games remind their invitees only). |

---

## Prerequisites

- **Node 24+**
- A **Cloudflare account** (free plan is fine)
- A **Twilio account** with your number — you need the **Account SID** + **Auth Token**

```bash
npm install
```

## Setup & deploy

```bash
# 1. Log in to Cloudflare (opens a browser)
npx wrangler login

# 2. Create the D1 database, then paste the printed database_id into wrangler.toml
npx wrangler d1 create poker-sms

# 3. Create the tables (and an example reward rule) in the remote DB
npm run db:schema:remote
npm run db:seed:remote        # optional; edit seed.sql first if you like

# 4. Set secrets (you'll be prompted to paste each value — they never touch git)
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put ADMIN_PASSWORD       # the password for /admin

# 5. Deploy
npm run deploy
```

> **Always deploy with `npm run deploy`** — it runs `scripts/deploy.mjs`, which
> bakes the current git commit into the Worker (`GIT_SHA`/`GIT_BRANCH`/`BUILT_AT`
> deploy-time vars) so `/health` can report which commit is live. Commit/push
> first, then deploy, so a healthy `/health` reads `commitsBehind: 0`.
> (`npm run deploy:plain` is a bare `wrangler deploy` escape hatch — it skips the
> SHA, and `/health` will show `unknown`.) The repo is public, so `/health`
> queries GitHub unauthenticated; if you make it private, set a token with
> `npx wrangler secret put GITHUB_TOKEN`.

After the first deploy:

1. The site is served at **https://poppaps.cards** (custom domain set in
   `wrangler.toml` → `routes`; `wrangler deploy` provisions DNS + SSL). It also
   stays reachable at the `*.workers.dev` URL. `PUBLIC_BASE_URL` is the custom
   domain so SMS links use it.
2. In the **Twilio Console → your number → Messaging → "A message comes in"**,
   set **Webhook**, **HTTP POST**, to `https://poppaps.cards/sms`.
3. Visit `https://poppaps.cards/admin` and sign in with your `ADMIN_PASSWORD`.
4. (Recommended for production) front `/admin` with **Cloudflare Access** for SSO
   on top of the password — see ADR-0005.

Text **JOIN** to your number from your phone to test the whole loop.

> **Upgrading an existing deployment?** When the schema changes, apply the new
> migration to your live DB *before* (re)deploying — migrations are additive and
> safe to run once (each has its own script; run the ones added since your last
> deploy):
>
> ```bash
> npm run db:migrate:remote        # 0001 — recurring games
> npm run db:migrate:0002:remote   # 0002 — tournament RSVPs
> npm run db:migrate:0003:remote   # 0003 — finishing place on result rows
> npm run deploy
> ```

## Local development

```bash
cp .dev.vars.example .dev.vars     # fill in test/real values (git-ignored)
npm run db:schema:local            # one-time: create local tables
npm run db:seed:local              # optional
npm run dev                        # http://127.0.0.1:8787
```

With `VALIDATE_TWILIO_SIGNATURE=false` in `.dev.vars` you can hit the webhook
directly:

```bash
curl -X POST http://127.0.0.1:8787/sms --data 'From=%2B15555550123&Body=JOIN'
```

Real SMS sending still needs valid Twilio creds in `.dev.vars`; everything else
(admin UI, standings, scheduling, points) works fully offline.

## Day-to-day

- **Record results** after each game. Choose finishers and attendance. Results save atomically; editing an old game preserves its season. Tournament results award zero season points.
- **Tournament dates appear automatically**: first off-week Monday each quarter, 6:30 PM Central. Invitations and qualification close are fourteen days before play at 10:00 AM Central. Replies are due two days before play at 6:00 PM.
- **2026 transition**: the next tournament is September 28. Qualification closes September 14, making September 7 the final scoring game of the current season; September 21 begins the next season. Normal quarterly scheduling resumes in 2027.
- **No routine tournament button.** The hourly job freezes eight qualifiers, closes the scoring season, queues invitations and fills clear-cut vacancies. STOP is authoritative; FOLD declines only the seat. Expired/replaced offers cannot reclaim a seat.
- **Tournament page**: reschedule when a date conflicts, resolve a final-seat tie, inspect missing results or uncertain delivery. Date changes after invitations notify current invitees once. Cancelled quarterly events are not regenerated.
- **Roster**: tidy names and mark earned promos redeemed. Public names are always minimized; profile IDs are random.

## Upgrading to automatic tournaments

Read [ADR-0009](docs/adr/0009-automatic-tournaments.md). Apply migrations **0005 then 0006** before deploying this revision. Do not run the fresh schema against a legacy database as a substitute for migrations.

1. Back up D1 and confirm no duplicate member/game ledger rows or duplicate season-close timestamps. Resolve anomalies explicitly; migrations never delete history to make a constraint pass.
2. Apply migrations 0005 and 0006 using the matching npm scripts. 0005 preserves existing effective scoring times and creates random public profile IDs; old hashed profile bookmarks no longer resolve.
3. Deploy the checked revision. Existing completed seasons remain historical; past tournaments are never re-invited. Initial automatic planning skips past or less-than-fourteen-day-away quarterly dates.
4. Verify health and public/admin reads. Let the real cron run; **never send production texts as a smoke test**. Provider acceptance and delivered receipts are displayed separately.

Local verification: Node 24+, npm ci, npm test, npm run typecheck, and a Wrangler dry-run build. Database tests use real in-memory SQLite and fake Twilio transport. No test credentials or production database are required.

## What I need from you (credentials/config)

See the deploy steps — concretely: a **Cloudflare account** (`wrangler login`),
your **Twilio Account SID** + **Auth Token** (set as secrets), an **ADMIN_PASSWORD**
you choose, and the **D1 `database_id`** from `wrangler d1 create` pasted into
`wrangler.toml`. After deploy, paste the **Worker URL** into Twilio's webhook
setting and into `PUBLIC_BASE_URL`.

## Compliance notes

- **Opt-in disclosure must be shown *before* anyone texts JOIN.** Wherever opt-in
  is collected (a sign/card at the lounge, or a web page), the call-to-action must
  display: program name · what they'll get (reminders + promos) · "Recurring msgs;
  frequency varies" · "Msg & data rates may apply" · "Reply STOP to cancel, HELP
  for help" · "Consent is not a condition of any purchase" · links to `/terms` and
  `/privacy`. **Ready-made artifacts** carrying all of this:
  - [`docs/opt-in-sign.md`](docs/opt-in-sign.md) — printable counter card for the lounge.
  - [`docs/opt-in-web.html`](docs/opt-in-web.html) — embeddable web version for a website.

  (Twilio doesn't require a *physical* sign specifically — it requires consent +
  these disclosures at the opt-in point, in any medium. The Twilio number may only
  message people who have already opted in.)
- SMS is **players-only**: reminders, promos, invites out; JOIN/STOP/HELP in.
  STOP/HELP are handled; copy is framed as **game reminders + promos**, not
  gambling (cigars, no cash) — carriers scrutinize gambling content.
- The program **terms** and **privacy policy** are served live by the Worker at
  **`/terms`** and **`/privacy`** (on Cloudflare, no GitHub Pages). They disclose
  reminders, promos, points tracking, and public display of first name + last
  initial. (`docs/index.md` / `docs/privacy.md` are the editable source.)
- The public page shows **first name + last initial only** — never fuller PII.

## Project structure

```
wrangler.toml          Worker config: D1 binding, cron, vars
schema.sql / seed.sql  D1 tables + example reward rule
src/
  index.ts             Worker entry: routes + scheduled (cron) handler
  types.ts             Env bindings + domain types
  routes/
    sms.ts             Twilio webhook (player intents + name capture)
    admin.ts           Host web app (login, games, post-game, tournament, roster)
    public.ts          Public standings page
  lib/
    db.ts              All D1 queries
    twilio.ts          Send (fetch) + signature validation (Web Crypto) + TwiML
    messages.ts        Keyword parsing + SMS copy
    jobs.ts            Reminders cron + reward engine
    points.ts          Scoring (pure)
    phone.ts           E.164 (pure)
    auth.ts            Admin session cookie
    html.ts            Server-rendered HTML layout
docs/                  Design: requirements.md + ADRs + opt-in/privacy pages
tests/                 Vitest unit tests (messages, phone, points)
```

## Commands

| Command | Does |
| --- | --- |
| `npm run dev` | Local dev server (Miniflare + local D1) |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest unit tests |
| `npm run db:schema:local` / `:remote` | Apply `schema.sql` |
| `npm run db:seed:local` / `:remote` | Apply `seed.sql` |
