-- Moves crl6mansqueuebot_series.match_number assignment from pop time to report time, so it only
-- ever reflects genuinely reported ("legit") matches. Migration 0041_close_match_number_gaps.sql
-- already stopped test matches from consuming it, but every real (non-test) pop still assigned a
-- number via the column default added in 0030_fix_match_number_race.sql — including void,
-- cancelled, and timed-out series, since nothing at pop time knows a series' eventual outcome.
-- Reported live after 0041: the user counted 52 actually-reported matches, but the sequence had
-- continued from 62 — the extra 10 were void/cancelled real series numbered right alongside the
-- reported ones.
--
-- Renumbers every already-reported (status='reported', is_test_data=false) series to consecutive
-- integers in reported_at order — matching the new report-time-assignment semantic exactly, so
-- these retroactive numbers are consistent with how new ones get assigned going forward. Every
-- other series (void, cancelled, still in-flight, or test) has match_number cleared entirely.
--
-- Same two-pass negate trick 0041 used to renumber safely under the UNIQUE constraint: the target
-- consecutive range overlaps the existing range, so a single UPDATE can try to write a value that
-- collides with another row's not-yet-updated old value depending on row processing order. Moving
-- everything to a disjoint negative range first, then flipping to the final positive values,
-- avoids that entirely since match_number has only ever held positive values.

with renumbered as (
  select id, row_number() over (order by reported_at asc) as new_number
  from crl6mansqueuebot_series
  where status = 'reported' and is_test_data = false
)
update crl6mansqueuebot_series s
set match_number = -r.new_number
from renumbered r
where s.id = r.id;

update crl6mansqueuebot_series
set match_number = -match_number
where status = 'reported' and is_test_data = false and match_number < 0;

update crl6mansqueuebot_series
set match_number = null
where match_number is not null
  and not (status = 'reported' and is_test_data = false);

-- Same setval() idiom 0030/0034/0041 already use, re-run since the max match_number has changed.
select setval(
  'crl6mansqueuebot_match_number_seq',
  coalesce((select max(match_number) from crl6mansqueuebot_series), 0) + 1,
  false
);

-- The column default (added in 0030) assigned match_number to *every* pop, which is exactly the
-- bug this migration fixes. Dropping it means an insert that omits match_number (every pop, real
-- or test) simply gets null now, same as test rows already got before this. The only place that
-- ever assigns a real value from here on is the function below, called once from report.ts's
-- settle path.
alter table crl6mansqueuebot_series alter column match_number drop default;

-- Atomically assigns the next sequence value at the moment a series settles to 'reported' —
-- called from report.ts right after the atomic status claim, gated there on !is_test_data (test
-- matches never call this, so their match_number stays permanently null). A stored function
-- (rather than reading nextval() in application code and writing it back) keeps the
-- nextval()-then-update atomic under concurrent reports, same reasoning as
-- crl6mansqueuebot_join_queue (0002_queue_system.sql).
create or replace function crl6mansqueuebot_assign_match_number(p_series_id uuid)
returns integer as $$
declare
  v_match_number integer;
begin
  update crl6mansqueuebot_series
  set match_number = nextval('crl6mansqueuebot_match_number_seq')
  where id = p_series_id
  returning match_number into v_match_number;
  return v_match_number;
end;
$$ language plpgsql;

grant execute on function crl6mansqueuebot_assign_match_number(uuid) to service_role;
