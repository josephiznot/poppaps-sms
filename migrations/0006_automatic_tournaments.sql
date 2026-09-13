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
