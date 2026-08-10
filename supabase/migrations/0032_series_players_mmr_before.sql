-- Per-match MMR snapshot — see CLAUDE.md, "Match History". Match History's win-odds bar and
-- per-player MMR badge previously computed off each player's CURRENT mmr for every match card,
-- so a player's whole match history re-rendered with today's rating instead of what they
-- actually had when each match was played. mmr_before is the player's raw mmr immediately
-- before that series' report was applied (the same value fed into computeEloDeltas/
-- calculateTeamStrength for Rank Queue, or just their then-current mmr for Universal Queue,
-- which never moves it) — written once, at report time, never touched again (an admin
-- correcting a report later doesn't change what a player's MMR was at the time the match was
-- actually played).
--
-- Nullable, not backfilled: no historical pre-match MMR is persisted anywhere in the existing
-- schema (series_players.mmr_delta is only the delta applied, not a before value), so an exact
-- backfill for already-reported series isn't possible — same "can't be reconstructed" admission
-- CLAUDE.md already made about this. Callers fall back to the player's current mmr when null.
alter table crl6mansqueuebot_series_players
  add column mmr_before real;
