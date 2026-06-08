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
| `POST /sms` | Players (Twilio webhook) | JOIN / STOP / HELP + the one-step name reply. Signature-verified. |
| `/admin/*` | Host (password) | Schedule games; post-game winners + attendance; standings; run tournament; roster + promos. |
| `GET /` | Public | Season standings + recent winners (first name + last initial only). |
| Cron `0 * * * *` | — | Hourly: text reminders for games within the lead window. |

---

## Prerequisites

- **Node 20+**
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

After the first deploy:

1. Copy your Worker URL (e.g. `https://poker-sms.<you>.workers.dev`) into
   `wrangler.toml` as `PUBLIC_BASE_URL`, and `npm run deploy` again (so SMS can
   link to the standings page).
2. In the **Twilio Console → your number → Messaging → "A message comes in"**,
   set **Webhook**, **HTTP POST**, to `https://…workers.dev/sms`.
3. Visit `https://…workers.dev/admin` and sign in with your `ADMIN_PASSWORD`.
4. (Recommended for production) front `/admin` with **Cloudflare Access** for SSO
   on top of the password — see ADR-0005.

Text **JOIN** to your number from your phone to test the whole loop.

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

## Day-to-day (all in `/admin`)

- **Games** — schedule a game (date/time pickers; Central time; past dates OK for
  backfill). Mark a game as the Special Players tournament with the checkbox.
- **Post-game** (open a game) — tap who attended and pick the top 5; saving awards
  5·4·3·2·1 points and fires any earned promos.
- **Standings** — current season.
- **Tournament** — top 8 are pre-checked (adjust to break any tie), send invites,
  and the season resets (logical — nothing is deleted).
- **Roster** — tidy display names; mark earned promos redeemed.

## What I need from you (credentials/config)

See the deploy steps — concretely: a **Cloudflare account** (`wrangler login`),
your **Twilio Account SID** + **Auth Token** (set as secrets), an **ADMIN_PASSWORD**
you choose, and the **D1 `database_id`** from `wrangler d1 create` pasted into
`wrangler.toml`. After deploy, paste the **Worker URL** into Twilio's webhook
setting and into `PUBLIC_BASE_URL`.

## Compliance notes

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
