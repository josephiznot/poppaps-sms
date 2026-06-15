-- Adds a "declined" state to tournament RSVPs so an invitee can FOLD (decline)
-- and the host can free the seat immediately, instead of waiting out the
-- confirm-by date (ADR-0006). Run once against a DB created before this change:
--   npm run db:migrate:0004:remote   (or :local)
-- (Fresh DBs get the column from schema.sql.) Safe on a live DB: additive column.

ALTER TABLE tournament_rsvps ADD COLUMN declined_at TEXT;
