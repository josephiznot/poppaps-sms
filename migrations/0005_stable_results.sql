-- Preserve legacy season attribution. New results use game time, not entry time.
ALTER TABLE games ADD COLUMN scoring_at TEXT;
ALTER TABLE games ADD COLUMN results_recorded_at TEXT;
ALTER TABLE games ADD COLUMN result_version INTEGER NOT NULL DEFAULT 0;
UPDATE games SET scoring_at = COALESCE(
  (SELECT MIN(awarded_at) FROM points_ledger p WHERE p.game_id=games.id),
  (SELECT MIN(created_at) FROM attendance a WHERE a.game_id=games.id), starts_at);
UPDATE games SET results_recorded_at = COALESCE(
  (SELECT MAX(awarded_at) FROM points_ledger p WHERE p.game_id=games.id),
  (SELECT MAX(created_at) FROM attendance a WHERE a.game_id=games.id));
-- Preflight duplicate (member_phone,game_id) rows before migration. Fail closed
-- rather than deleting any historical result automatically.
CREATE UNIQUE INDEX idx_points_member_game ON points_ledger(member_phone, game_id);
-- Public identifiers are random, not enumerable hashes of phone numbers.
ALTER TABLE members ADD COLUMN public_id TEXT;
UPDATE members SET public_id=lower(hex(randomblob(16))) WHERE public_id IS NULL;
CREATE UNIQUE INDEX idx_members_public_id ON members(public_id);
