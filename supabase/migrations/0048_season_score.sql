-- All-time rating — per-season points, summed across seasons to give a player's career score.
-- See web/lib/mmr/allTimeRating.ts for the curve. Deliberately stored per season rather than as a
-- running total on crl6mansqueuebot_players: season_history is already the permanent per-season
-- archive, so the career number stays re-derivable and a re-closed or corrected season can't leave
-- a denormalized counter silently wrong (same reasoning that made made_top10 a snapshot).
--
-- 0 for everyone who earned nothing that season: the bottom half of the standing, and every
-- unplaced participant (unplaced players are excluded from the standing the curve is computed
-- over, so they can't earn). Existing rows backfill to 0 — seasons closed before this migration
-- have no recorded all-time points, and nothing recomputes them.
alter table crl6mansqueuebot_season_history
  add column season_score real not null default 0;
