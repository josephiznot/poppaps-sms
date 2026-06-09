-- Optional starter data. The reward rule is a PLACEHOLDER and ships INACTIVE
-- (active=0) — promos are on hold pending requirements from the lounge owner
-- (ADR-0004). The rewards engine only fires for active rules, so nothing sends
-- until you flip active=1. Edit/replace freely; it's data-driven off this table.

INSERT OR IGNORE INTO reward_rules (id, every_n_visits, reward_text, active)
VALUES ('beer-every-5', 5, '2-for-1 beer', 0);
