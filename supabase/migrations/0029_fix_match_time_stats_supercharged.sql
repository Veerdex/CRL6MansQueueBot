-- Repair migration for crl6mansqueuebot_increment_match_time_stats (see 0025_match_time_stats.sql).
-- Reported bug: Supercharged (Bonus Day) matches were being tallied into non_supercharged_count
-- on the Match Times graph, even though the corresponding /report embeds correctly showed the
-- "Bonus Day" marker for those same series (i.e. bonus_day_multiplier > 1 was computed and stored
-- correctly at pop time — the application code that reads and passes that flag through, all the
-- way to this RPC call, was verified correct). That points to the live database's function
-- definition having drifted from what 0025's migration file shows on disk — this migration file
-- is line-for-line identical in its CASE logic to 0025's, and only exists to force a fresh
-- CREATE OR REPLACE against production, since editing a migration file after it's already been
-- applied does not retroactively update the live function.
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
