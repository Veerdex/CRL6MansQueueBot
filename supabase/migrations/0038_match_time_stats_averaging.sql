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
-- Anchored to the actual historical start of tracking rather than reset-to-now: as of this
-- migration being written (2026-08-14), the existing accumulated counts represent exactly 7
-- elapsed days (1 supercharged, 6 non-supercharged) — confirmed live rather than reset, per
-- explicit request to keep the existing data instead of zeroing it out. 2026-08-08 (noon UTC,
-- safely within that Pacific calendar date regardless of PDT/PST) is 6 days before that, so
-- today - startedAt + 1 = 7, matching the real history the counts already reflect. This is a
-- fixed calendar date, not `now()` — it must stay correct however long this migration sits
-- before actually being applied to production, since the raw counters keep incrementing under
-- already-deployed code in the meantime regardless of when this migration runs.

insert into crl6mansqueuebot_config (key, value)
values ('match_time_stats_started_at', '2026-08-08T12:00:00Z')
on conflict (key) do update set value = excluded.value;
