-- Grace-period inactivity bypass — see CLAUDE.md, "Bands / ranks". A player who gets promoted
-- and then stops playing before accumulating grace_games more Rank Queue games would otherwise
-- stay demotion-immune forever, since band_games_played only advances via /report. This column
-- tracks the last time each player finished a Rank Queue series; bands.ts treats grace as
-- expired once this is older than grace_inactivity_days (config, default 7 — one week), even if
-- band_games_played hasn't reached grace_games yet. Hysteresis still applies
-- afterward — this only removes the "immune no matter what" protection, it doesn't force a
-- demotion outright.
alter table crl6mansqueuebot_players
  add column last_rank_game_at timestamptz null;

-- Backfill from existing report history so already-active players aren't treated as infinitely
-- inactive the moment this ships.
update crl6mansqueuebot_players p
set last_rank_game_at = sub.last_reported_at
from (
  select sp.player_id, max(s.reported_at) as last_reported_at
  from crl6mansqueuebot_series_players sp
  join crl6mansqueuebot_series s on s.id = sp.series_id
  where s.queue_type = 'rank' and s.status = 'reported' and s.is_test_data = false
  group by sp.player_id
) sub
where sub.player_id = p.id;
