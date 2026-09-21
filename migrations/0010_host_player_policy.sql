-- The designated host/dealer is always a tournament player. Host-offer metadata
-- is separate so this migration is safely rerunnable on SQLite/D1.
CREATE TABLE IF NOT EXISTS tournament_host_offers (
  offer_id                 TEXT PRIMARY KEY,
  plan_id                  TEXT NOT NULL,
  member_phone             TEXT NOT NULL,
  counts_ranked_seat       INTEGER NOT NULL
                              CHECK (counts_ranked_seat IN (0,1)),
  UNIQUE (plan_id, member_phone)
);

-- Capacity applies to the eight ranked seats. An outside-top-eight host offer is
-- the one explicit exception and is present in tournament_host_offers first.
DROP TRIGGER IF EXISTS trg_tournament_offer_capacity_insert;
DROP TRIGGER IF EXISTS trg_tournament_offer_capacity_update;
CREATE TRIGGER trg_tournament_offer_capacity_insert
BEFORE INSERT ON tournament_offers
WHEN NEW.state IN ('ACTIVE','CONFIRMED')
 AND COALESCE((SELECT counts_ranked_seat FROM tournament_host_offers WHERE offer_id=NEW.id), 1)=1
 AND (SELECT COUNT(*) FROM tournament_offers o
      WHERE o.plan_id=NEW.plan_id AND o.state IN ('ACTIVE','CONFIRMED')
        AND COALESCE((SELECT h.counts_ranked_seat FROM tournament_host_offers h WHERE h.offer_id=o.id), 1)=1) >= 8
BEGIN
  SELECT RAISE(ABORT, 'tournament offer capacity exceeded');
END;
CREATE TRIGGER trg_tournament_offer_capacity_update
BEFORE UPDATE OF state ON tournament_offers
WHEN OLD.state NOT IN ('ACTIVE','CONFIRMED') AND NEW.state IN ('ACTIVE','CONFIRMED')
 AND COALESCE((SELECT counts_ranked_seat FROM tournament_host_offers WHERE offer_id=NEW.id), 1)=1
 AND (SELECT COUNT(*) FROM tournament_offers o
      WHERE o.plan_id=NEW.plan_id AND o.state IN ('ACTIVE','CONFIRMED')
        AND COALESCE((SELECT h.counts_ranked_seat FROM tournament_host_offers h WHERE h.offer_id=o.id), 1)=1) >= 8
BEGIN
  SELECT RAISE(ABORT, 'tournament offer capacity exceeded');
END;

-- Migrate only the exact active 2026-Q4 production shape: version-5 plan,
-- exactly one designated host, that host outside the selected eight, and one
-- already-delivered current-version dealer notice that has not been linked.
INSERT OR IGNORE INTO tournament_host_offers
  (offer_id,plan_id,member_phone,counts_ranked_seat)
SELECT 'host-player-offer-2026-q4',p.id,m.phone,0
FROM tournament_plans p
JOIN games g ON g.id=p.game_id
JOIN members m ON m.is_designated_dealer=1
JOIN tournament_board b ON b.plan_id=p.id AND b.member_phone=m.phone
JOIN sms_deliveries d ON d.plan_id=p.id AND d.game_id=p.game_id AND d.recipient=m.phone
WHERE p.quarter_key='2026-Q4'
  AND p.status='ACTIVE'
  AND p.planned_starts_at='2026-09-28T23:30:00.000Z'
  AND p.qualification_cutoff='2026-09-14T15:00:00.000Z'
  AND p.confirmation_deadline='2026-09-22T02:00:00.000Z'
  AND p.version=5 AND p.schedule_version=1
  AND p.season_id IS NOT NULL AND p.cancelled_at IS NULL
  AND g.is_tournament=1 AND g.cancelled=0 AND g.starts_at=p.planned_starts_at
  AND b.selected_qualifier=0 AND p.tie_score=b.points
  AND p.blocked_reason LIKE '%replacement candidates are tied%'
  AND d.kind='DEALER_TOURNAMENT_NOTICE' AND d.version=p.schedule_version
  AND d.state='DELIVERED' AND d.provider_sid IS NOT NULL AND d.offer_id IS NULL
  AND (SELECT COUNT(*) FROM members WHERE is_designated_dealer=1)=1
  AND (SELECT COUNT(*) FROM tournament_board q WHERE q.plan_id=p.id AND q.selected_qualifier=1)=8
  AND (SELECT COUNT(*) FROM tournament_offers o
       WHERE o.plan_id=p.id AND o.state IN ('ACTIVE','CONFIRMED'))=7
  AND (SELECT COUNT(*) FROM sms_deliveries x
       WHERE x.plan_id=p.id AND x.recipient=m.phone
         AND x.kind='DEALER_TOURNAMENT_NOTICE' AND x.version=p.schedule_version)=1
  AND NOT EXISTS (SELECT 1 FROM tournament_offers o WHERE o.plan_id=p.id AND o.member_phone=m.phone);

