-- Convert the Match Times page's time-of-day/day-of-week graphs from raw cumulative counts to
-- per-day averages (raw count / number of days that kind of day has occurred), so segments/days
-- are proportional and comparable rather than just reflecting how long the counters have been
-- accumulating. See CLAUDE.md, "Match time stats".
--
-- The averaging denominator ("how many days have elapsed, split into supercharged vs.
-- non-supercharged") is computed live at read time from a single stored start timestamp
-- (crl6mansqueuebot_config's match_time_stats_started_at) rather than a second set of
-- incrementing counters — pure date math against the current bonus-day range config, consistent
-- with this feature's existing "no raw timestamps, minimal stored state" design.
--
-- This requires resetting the existing accumulated counts: they were recorded with no notion of
-- "how many days this represents," so dividing them by a freshly-started day count would produce
-- wildly inflated numbers until enough real time passes. Both counter tables reset to 0 here, and
-- match_time_stats_started_at is set to now() — a clean, honestly-averaged window starting today.

update crl6mansqueuebot_time_of_day_stats set supercharged_count = 0, non_supercharged_count = 0;
update crl6mansqueuebot_day_of_week_stats set count = 0;

insert into crl6mansqueuebot_config (key, value)
values ('match_time_stats_started_at', now()::text)
on conflict (key) do update set value = excluded.value;
