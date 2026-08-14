-- Generalize the weekly bonus-MMR day from a single day (bonus_day_of_week) into a range
-- (bonus_day_start, bonus_day_end) — see CLAUDE.md, "Weekly bonus day". Config values live in
-- the schemaless crl6mansqueuebot_config key/value table, so no column change is needed here —
-- only migrate/retire the key itself. Any value an admin already set via the old
-- /admin bonus-day set-day command carries forward as a single-day range (start == end == that
-- day), preserving existing behavior exactly. Same retirement pattern as hysteresis_pct ->
-- hysteresis_mmr (0028_hysteresis_mmr.sql) / mod_role_id (0004_admin_roles.sql): migrate then
-- delete the old key from a later migration rather than editing 0002_queue_system.sql's
-- original seed.

insert into crl6mansqueuebot_config (key, value)
select 'bonus_day_start', value from crl6mansqueuebot_config where key = 'bonus_day_of_week'
on conflict (key) do nothing;

insert into crl6mansqueuebot_config (key, value)
select 'bonus_day_end', value from crl6mansqueuebot_config where key = 'bonus_day_of_week'
on conflict (key) do nothing;

delete from crl6mansqueuebot_config where key = 'bonus_day_of_week';