INSERT OR IGNORE INTO tournament_offers
  (id,plan_id,member_phone,board_rank,state,offered_at,response_deadline,updated_at)
SELECT h.offer_id,h.plan_id,h.member_phone,b.rank,'ACTIVE',d.created_at,p.confirmation_deadline,p.updated_at
FROM tournament_host_offers h
JOIN tournament_plans p ON p.id=h.plan_id
JOIN tournament_board b ON b.plan_id=p.id AND b.member_phone=h.member_phone
JOIN sms_deliveries d ON d.plan_id=p.id AND d.recipient=h.member_phone
WHERE h.offer_id='host-player-offer-2026-q4'
  AND h.counts_ranked_seat=0
  AND p.quarter_key='2026-Q4' AND p.status='ACTIVE'
  AND p.version=5 AND p.schedule_version=1
  AND p.confirmation_deadline='2026-09-22T02:00:00.000Z'
  AND d.kind='DEALER_TOURNAMENT_NOTICE' AND d.version=1
  AND d.state='DELIVERED' AND d.provider_sid IS NOT NULL AND d.offer_id IS NULL;

UPDATE sms_deliveries
SET offer_id='host-player-offer-2026-q4'
WHERE kind='DEALER_TOURNAMENT_NOTICE'
  AND state='DELIVERED'
  AND provider_sid IS NOT NULL
  AND offer_id IS NULL
  AND EXISTS (
    SELECT 1 FROM tournament_offers o
    JOIN tournament_plans p ON p.id=o.plan_id
    WHERE o.id='host-player-offer-2026-q4'
      AND o.plan_id=sms_deliveries.plan_id
      AND o.member_phone=sms_deliveries.recipient
      AND p.quarter_key='2026-Q4' AND p.version=5 AND p.schedule_version=1
  );

-- Once the host is separately offered, the host is removed from replacement
-- eligibility. The remaining tied player is therefore the clear next candidate.
UPDATE tournament_plans
SET blocked_reason=NULL, tie_score=NULL
WHERE quarter_key='2026-Q4'
  AND status='ACTIVE'
  AND version=5 AND schedule_version=1
  AND confirmation_deadline='2026-09-22T02:00:00.000Z'
  AND blocked_reason LIKE '%replacement candidates are tied%'
  AND EXISTS (
    SELECT 1 FROM tournament_host_offers h
    JOIN tournament_offers o ON o.id=h.offer_id
    WHERE h.plan_id=tournament_plans.id AND h.counts_ranked_seat=0 AND o.state='ACTIVE'
  )
  AND 1=(
    SELECT COUNT(*) FROM tournament_board b
    WHERE b.plan_id=tournament_plans.id AND b.points=tournament_plans.tie_score
      AND NOT EXISTS (SELECT 1 FROM tournament_offers o WHERE o.plan_id=b.plan_id AND o.member_phone=b.member_phone)
  );
