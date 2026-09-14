-- Correct the already-materialized 2026-Q4 tournament to the seven-day initial
-- RSVP policy. Exact old values keep this migration scoped and rerunnable.

-- If qualification ran before this migration, proceed only when every initial
-- invite is safely unsent. Keep its queued/known-failed body consistent with the
-- stored deadline. Any sending, accepted, delivered, unknown, or suppressed
-- initial invite leaves the ACTIVE plan untouched for explicit reconciliation.
UPDATE sms_deliveries
SET body = replace(
      body,
      'Reply CALL by Sat, Sep 26, 6:00 PM CDT',
      'Reply CALL by Mon, Sep 21, 10:00 AM CDT'
    ),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE kind = 'TOURNAMENT_INVITE'
  AND state IN ('QUEUED', 'FAILED')
  AND EXISTS (
    SELECT 1
    FROM tournament_plans p
    JOIN tournament_board b
      ON b.plan_id = p.id
     AND b.member_phone = sms_deliveries.recipient
    WHERE p.id = sms_deliveries.plan_id
      AND p.quarter_key = '2026-Q4'
      AND p.planned_starts_at = '2026-09-28T23:30:00.000Z'
      AND p.qualification_cutoff = '2026-09-14T15:00:00.000Z'
      AND p.confirmation_deadline = '2026-09-26T23:00:00.000Z'
      AND p.status = 'ACTIVE'
      AND b.selected_qualifier = 1
      AND NOT EXISTS (
        SELECT 1
        FROM sms_deliveries sent
        JOIN tournament_board initial
          ON initial.plan_id = p.id
         AND initial.member_phone = sent.recipient
         AND initial.selected_qualifier = 1
        WHERE sent.plan_id = p.id
          AND sent.kind = 'TOURNAMENT_INVITE'
          AND sent.state NOT IN ('QUEUED', 'FAILED')
      )
  );

UPDATE tournament_offers
SET response_deadline = '2026-09-21T15:00:00.000Z',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE state = 'ACTIVE'
  AND response_deadline = '2026-09-26T23:00:00.000Z'
  AND EXISTS (
    SELECT 1
    FROM tournament_plans p
    JOIN tournament_board b
      ON b.plan_id = p.id
     AND b.member_phone = tournament_offers.member_phone
    WHERE p.id = tournament_offers.plan_id
      AND p.quarter_key = '2026-Q4'
      AND p.planned_starts_at = '2026-09-28T23:30:00.000Z'
      AND p.qualification_cutoff = '2026-09-14T15:00:00.000Z'
      AND p.confirmation_deadline = '2026-09-26T23:00:00.000Z'
      AND p.status = 'ACTIVE'
      AND b.selected_qualifier = 1
      AND NOT EXISTS (
        SELECT 1
        FROM sms_deliveries sent
        JOIN tournament_board initial
          ON initial.plan_id = p.id
         AND initial.member_phone = sent.recipient
         AND initial.selected_qualifier = 1
        WHERE sent.plan_id = p.id
          AND sent.kind = 'TOURNAMENT_INVITE'
          AND sent.state NOT IN ('QUEUED', 'FAILED')
      )
  );

UPDATE tournament_plans
SET confirmation_deadline = '2026-09-21T15:00:00.000Z',
    version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE quarter_key = '2026-Q4'
  AND planned_starts_at = '2026-09-28T23:30:00.000Z'
  AND qualification_cutoff = '2026-09-14T15:00:00.000Z'
  AND confirmation_deadline = '2026-09-26T23:00:00.000Z'
  AND (
    status = 'SCHEDULED'
    OR (
      status = 'ACTIVE'
      AND NOT EXISTS (
        SELECT 1
        FROM sms_deliveries sent
        JOIN tournament_board initial
          ON initial.plan_id = tournament_plans.id
         AND initial.member_phone = sent.recipient
         AND initial.selected_qualifier = 1
        WHERE sent.plan_id = tournament_plans.id
          AND sent.kind = 'TOURNAMENT_INVITE'
          AND sent.state NOT IN ('QUEUED', 'FAILED')
      )
    )
  );
