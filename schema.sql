-- Poppa P's Poker Night — D1 schema (ADR-0002 / 0004 / 0005).
-- Apply: npm run db:schema:local  (or :remote after deploy).

CREATE TABLE IF NOT EXISTS members (
  phone         TEXT PRIMARY KEY,        -- E.164, e.g. +16155550123
  display_name  TEXT,                    -- "First L" (shown publicly)
  status        TEXT NOT NULL DEFAULT 'SUBSCRIBED',  -- SUBSCRIBED | UNSUBSCRIBED
  awaiting_name INTEGER NOT NULL DEFAULT 0,           -- 1 = next inbound text is their name
  source        TEXT,
  opted_in_at   TEXT,
  opted_out_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  public_id     TEXT DEFAULT (lower(hex(randomblob(16)))),
  is_designated_dealer INTEGER NOT NULL DEFAULT 0 CHECK (is_designated_dealer IN (0,1))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_public_id ON members(public_id);
CREATE INDEX IF NOT EXISTS idx_members_designated_dealer ON members(is_designated_dealer, status);

CREATE TABLE IF NOT EXISTS games (
  id            TEXT PRIMARY KEY,
  starts_at     TEXT NOT NULL,           -- ISO-8601 UTC
  location      TEXT NOT NULL,
  is_tournament INTEGER NOT NULL DEFAULT 0,
  description   TEXT,
  buy_in        TEXT,
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  cancelled     INTEGER NOT NULL DEFAULT 0,
  series_date   TEXT,                    -- local date key for auto-scheduled games (NULL = one-off)
  created_at    TEXT NOT NULL,
  scoring_at    TEXT,
  results_recorded_at TEXT,
  result_version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_games_starts_at ON games(starts_at);
-- One auto-generated game per recurring date (also blocks duplicate generation).
-- One-off games have series_date NULL; SQLite treats NULLs as distinct in a UNIQUE
-- index, so multiple one-offs coexist while recurring dates stay unique.
CREATE UNIQUE INDEX IF NOT EXISTS idx_games_series_date ON games(series_date);

-- Append-only. One row per member per game; corrections are new (possibly
-- negative) rows. Never UPDATE/DELETE.
CREATE TABLE IF NOT EXISTS points_ledger (
  id           TEXT PRIMARY KEY,
  member_phone TEXT NOT NULL,
  game_id      TEXT NOT NULL,
  points       INTEGER NOT NULL,        -- season points; 0 for tournament rows (D5)
  place        INTEGER,                 -- finishing place 1..5 (records rank even when points=0)
  awarded_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_points_member ON points_ledger(member_phone);
CREATE INDEX IF NOT EXISTS idx_points_awarded_at ON points_ledger(awarded_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_points_member_game ON points_ledger(member_phone, game_id);

-- Append-only, host-marked. UNIQUE keeps it idempotent per member+game.
CREATE TABLE IF NOT EXISTS attendance (
  id           TEXT PRIMARY KEY,
  member_phone TEXT NOT NULL,
  game_id      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE(member_phone, game_id)
);
CREATE INDEX IF NOT EXISTS idx_attendance_member ON attendance(member_phone);

-- Season-close log. "Reset" = a new row here, never a delete. Current season =
-- everything after MAX(closed_at). snapshot = JSON of the closing season's top 8.
CREATE TABLE IF NOT EXISTS seasons (
  id        TEXT PRIMARY KEY,
  closed_at TEXT NOT NULL,
  snapshot  TEXT NOT NULL
);

-- Tournament invite RSVPs. One row per invited player per season close;
-- confirmed_at set when the player replies IN (NULL = no reply). Host-paced
-- backfill ("next in line") adds rows to the same season after the close.
CREATE TABLE IF NOT EXISTS tournament_rsvps (
  id           TEXT PRIMARY KEY,
  season_id    TEXT NOT NULL,
  member_phone TEXT NOT NULL,
  invited_at   TEXT NOT NULL,
  confirmed_at TEXT,                    -- set when they CALL (confirm); NULL = not confirmed
  declined_at  TEXT,                    -- set when they FOLD (decline); latest action wins
  UNIQUE(season_id, member_phone)
);
CREATE INDEX IF NOT EXISTS idx_rsvps_season ON tournament_rsvps(season_id);

CREATE TABLE IF NOT EXISTS reward_rules (
  id             TEXT PRIMARY KEY,
  every_n_visits INTEGER NOT NULL,
  reward_text    TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1
);

-- One row per (member, rule, threshold) so a promo fires once per crossing.
CREATE TABLE IF NOT EXISTS awarded_rewards (
  id           TEXT PRIMARY KEY,
  member_phone TEXT NOT NULL,
  rule_id      TEXT NOT NULL,
  threshold    INTEGER NOT NULL,        -- visit count at which it was earned
  reward_text  TEXT NOT NULL,
  awarded_at   TEXT NOT NULL,
  redeemed_at  TEXT,
  UNIQUE(member_phone, rule_id, threshold)
);
CREATE INDEX IF NOT EXISTS idx_awarded_member ON awarded_rewards(member_phone);

-- Automatic quarterly tournaments and durable outbound delivery (migration 0006).
-- Durable automatic quarterly tournaments and per-recipient SMS outbox (ADR-0009).
-- Apply after 0005_stable_results.sql. Additive and safe for existing rows.

CREATE TABLE IF NOT EXISTS tournament_plans (
  id                       TEXT PRIMARY KEY,
  quarter_key              TEXT NOT NULL UNIQUE,
  game_id                  TEXT NOT NULL UNIQUE,
  status                   TEXT NOT NULL DEFAULT 'SCHEDULED'
                              CHECK (status IN ('SCHEDULED','BLOCKED','ACTIVE','COMPLETED','CANCELLED')),
  planned_starts_at        TEXT NOT NULL,
  qualification_cutoff     TEXT NOT NULL,
  confirmation_deadline    TEXT NOT NULL,
  season_id                TEXT UNIQUE,
  blocked_reason           TEXT,
  tie_score                INTEGER,
  tie_resolution           TEXT,
  version                  INTEGER NOT NULL DEFAULT 1,
  schedule_version         INTEGER NOT NULL DEFAULT 1,
  mutation_token           TEXT,
  closed_at                TEXT,
  cancelled_at             TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tournament_plans_status
  ON tournament_plans(status, planned_starts_at);

-- A season boundary is an effective timestamp. Repeated close attempts must
-- resolve to the same persisted boundary rather than opening two seasons.
CREATE UNIQUE INDEX IF NOT EXISTS idx_seasons_closed_at_unique ON seasons(closed_at);

-- Complete frozen qualification board, including opted-out members and players
-- below the cut. rank is the stable display order; score_rank preserves ties.
CREATE TABLE IF NOT EXISTS tournament_board (
  plan_id             TEXT NOT NULL,
  member_phone        TEXT NOT NULL,
  display_name        TEXT,
  rank                 INTEGER NOT NULL,
  score_rank           INTEGER NOT NULL,
  points               INTEGER NOT NULL,
  scoring_tiebreak_at  TEXT NOT NULL,
  was_subscribed       INTEGER NOT NULL,
  selected_qualifier  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (plan_id, member_phone),
  UNIQUE (plan_id, rank)
);
CREATE INDEX IF NOT EXISTS idx_tournament_board_order
  ON tournament_board(plan_id, rank);

-- Every person ever offered a seat remains here. Only ACTIVE and CONFIRMED
-- reserve one of the eight seats. Once replaced, an old offer cannot reclaim it.
CREATE TABLE IF NOT EXISTS tournament_offers (
  id                    TEXT PRIMARY KEY,
  plan_id               TEXT NOT NULL,
  member_phone          TEXT NOT NULL,
  board_rank            INTEGER NOT NULL,
  state                 TEXT NOT NULL
                          CHECK (state IN ('ACTIVE','CONFIRMED','DECLINED','EXPIRED','REPLACED','OPTED_OUT','CANCELLED')),
  offered_at            TEXT NOT NULL,
  response_deadline     TEXT NOT NULL,
  confirmed_at          TEXT,
  declined_at           TEXT,
  retired_at            TEXT,
  replaced_by_offer_id  TEXT,
  updated_at            TEXT NOT NULL,
  UNIQUE (plan_id, member_phone),
  UNIQUE (replaced_by_offer_id)
);
CREATE INDEX IF NOT EXISTS idx_tournament_offers_plan_state
  ON tournament_offers(plan_id, state, board_rank);
CREATE TRIGGER IF NOT EXISTS trg_tournament_offer_capacity_insert
BEFORE INSERT ON tournament_offers
WHEN NEW.state IN ('ACTIVE','CONFIRMED') AND
     (SELECT COUNT(*) FROM tournament_offers WHERE plan_id=NEW.plan_id AND state IN ('ACTIVE','CONFIRMED')) >= 8
BEGIN
  SELECT RAISE(ABORT, 'tournament offer capacity exceeded');
END;
CREATE TRIGGER IF NOT EXISTS trg_tournament_offer_capacity_update
BEFORE UPDATE OF state ON tournament_offers
WHEN OLD.state NOT IN ('ACTIVE','CONFIRMED') AND NEW.state IN ('ACTIVE','CONFIRMED') AND
     (SELECT COUNT(*) FROM tournament_offers WHERE plan_id=NEW.plan_id AND state IN ('ACTIVE','CONFIRMED')) >= 8
BEGIN
  SELECT RAISE(ABORT, 'tournament offer capacity exceeded');
END;

-- Provider transport is separate from business intent. An UNKNOWN send is
-- never retried automatically because the carrier may have accepted it.
CREATE TABLE IF NOT EXISTS sms_deliveries (
  id                    TEXT PRIMARY KEY,
  logical_key           TEXT NOT NULL,
  plan_id               TEXT,
  game_id               TEXT,
  offer_id              TEXT,
  recipient             TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  body                  TEXT NOT NULL,
  version               INTEGER NOT NULL DEFAULT 1,
  state                 TEXT NOT NULL DEFAULT 'QUEUED'
                          CHECK (state IN ('QUEUED','SENDING','ACCEPTED','DELIVERED','FAILED','UNKNOWN','SUPPRESSED')),
  provider_sid          TEXT UNIQUE,
  provider_status       TEXT,
  provider_status_rank  INTEGER NOT NULL DEFAULT 0,
  retryable             INTEGER NOT NULL DEFAULT 0,
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  claim_token           TEXT,
  claimed_at            TEXT,
  attempted_at          TEXT,
  accepted_at           TEXT,
  delivered_at          TEXT,
  failed_at             TEXT,
  last_error_code       TEXT,
  last_error            TEXT,
  expires_at            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (logical_key, recipient)
);
CREATE INDEX IF NOT EXISTS idx_sms_deliveries_outbox
  ON sms_deliveries(state, retryable, created_at);
CREATE INDEX IF NOT EXISTS idx_sms_deliveries_plan
  ON sms_deliveries(plan_id, created_at);
