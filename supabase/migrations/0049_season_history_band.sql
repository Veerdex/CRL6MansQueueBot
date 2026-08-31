-- The band a player finished the season holding, snapshotted at close so a past-season leaderboard
-- can show it. Every other column here is already a snapshot for the same reason; band was the one
-- gap, and it left every archived row rendering as Unranked on the season browser, because the
-- soft reset a few lines later in seasonClose.ts clears is_placed/band for the whole roster.
--
-- Snapshotted rather than derived at read time from mmr_at_close: band cutoffs are percentile
-- config an admin can retune (`band_cutoffs`), so deriving would silently rewrite the bands of
-- every past season the next time they changed. Same reasoning that made made_top10 and
-- season_score snapshots.
--
-- Holds the *underlying* band, never 'Prism' — Prism is a live top-N overlay carried separately by
-- made_top10, and the boards render it over this value the same way they do for a live row. Null
-- means the player was unplaced at close (they still get an archived row, and still display as
-- Unranked). Rows written before this migration are also null, which is indistinguishable from
-- unplaced — harmless today, as no season has been closed yet and the table is empty.
alter table crl6mansqueuebot_season_history
  add column band_at_close text null check (band_at_close in ('Iron', 'Garnet', 'Emerald', 'Sapphire'));
