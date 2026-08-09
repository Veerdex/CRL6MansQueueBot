-- Fixes a race on crl6mansqueuebot_series.match_number (added in 0016_series_match_number.sql
-- with no default/sequence backing it — application code was responsible for computing and
-- writing a unique value by hand).
--
-- Two independent, uncoordinated call sites were both writing to this UNIQUE column with no
-- error handling: queue.ts's handlePop assigned "count of already-reported series" at pop time,
-- and report.ts separately recomputed a different "count of reported series" value and
-- overwrote the same column at report time. Since matches typically stay in-flight (forming/
-- active) for a while before anyone reports, more than one series is almost always unreported
-- at once, so the pop-time count collides with an already-assigned value on essentially every
-- pop after the very first match ever played. The UPDATE's error was never checked, so it
-- silently failed and left match_number NULL — this is why voice-channel naming
-- (createVoiceChannels, queue.ts) fell back to the series-id slice on effectively every match.
--
-- Fix: back match_number with a real Postgres sequence via a column default, so it's assigned
-- atomically at series-creation (pop) time with no possible collision. Application code no
-- longer computes or writes this value at all (see queue.ts/report.ts changes in the same
-- commit) — report.ts now just reads the already-assigned series.match_number for its match-ID
-- embed instead of maintaining a second, conflicting numbering scheme.
--
-- Turns out 0016_series_match_number.sql (which adds the column itself) was never actually
-- applied to the production project — confirmed via a `column "match_number" does not exist`
-- error running this migration as originally written. Made self-sufficient below (IF NOT
-- EXISTS throughout) instead of assuming 0016 already ran.
alter table crl6mansqueuebot_series add column if not exists match_number integer unique;
create index if not exists idx_series_match_number on crl6mansqueuebot_series(match_number);

create sequence if not exists crl6mansqueuebot_match_number_seq;

-- Sync the sequence past whatever match_number values already exist (mostly NULL, given the
-- bug above, but this is safe/correct regardless of what's actually in the table).
select setval(
  'crl6mansqueuebot_match_number_seq',
  coalesce((select max(match_number) from crl6mansqueuebot_series), 0) + 1,
  false
);

alter table crl6mansqueuebot_series
  alter column match_number set default nextval('crl6mansqueuebot_match_number_seq');
