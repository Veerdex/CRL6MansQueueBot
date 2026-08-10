-- All-time peak MMR — see CLAUDE.md, "All-Time Stats Leaderboard". A running high-water mark of
-- each player's raw MMR, since CompletedGame history has no MMR field and peak can't be
-- reconstructed after the fact. Bumped via Math.max() at every MMR-increasing write site
-- (report.ts's Rank Queue settle, adminTools.ts's correct-report and adjust-mmr) — never lowered
-- by season decay or /admin unreport, same accepted-limitation precedent as last_rank_game_at.
alter table crl6mansqueuebot_players
  add column peak_mmr real not null default 0;

-- Backfill: MMR starts at 0 and only this migration's write sites ever raise it above the
-- player's current value, so "at least their current MMR, floored at 0" is a truthful lower
-- bound for real historical peak (not a fudge — every player's real peak is >= max(mmr, 0)).
update crl6mansqueuebot_players
set peak_mmr = greatest(mmr, 0);
