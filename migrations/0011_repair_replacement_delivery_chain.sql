-- Repair the exact 2026-Q4 replacement chain whose offers committed without
-- their outbox rows because of the replacement-delivery bind-order bug.
-- These three offers were never sent. Removing their false offer/RSVP records
-- lets the fixed hourly tick offer the seat to rank 9 again and queue its SMS.
-- This migration never creates an offer, queues a delivery, or calls a provider.

DROP VIEW IF EXISTS repair_0011_replacement_chain;
CREATE VIEW repair_0011_replacement_chain AS
SELECT p.id AS plan_id
FROM tournament_plans p
JOIN games g ON g.id=p.game_id
JOIN tournament_offers source ON source.id='37eb98c0-a396-4815-8637-c4a05746f28e' AND source.plan_id=p.id
JOIN tournament_offers sean ON sean.id='7e6b7b04-1031-4752-9360-b373b28c9ef0' AND sean.plan_id=p.id
JOIN tournament_offers tyler ON tyler.id='6eec5ee5-dd89-450f-bd40-7027158f29d0' AND tyler.plan_id=p.id
JOIN tournament_offers gleason ON gleason.id='0b5d5534-d77e-4903-bf9e-5c8e9e7a31c3' AND gleason.plan_id=p.id
WHERE p.id='3ddbe6ee-19d6-49b9-b165-bb62513ac814'
  AND p.quarter_key='2026-Q4' AND p.status='ACTIVE' AND p.schedule_version=1
  AND p.season_id='de5fded5-f84b-424f-91dd-2aceb9dbbee6'
  AND p.blocked_reason IS NULL AND p.tie_score IS NULL AND p.cancelled_at IS NULL
  AND g.is_tournament=1 AND g.cancelled=0
  AND g.starts_at='2026-09-28T23:30:00.000Z' AND g.starts_at=p.planned_starts_at
  AND source.member_phone='+18033197543' AND source.board_rank=4 AND source.state='REPLACED'
  AND source.offered_at='2026-09-14T15:00:13.735Z'
  AND source.response_deadline='2026-09-21T15:00:00.000Z'
  AND source.confirmed_at IS NULL
  AND source.declined_at='2026-09-14T15:05:35.206Z'
  AND source.retired_at='2026-09-14T15:05:35.206Z'
  AND source.updated_at='2026-09-14T15:05:35.206Z'
  AND (source.replaced_by_offer_id='7e6b7b04-1031-4752-9360-b373b28c9ef0' OR source.replaced_by_offer_id IS NULL)
  AND sean.member_phone='+16298990220' AND sean.board_rank=9 AND sean.state='REPLACED'
  AND sean.offered_at='2026-09-14T15:05:35.206Z'
  AND sean.response_deadline='2026-09-15T15:05:35.206Z'
  AND sean.confirmed_at IS NULL AND sean.declined_at IS NULL
  AND sean.retired_at='2026-09-15T16:00:50.193Z'
  AND sean.updated_at='2026-09-15T16:00:50.193Z'
  AND sean.replaced_by_offer_id='6eec5ee5-dd89-450f-bd40-7027158f29d0'
  AND tyler.member_phone='+14409850104' AND tyler.board_rank=10 AND tyler.state='REPLACED'
  AND tyler.offered_at='2026-09-15T16:00:50.193Z'
  AND tyler.response_deadline='2026-09-16T16:00:50.193Z'
  AND tyler.confirmed_at IS NULL AND tyler.declined_at IS NULL
  AND tyler.retired_at='2026-09-16T16:00:53.443Z'
  AND tyler.updated_at='2026-09-21T15:00:33.116Z'
  AND tyler.replaced_by_offer_id='0b5d5534-d77e-4903-bf9e-5c8e9e7a31c3'
  AND gleason.member_phone='+13345240200' AND gleason.board_rank=11 AND gleason.state='ACTIVE'
  AND gleason.offered_at='2026-09-21T15:00:33.116Z'
  AND gleason.response_deadline='2026-09-22T15:00:33.116Z'
  AND gleason.confirmed_at IS NULL AND gleason.declined_at IS NULL
  AND gleason.retired_at IS NULL AND gleason.replaced_by_offer_id IS NULL
  AND gleason.updated_at='2026-09-21T15:00:33.116Z'
  AND EXISTS (
    SELECT 1 FROM sms_deliveries d
    WHERE d.offer_id=source.id AND d.recipient=source.member_phone
      AND d.kind='TOURNAMENT_INVITE' AND d.state='DELIVERED'
      AND d.provider_sid IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM sms_deliveries d
    WHERE d.offer_id IN (sean.id,tyler.id,gleason.id)
       OR (d.recipient=sean.member_phone
           AND d.logical_key='tournament:' || p.id || ':replacement:' || sean.member_phone)
       OR (d.recipient=tyler.member_phone
           AND d.logical_key='tournament:' || p.id || ':replacement:' || tyler.member_phone)
       OR (d.recipient=gleason.member_phone
           AND d.logical_key='tournament:' || p.id || ':replacement:' || gleason.member_phone)
  )
  AND EXISTS (
    SELECT 1 FROM tournament_board b JOIN members m ON m.phone=b.member_phone
    WHERE b.plan_id=p.id AND b.member_phone=sean.member_phone AND b.rank=9
      AND m.status='SUBSCRIBED'
  )
  AND EXISTS (
    SELECT 1 FROM tournament_board b JOIN members m ON m.phone=b.member_phone
    WHERE b.plan_id=p.id AND b.member_phone=tyler.member_phone AND b.rank=10
      AND m.status='SUBSCRIBED'
  )
  AND EXISTS (
    SELECT 1 FROM tournament_board b JOIN members m ON m.phone=b.member_phone
    WHERE b.plan_id=p.id AND b.member_phone=gleason.member_phone AND b.rank=11
      AND m.status='SUBSCRIBED'
  )
  AND (SELECT COUNT(*) FROM tournament_offers current_offer
       WHERE current_offer.plan_id=p.id AND current_offer.state IN ('ACTIVE','CONFIRMED')
         AND COALESCE((SELECT h.counts_ranked_seat FROM tournament_host_offers h
                       WHERE h.offer_id=current_offer.id),1)=1)=8
  AND (SELECT COUNT(*) FROM tournament_host_offers h
       JOIN tournament_offers host_offer ON host_offer.id=h.offer_id AND host_offer.plan_id=h.plan_id
       JOIN members host_member ON host_member.phone=h.member_phone
       WHERE h.plan_id=p.id AND h.counts_ranked_seat=0
         AND host_offer.state IN ('ACTIVE','CONFIRMED')
         AND host_member.is_designated_dealer=1)=1
  AND (SELECT COUNT(*) FROM members WHERE is_designated_dealer=1)=1
  AND (
    (source.replaced_by_offer_id='7e6b7b04-1031-4752-9360-b373b28c9ef0' AND
      (SELECT COUNT(*) FROM tournament_rsvps r WHERE
        (r.id='afdc238e-e442-4422-947a-249f309ff88f' AND r.season_id=p.season_id AND r.member_phone=sean.member_phone
          AND r.invited_at='2026-09-14T15:05:35.206Z' AND r.confirmed_at IS NULL AND r.declined_at IS NULL) OR
        (r.id='7e7821ba-cf40-4ffd-8eb7-e48187b9b87c' AND r.season_id=p.season_id AND r.member_phone=tyler.member_phone
          AND r.invited_at='2026-09-15T16:00:50.193Z' AND r.confirmed_at IS NULL AND r.declined_at IS NULL) OR
        (r.id='4cdbe178-c177-4a33-a12b-9195048a864e' AND r.season_id=p.season_id AND r.member_phone=gleason.member_phone
          AND r.invited_at='2026-09-21T15:00:33.116Z' AND r.confirmed_at IS NULL AND r.declined_at IS NULL))=3)
    OR
    (source.replaced_by_offer_id IS NULL AND
      ((SELECT COUNT(*) FROM tournament_rsvps r WHERE
        (r.id='afdc238e-e442-4422-947a-249f309ff88f' AND r.season_id=p.season_id AND r.member_phone=sean.member_phone
          AND r.invited_at='2026-09-14T15:05:35.206Z' AND r.confirmed_at IS NULL AND r.declined_at IS NULL) OR
        (r.id='7e7821ba-cf40-4ffd-8eb7-e48187b9b87c' AND r.season_id=p.season_id AND r.member_phone=tyler.member_phone
          AND r.invited_at='2026-09-15T16:00:50.193Z' AND r.confirmed_at IS NULL AND r.declined_at IS NULL) OR
        (r.id='4cdbe178-c177-4a33-a12b-9195048a864e' AND r.season_id=p.season_id AND r.member_phone=gleason.member_phone
          AND r.invited_at='2026-09-21T15:00:33.116Z' AND r.confirmed_at IS NULL AND r.declined_at IS NULL))=3
       OR (SELECT COUNT(*) FROM tournament_rsvps r WHERE r.id IN (
         'afdc238e-e442-4422-947a-249f309ff88f',
         '7e7821ba-cf40-4ffd-8eb7-e48187b9b87c',
         '4cdbe178-c177-4a33-a12b-9195048a864e'))=0))
  );

