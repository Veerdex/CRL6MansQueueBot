-- CRL 6 Mans — replace the percentile-based demotion hysteresis buffer with a fixed MMR buffer.
-- Superseded: hysteresis_pct (percentile points below the current band's promotion-in threshold)
-- -> hysteresis_mmr (raw MMR points below the current band's threshold MMR, computed live off
-- band_calc_mode via computeBandThresholdMmr in bands.ts — see CLAUDE.md, "Bands / ranks").
-- Same retirement pattern as mod_role_id in 0004_admin_roles.sql: delete the old key from a later
-- migration rather than editing 0002_queue_system.sql's original seed.

delete from crl6mansqueuebot_config where key = 'hysteresis_pct';

insert into crl6mansqueuebot_config (key, value)
values ('hysteresis_mmr', '7')
on conflict (key) do nothing;
