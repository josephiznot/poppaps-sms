-- Durable approval and schedule record for one-off SMS campaigns.
CREATE TABLE IF NOT EXISTS sms_campaigns (
  id            TEXT PRIMARY KEY,
  game_id       TEXT NOT NULL,
  body          TEXT NOT NULL,
  scheduled_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  approved_at   TEXT,
  queued_at     TEXT,
  cancelled_at  TEXT,
  created_at    TEXT NOT NULL
);

ALTER TABLE sms_deliveries ADD COLUMN campaign_id TEXT;

CREATE INDEX IF NOT EXISTS idx_sms_deliveries_campaign
  ON sms_deliveries(campaign_id, created_at);