-- The source really declined; keep that state and its actual history. Only
-- detach the phantom chain so the scheduler can attach the next real offer.
UPDATE tournament_offers
SET replaced_by_offer_id=NULL
WHERE id='37eb98c0-a396-4815-8637-c4a05746f28e'
  AND replaced_by_offer_id='7e6b7b04-1031-4752-9360-b373b28c9ef0'
  AND EXISTS (SELECT 1 FROM repair_0011_replacement_chain);

WITH false_rsvps(id) AS MATERIALIZED (
  SELECT r.id FROM tournament_rsvps r
  WHERE r.id IN (
    'afdc238e-e442-4422-947a-249f309ff88f',
    '7e7821ba-cf40-4ffd-8eb7-e48187b9b87c',
    '4cdbe178-c177-4a33-a12b-9195048a864e')
    AND EXISTS (SELECT 1 FROM repair_0011_replacement_chain)
)
DELETE FROM tournament_rsvps WHERE id IN (SELECT id FROM false_rsvps);

WITH phantom_offers(id) AS MATERIALIZED (
  SELECT o.id FROM tournament_offers o
  WHERE o.id IN (
    '7e6b7b04-1031-4752-9360-b373b28c9ef0',
    '6eec5ee5-dd89-450f-bd40-7027158f29d0',
    '0b5d5534-d77e-4903-bf9e-5c8e9e7a31c3')
    AND EXISTS (SELECT 1 FROM repair_0011_replacement_chain)
    AND NOT EXISTS (SELECT 1 FROM tournament_rsvps r WHERE r.id IN (
      'afdc238e-e442-4422-947a-249f309ff88f',
      '7e7821ba-cf40-4ffd-8eb7-e48187b9b87c',
      '4cdbe178-c177-4a33-a12b-9195048a864e'))
)
DELETE FROM tournament_offers WHERE id IN (SELECT id FROM phantom_offers);

DROP VIEW repair_0011_replacement_chain;
