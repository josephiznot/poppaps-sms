-- Reusable member role for tournament dealer notifications. Assignment is a
-- separate production operation; this migration does not identify any member.
ALTER TABLE members ADD COLUMN is_designated_dealer INTEGER NOT NULL DEFAULT 0
  CHECK (is_designated_dealer IN (0,1));

CREATE INDEX IF NOT EXISTS idx_members_designated_dealer
  ON members(is_designated_dealer, status);
