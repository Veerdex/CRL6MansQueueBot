-- Ordering guard for the one combined formation message (the "Match Found" post that
-- teamFormation.ts edits in place through the series-length vote, the Balanced/Captains vote and
-- the captains draft).
--
-- Discord message edits are last-write-wins, and renderFormationMessage reads the phase (the
-- series row) and the tallies (the vote tables) in separate queries. Two votes landing within the
-- same couple of seconds therefore race: the slower handler renders the *older* phase, then lands
-- its PATCH after the faster one and reverts the message to a screen whose buttons are already
-- dead. Observed live on the 2026-10-05 06:18 UTC pop (the series voided at 06:21) — three BO5
-- clicks inside five seconds left the series-length tally frozen at "BO5 3 / 3" on top of the
-- Balanced/Captains vote that had already resolved underneath it. Every further press hit
-- processSeriesLengthVoteButton's `series.series_length` guard, nobody could reach the formation
-- vote, and the sweep voided the series for vote silence two minutes later.
--
-- Fix: every redraw claims a monotonically increasing ticket off the series row before it reads
-- anything, and drops its PATCH if a newer ticket exists by the time the body is built. Narrows
-- the race to the PATCH's own flight time rather than closing it outright — holding a lock across
-- an outbound HTTP call isn't available over PostgREST — but that collapses a multi-second window
-- (two reads, the body build, and possibly a 429 retry sleep) down to a single round trip.
alter table crl6mansqueuebot_series add column formation_render_seq integer not null default 0;

-- Increment-and-return in one statement so concurrent claims serialize on the row lock instead of
-- racing a read-then-write in application code — same reasoning as
-- crl6mansqueuebot_assign_match_number (0042_match_number_on_report.sql) and
-- crl6mansqueuebot_join_queue (0002_queue_system.sql).
create or replace function crl6mansqueuebot_next_formation_render_seq(p_series_id uuid)
returns integer as $$
declare
  v_seq integer;
begin
  update crl6mansqueuebot_series
  set formation_render_seq = formation_render_seq + 1
  where id = p_series_id
  returning formation_render_seq into v_seq;
  return v_seq;
end;
$$ language plpgsql;

grant execute on function crl6mansqueuebot_next_formation_render_seq(uuid) to service_role;
