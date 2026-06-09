-- Adds recurring-schedule support to an existing games table.
-- Run once against a DB created before this change:
--   npm run db:migrate:remote   (or :local)
-- (Fresh DBs get these from schema.sql and don't need this.)

ALTER TABLE games ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN series_date TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_games_series_date ON games(series_date);
