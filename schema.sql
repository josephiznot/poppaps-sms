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
  updated_at    TEXT NOT NULL
);

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
  created_at    TEXT NOT NULL
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
