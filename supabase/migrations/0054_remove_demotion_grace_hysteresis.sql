-- Demotion grace/hysteresis removed: bands now demote the moment a player's percentile falls
-- below their current band's cutoff, symmetric with promotions (see bands.ts computeBandChange).
-- These config rows are no longer read by anything.
delete from crl6mansqueuebot_config
where key in ('grace_games', 'grace_inactivity_days', 'hysteresis_mmr');
