# ADR 0001 — Cloud platform: Cloudflare Workers + D1 + Cron Triggers

- **Status:** Accepted (pending implementation)
- **Date:** 2026-06-08

## Context

The repo currently contains an **AWS SAM scaffold** — Lambda + API Gateway +
DynamoDB, Node.js/TypeScript, with Twilio for outbound SMS. It was generated but
**never deployed**: no AWS resources exist, no AWS access keys were ever
provided, and the files are only git-*staged*, not committed. There is therefore
**zero switching cost** to changing platforms now.

Two practical frictions surfaced while evaluating the scaffold:

1. **Tooling wall.** The host's machine has Node but **not the AWS CLI or the SAM
   CLI**. The documented deploy path (`sam build`, `sam deploy --guided`,
   `aws ssm put-parameter`, `aws configure`) requires installing and learning two
   AWS-specific CLIs plus IAM and CloudFormation concepts before anything ships.
2. **Concept overhead for a tiny app.** The scheduled reminder is an EventBridge
   schedule wired into a separate Lambda; secrets live in SSM Parameter Store;
   IAM policies are declared per-function. All correct and least-privilege, but a
   lot of moving parts for a biweekly poker reminder run by one person.

The app's shape is modest and idle most of the time: an inbound webhook, an
occasional broadcast, and one scheduled job that does nothing unless a game is
within the reminder window.

## Decision

**Rebuild the service on Cloudflare Workers + D1 (managed SQLite) + Cron
Triggers**, instead of AWS SAM. Outbound SMS goes via plain `fetch` to Twilio's
REST API; secrets via `wrangler secret put`. The same Worker also serves the
**authenticated admin web app** and the **public standings page** (ADR-0005) — one
Worker, three route groups (`/sms`, `/admin/*`, `/`) plus the Cron reminder.

Rationale:

- **One CLI, one deploy.** `wrangler deploy` is the whole story — no IAM, no
  CloudFormation, no separate AWS/SAM CLI install. This directly removes the
  adoption wall above.
- **Cron Triggers are built in.** The scheduled reminder job is one line of
  `wrangler.toml` config (`[triggers] crons = [...]`) instead of a separate
  EventBridge concept wired to a function.
- **No cold starts.** Workers run on V8 isolates; the inbound webhook responds
  promptly without the JVM/Lambda cold-start tax.
- **Generous free tier.** Easily covers a poker list of this size for both
  Workers requests and D1 reads/writes.
- **Lean outbound path.** Calling Twilio's REST API with `fetch` avoids bundling
  the ~9 MB Twilio Node SDK. (Signature *validation* of inbound webhooks still
  needs an HMAC-SHA1 check — implement it with Web Crypto, which the Workers
  runtime provides.)
- **Secrets stay out of code.** `wrangler secret put TWILIO_AUTH_TOKEN` keeps the
  auth token out of the repo and out of `wrangler.toml`.
- **Relational fit.** The near-term roadmap (points standings, quarterly
  aggregation, attendance counts, reward thresholds) is report-shaped and
  relational. D1's SQL is a much better fit than DynamoDB's single-table design.
  See ADR-0002.

### Alternatives considered

- **AWS SAM (the current scaffold) — considered and superseded.** Powerful and a
  generous free tier, and the code already exists. Not chosen *for now* because
  it carries the most boilerplate and the highest setup friction (AWS CLI + SAM
  CLI install, IAM, CloudFormation, SSM, EventBridge) for a solo host who just
  wants reminders and simple points tracking. Kept documented here as the
  considered-and-superseded baseline.
- **Single always-on container** (Render or Fly + `node-cron` + SQLite file).
  Simplest *mental model* — a plain Node process with a cron loop and a local
  DB — and keeps the full Node runtime. Not chosen because it is always-on and
  must be maintained/monitored, which is slight overkill for an app that is idle
  most of the time. Stays the natural fallback if the Workers non-Node runtime
  ever becomes limiting.
- **Supabase** (Postgres + `pg_cron` + Edge Functions + dashboard). Excellent if
  a **visual admin dashboard** for players/rewards becomes a requirement. Not
  chosen now because it adds a hosted Postgres + dashboard surface we do not yet
  need; D1 covers the relational needs at lower operational weight.
- **Twilio-native** (Studio Flows + Twilio Functions). Least infrastructure of
  all. Not chosen because scheduled broadcasts to a stored list are awkward in
  Studio and version control is weak — a poor fit for the points/attendance
  roadmap that wants real data and reviewable code.

## Consequences

- The AWS SAM scaffold (`template.yaml`, `samconfig.toml`, the `@aws-sdk/*`
  dependencies, SSM-based config in `src/lib/config.ts`) becomes **reference
  material to port from**, not the deploy target. Expect to replace
  `src/lib/dynamo.ts` with a D1 data layer and the Twilio SDK calls with `fetch`.
- Need to (re)implement Twilio inbound-signature validation against Web Crypto
  rather than the Twilio SDK's `validateRequest`.
- `package.json` scripts (`sam build`, `sam deploy`, `sam local`) will be
  replaced by `wrangler` equivalents (`wrangler dev`, `wrangler deploy`,
  `wrangler d1 ...`).
- D1 gives us SQL migrations and ad-hoc queries for standings/aggregation, which
  the DynamoDB design would have made awkward.

## Revisit if / Future revisions

- **A visual dashboard is wanted** by the lounge manager to manage players and
  rewards → reconsider **Supabase** (Postgres + built-in dashboard) over
  Workers+D1.
- **Cloudflare's non-Node runtime becomes limiting** (a dependency needs full
  Node APIs that Workers don't provide) → reconsider the **single always-on
  container** option, which keeps the full Node runtime.
- **The subscriber/player base grows by orders of magnitude** → revisit query
  patterns and indexing, and Twilio throughput limits (10DLC is roughly 1
  msg/sec) — consider a Twilio Messaging Service and batching/queueing.
- **POS / loyalty integration** becomes a requirement (see ADR-0004) → reconsider
  a dedicated backend/integration layer rather than an SMS-only Worker.
