-- Match-time-of-day / day-of-week tracking for the hidden analytics page (see CLAUDE.md,
-- "Match time stats"). Increment-only aggregate counters, not raw per-match timestamps — per
-- explicit design request for memory efficiency, a single match increments exactly one row in
-- each table; nothing is ever inserted after the initial seed below.

-- 48 rows, one per 30-minute segment of the day in Pacific time
-- (0 = 00:00-00:29, 1 = 00:30-00:59, ... 47 = 23:30-23:59).
create table crl6mansqueuebot_time_of_day_stats (
  segment_index smallint primary key check (segment_index >= 0 and segment_index < 48),
  supercharged_count bigint not null default 0,
  non_supercharged_count bigint not null default 0
);

insert into crl6mansqueuebot_time_of_day_stats (segment_index)
select generate_series(0, 47);

-- 7 rows, one per day of week in Pacific time (0 = Sunday .. 6 = Saturday, matching
-- bonusDay.ts's existing Sun=0..Sat=6 convention).
create table crl6mansqueuebot_day_of_week_stats (
  day_of_week smallint primary key check (day_of_week >= 0 and day_of_week < 7),
  count bigint not null default 0
);

insert into crl6mansqueuebot_day_of_week_stats (day_of_week)
select generate_series(0, 6);

-- Atomic increment, called once per real (non-test-data) match at team-formation time
-- (see teamFormation.ts's finalizeTeams / matchTimeStats.ts). Bundles both table updates into
-- one round-trip so the bot only needs a single .rpc() call. "Supercharged" = that series'
-- bonus_day_multiplier > 1 (the existing Weekly Bonus Day mechanic, see CLAUDE.md).
-- int, not smallint, for the two index params: PostgREST resolves RPC overloads by the JSON
-- argument types it infers from the request body, and supabase-js sends plain JS numbers —
-- using the table columns' smallint type here risks a schema-cache resolution mismatch
-- (PGRST202). int matches what postgrest-js actually sends; Postgres implicitly casts it back
-- down to smallint in the WHERE clauses below.
create or replace function crl6mansqueuebot_increment_match_time_stats(
  p_segment_index int,
  p_day_of_week int,
  p_is_supercharged boolean
) returns void as $$
begin
  update crl6mansqueuebot_time_of_day_stats
  set supercharged_count = supercharged_count + (case when p_is_supercharged then 1 else 0 end),
      non_supercharged_count = non_supercharged_count + (case when p_is_supercharged then 0 else 1 end)
  where segment_index = p_segment_index;

  update crl6mansqueuebot_day_of_week_stats
  set count = count + 1
  where day_of_week = p_day_of_week;
end;
$$ language plpgsql;

revoke all on function crl6mansqueuebot_increment_match_time_stats(int, int, boolean) from public;
grant execute on function crl6mansqueuebot_increment_match_time_stats(int, int, boolean) to service_role;

-- RLS: same public-read-only pattern as every other table — the website's anon-key client
-- reads these directly for the hidden analytics page's graphs; all writes go through the
-- service-role key (the bot) via the RPC above.
alter table crl6mansqueuebot_time_of_day_stats enable row level security;
alter table crl6mansqueuebot_day_of_week_stats enable row level security;

create policy "public read" on crl6mansqueuebot_time_of_day_stats for select using (true);
create policy "public read" on crl6mansqueuebot_day_of_week_stats for select using (true);
