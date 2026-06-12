-- Adds tournament RSVP tracking to an existing (live) database.
-- Run once against a DB created before this change:
--   npm run db:migrate:0002:remote   (or :local)
-- (Fresh DBs get this from schema.sql and don't need it.)
-- Safe on a live DB: additive CREATE TABLE IF NOT EXISTS only.

-- One row per invited player per tournament (season close). confirmed_at is
-- set when the player replies IN; NULL = no reply yet. Backfill invites
-- ("next in line") add rows to the same season after the close.
CREATE TABLE IF NOT EXISTS tournament_rsvps (
  id           TEXT PRIMARY KEY,
  season_id    TEXT NOT NULL,           -- seasons.id of the close that issued the invite
  member_phone TEXT NOT NULL,
  invited_at   TEXT NOT NULL,
  confirmed_at TEXT,                    -- NULL = no reply yet
  UNIQUE(season_id, member_phone)
);
CREATE INDEX IF NOT EXISTS idx_rsvps_season ON tournament_rsvps(season_id);
