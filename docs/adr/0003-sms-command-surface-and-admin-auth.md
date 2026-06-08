# ADR 0003 — SMS command router and admin-by-phone-allowlist

- **Status:** Superseded by [ADR-0005](0005-interaction-channels.md) (2026-06-08)
- **Date:** 2026-06-08

> **⚠️ Superseded.** This ADR proposed running admin actions (winner entry,
> scheduling, run-tournament) *over SMS* via a command router with phone-allowlist
> auth. That approach was replaced by **ADR-0005**: SMS is now **players-only**,
> and all admin moved to an **authenticated web app** (password-gated). The
> content below is kept as the decision trail — **do not build from it.**

## Context

Today the inbound handler (`src/handlers/inboundSms.ts` + `src/lib/messages.ts`)
classifies an inbound text into one of four player intents — **OPT_IN** (JOIN),
**OPT_OUT** (STOP and aliases), **HELP**, **UNKNOWN** — by matching the first
word, and replies with TwiML. That is the entire command surface.

The points roadmap (ADR-0002) introduces **host-only actions over SMS**, chosen
to keep host effort near zero: after each game the host simply **texts the Twilio
number** with that night's winners and the system awards points; the host may
also want to query **standings**. These actions must not be available to players.

There is a **single host** today. Whoever submits results must be authenticated.

## Decision

1. **Turn the inbound handler into a small command router.** Keep the existing
   player keywords (JOIN / STOP / HELP and aliases) exactly as-is for compliance,
   and add an **admin command set** dispatched only for authorized senders.
   Player keywords always win for everyone (so an admin can still STOP), and
   carrier-reserved keywords are never repurposed.

2. **Authorize admins via a phone-number allowlist.** A configured list of
   E.164 numbers (stored as a **secret / env var**, e.g. `ADMIN_PHONES`) is the
   sole gate for admin commands. A message from a non-allowlisted number is never
   treated as an admin command — it falls through to the normal player intents.

3. **Admin commands (initial set):**
   - **Record results** — the host texts the night's finishing order; the router
     writes the top-5 points to the ledger (ADR-0002). Design the syntax for
     **minimal typing**, e.g. positional player names/initials in finishing
     order. Echo back what was recorded so the host can catch mistakes.
   - **Standings** — return current season standings (or top N).
   - **Tournament / Top-8** — on demand, return the current season's **top 8** so
     the host can plan the (manually scheduled, ~4×/yr) Special Players game and
     invite them. The system only *surfaces* the list; the host decides when to
     run the tournament — it is not auto-scheduled.
   - **Schedule game(s)** — create a regular or tournament game (date, time,
     location). NOTE: scheduling is structured and error-prone over plain SMS; the
     *interface* for this command is an **open decision** (SMS vs a tiny
     authenticated web form), not settled here — see Consequences and
     `docs/requirements.md` open decision **D1**.
   - **Close season / run tournament** — trigger the snapshot-then-reset sequence
     from ADR-0002: snapshot the closing season's top 8 → invite them → open a new
     season (logical boundary, no delete). This is a consequential write — see the
     auth note below and open decision **D2**.

## Consequences

- The inbound handler gains a dispatch layer: signature-validate → parse → if
  sender is on the admin allowlist and the body is an admin command, run it;
  otherwise fall through to the existing player-intent switch.
- **Admin auth is deliberately minimal.** A phone allowlist has no roles, no
  audit of who-did-what beyond the ledger's `awardedAt`, and trusts caller-ID
  (which Twilio signature validation protects against forged webhooks, but not
  against a spoofed originating number at the carrier level — acceptable for a
  single trusted host).
- **Result entry is free-text and therefore error-prone.** The echo-back/confirm
  step is the mitigation; it should be built alongside the record-results command,
  not deferred.
- **Scheduling over plain SMS is the weakest fit in this command set.** A date +
  time + location (+ tournament flag) is structured, low-frequency, and has no
  validation or parsed-value echo over text — a fat-fingered date silently
  schedules a reminder for the wrong night. Winner entry (5 ordered names, high
  frequency, low field) is a good SMS fit; scheduling is not. A **tiny
  authenticated web form served by the same Worker** (native date/time pickers, one
  token) may *reduce* host effort and error for scheduling while keeping winner
  entry on SMS. This ADR deliberately does **not** pre-decide SMS-vs-web — it is
  open decision **D1** in `docs/requirements.md` (recommendation there: hybrid).
- **Consequential writes deserve more than caller ID.** Recording points,
  scheduling, and close-season can change reminders and reset a season; the phone
  allowlist trusts a spoofable originating number. Mitigation is a **shared
  secret/PIN in the admin message body** for those commands (or token auth if the
  web form is adopted) — open decision **D2**.
- Compliance is unaffected: STOP/HELP/JOIN behavior and copy are untouched, and
  admin commands are invisible to players.

## Revisit if / Future revisions

- **Multiple admins or multiple venues** → replace the phone allowlist with real
  roles/auth (per-venue admin lists, or accounts), and scope ledger writes by
  venue.
- **The host finds texting results error-prone** even with echo-back → add a
  stronger confirmation step (reply YES to commit) or a **tiny authenticated web
  form** for entering results.
- **The admin command vocabulary grows** → consider a structured prefix (e.g. a
  leading `#` or keyword) to disambiguate admin commands from free text, and a
  HELP-style admin command listing.
- **Caller-ID spoofing becomes a real concern** → add a shared secret/PIN in the
  admin message body in addition to the allowlisted number.
