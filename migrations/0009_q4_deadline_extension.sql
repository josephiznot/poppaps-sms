-- Record the host-authorized one-time extension for the already-active 2026-Q4
-- tournament. The ordinary seven-day/10:00 Central policy remains unchanged.
-- Exact plan values and versions make this rerunnable after the live correction.

UPDATE tournament_offers
SET response_deadline = '2026-09-22T02:00:00.000Z',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE state = 'ACTIVE'
  AND replaced_by_offer_id IS NULL
  AND response_deadline = '2026-09-21T15:00:00.000Z'
  AND EXISTS (
    SELECT 1
    FROM tournament_plans p
    JOIN tournament_board b
      ON b.plan_id = p.id
     AND b.member_phone = tournament_offers.member_phone
    JOIN games g
      ON g.id = p.game_id
    WHERE p.id = tournament_offers.plan_id
      AND p.quarter_key = '2026-Q4'
      AND p.status = 'ACTIVE'
      AND p.planned_starts_at = '2026-09-28T23:30:00.000Z'
      AND p.qualification_cutoff = '2026-09-14T15:00:00.000Z'
      AND p.confirmation_deadline = '2026-09-21T15:00:00.000Z'
      AND p.version = 4
      AND p.schedule_version = 1
      AND p.season_id IS NOT NULL
      AND p.cancelled_at IS NULL
      AND b.selected_qualifier = 1
      AND g.is_tournament = 1
      AND g.cancelled = 0
      AND g.starts_at = p.planned_starts_at
  );

UPDATE tournament_plans
SET confirmation_deadline = '2026-09-22T02:00:00.000Z',
    version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE quarter_key = '2026-Q4'
  AND status = 'ACTIVE'
  AND planned_starts_at = '2026-09-28T23:30:00.000Z'
  AND qualification_cutoff = '2026-09-14T15:00:00.000Z'
  AND confirmation_deadline = '2026-09-21T15:00:00.000Z'
  AND version = 4
  AND schedule_version = 1
  AND season_id IS NOT NULL
  AND cancelled_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM tournament_offers o
    JOIN tournament_board b
      ON b.plan_id = o.plan_id
     AND b.member_phone = o.member_phone
    WHERE o.plan_id = tournament_plans.id
      AND o.state = 'ACTIVE'
      AND o.replaced_by_offer_id IS NULL
      AND o.response_deadline = '2026-09-21T15:00:00.000Z'
      AND b.selected_qualifier = 1
  )
  AND EXISTS (
    SELECT 1
    FROM games g
    WHERE g.id = tournament_plans.game_id
      AND g.is_tournament = 1
      AND g.cancelled = 0
      AND g.starts_at = tournament_plans.planned_starts_at
  );
