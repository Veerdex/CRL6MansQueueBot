-- Closes gaps in crl6mansqueuebot_series.match_number caused by test matches (/test-rank-match,
-- /test-universal-match) and the /dev panel's bulk synthetic-data generator consuming the same
-- sequence-backed column default real matches use (see migration 0030_fix_match_number_race.sql)
-- — reported live as real match numbers jumping e.g. #10 straight to #17. Application code
-- (testMatch.ts, lib/test-data/generate.ts) now explicitly writes match_number: null on those
-- inserts instead of letting the default fire, so this stops recurring going forward; this
-- migration is the one-time cleanup for rows that already have the gaps.
--
-- Renumbers every non-test series with a match_number to consecutive integers (1, 2, 3, ...) in
-- their existing relative order — a real match's *position* relative to other real matches was
-- never wrong, only the absolute numbers, since the sequence is monotonic regardless of who
-- claims each value. Every test-data row's match_number is nulled out, matching what a test
-- insert produces going forward (falls back to the series-id-slice voice-channel naming already
-- built for a null match_number).
--
-- Renumbering safely under match_number's UNIQUE constraint needs two passes: the target
-- consecutive range overlaps the existing range (e.g. old {1,2,3,6,7,9} -> new {1,2,3,4,5,6}),
-- so a single UPDATE can try to write a new value that collides with another row's not-yet-
-- updated old value, depending on row processing order. Moving everything to a disjoint negative
-- range first, then flipping to the final positive values, guarantees no collision at either step
-- since match_number has only ever held positive values.

with renumbered as (
  select id, row_number() over (order by match_number asc) as new_number
  from crl6mansqueuebot_series
  where is_test_data = false and match_number is not null
)
update crl6mansqueuebot_series s
set match_number = -r.new_number
from renumbered r
where s.id = r.id;

update crl6mansqueuebot_series
set match_number = -match_number
where is_test_data = false and match_number < 0;

update crl6mansqueuebot_series
set match_number = null
where is_test_data = true and match_number is not null;

-- Same setval() idiom 0030/0034 already use, re-run since the max real match_number has changed.
select setval(
  'crl6mansqueuebot_match_number_seq',
  coalesce((select max(match_number) from crl6mansqueuebot_series), 0) + 1,
  false
);
