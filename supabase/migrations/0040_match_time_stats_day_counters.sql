-- Replaces the Match Times page's live-recomputed supercharged/non-supercharged day split with
-- two persistent counters, incremented once per Pacific calendar day by the per-minute sweep
-- (advanceMatchTimeStatsDayCounters, web/lib/discord/bonusDay.ts). The previous approach
-- (computeDayTrackingTotals) re-evaluated every historical day against whatever the *current*
-- bonus_day_start/end/enabled config said on every page load — so changing the bonus range later
-- silently reclassified every day that had already elapsed, not just future ones. Each day is
-- now classified exactly once, at the moment it ends, against the config in effect right then.
--
-- Weekday-occurrence counts (the Day of Week panel's own denominator) are untouched by this —
-- a Monday is always a Monday regardless of config, so that computation was never actually
-- affected by the bug and still runs live from match_time_stats_started_at.
--
-- Seeded from the exact same real history migration 0038 established (2026-08-08 through
-- 2026-08-14 Pacific, 7 days, exactly one Saturday under the default Saturday-only range: 1
-- supercharged, 6 non-supercharged) so the switch to daily counting doesn't lose or double-count
-- anything already reflected in that migration's anchor — match_time_stats_last_marked_date is
-- the last day already accounted for, so the sweep starts counting fresh from 2026-08-15 onward.

insert into crl6mansqueuebot_config (key, value) values
  ('match_time_stats_supercharged_days', '1'),
  ('match_time_stats_nonsupercharged_days', '6'),
  ('match_time_stats_last_marked_date', '2026-08-14')
on conflict (key) do update set value = excluded.value;
