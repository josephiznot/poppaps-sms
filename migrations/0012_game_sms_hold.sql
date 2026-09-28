-- Per-game safety hold for custom events whose SMS campaign is not yet approved.
-- Existing games remain sendable; releasing a hold is a separate explicit write.
ALTER TABLE games ADD COLUMN sms_hold INTEGER NOT NULL DEFAULT 0
  CHECK (sms_hold IN (0,1));
