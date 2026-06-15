-- Records the finishing PLACE (1..5) on every result row, so a Special Players
-- tournament's ranks can be saved without awarding season points (ADR-0007).
-- Run once against a DB created before this change:
--   npm run db:migrate:0003:remote   (or :local)
-- (Fresh DBs get the column from schema.sql.)
-- Safe on a live DB: additive column + a one-time backfill.

ALTER TABLE points_ledger ADD COLUMN place INTEGER;

-- Backfill existing rows. Every row so far was written by the post-game handler
-- with points in 1..5 (5=1st … 1=5th), so place = 6 - points. Rows outside that
-- range (none today) stay NULL and fall back to that decode in queries.
UPDATE points_ledger SET place = 6 - points WHERE place IS NULL AND points BETWEEN 1 AND 5;
