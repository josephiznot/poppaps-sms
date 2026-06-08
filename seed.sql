-- Optional starter data. The reward rule is a PLACEHOLDER — the real thresholds
-- and promos are still being decided with the lounge manager (ADR-0004).
-- Edit/replace freely; the rewards engine is data-driven off this table.

INSERT OR IGNORE INTO reward_rules (id, every_n_visits, reward_text, active)
VALUES ('beer-every-5', 5, '2-for-1 beer', 1);
