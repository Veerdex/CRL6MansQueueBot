-- One-time backfill for crl6mansqueuebot_series_players.mmr_before on series reported before
-- migration 0032_series_players_mmr_before.sql existed (see CLAUDE.md, "Match History" — that
-- migration shipped the column nullable and explicitly NOT backfilled, since no historical
-- pre-match MMR was persisted anywhere at the time).
--
-- Superseded approach: web/lib/mmr/reconstructMmrHistory.ts / web/scripts/backfill-mmr-before.ts
-- were built first as a general-purpose reconstruction that also replays admin /admin adjust-mmr
-- overrides and season-close decay, since those can turn a plain forward sum of mmr_delta into
-- the wrong answer. This migration takes a simpler path that's sufficient for the live server's
-- actual history: no season has closed yet (no decay to reconstruct — see CLAUDE.md, "Seasons"),
-- so every player's mmr_before for a given reported series is exactly the sum of their own
-- mmr_delta from every earlier reported series, starting from the real Elo starting point of
-- raw MMR 0 (displays as 1000 on the live server's mmr_scale=7.25/mmr_shift=1000 config — see
-- CLAUDE.md, "MMR / Elo"). mmr_delta has been stored on every series_players row since migration
-- 0006_reporting_mmr.sql, so this is a straightforward per-player running total computed entirely
-- in SQL from data Postgres already has — no external reconstruction script or DB credentials
-- needed to apply it.
--
-- NOT modeled (same admission the script's own header makes): any historical /admin adjust-mmr
-- absolute-override correction would make a plain running sum diverge from the truth from that
-- point forward, since it's not additive with the surrounding mmr_delta history. Re-run
-- web/scripts/backfill-mmr-before.ts (or a hand-written correction) if any such corrections are
-- known to have happened before this migration is applied. Same status='reported' / non-test-data
-- scope, and the same never-overwrite-a-real-snapshot guarantee (only touches rows currently
-- NULL), as that script.
with ordered as (
  select
    sp.series_id,
    sp.player_id,
    sum(sp.mmr_delta) over (
      partition by sp.player_id
      order by s.reported_at, s.id
      rows between unbounded preceding and 1 preceding
    ) as running_mmr_before
  from crl6mansqueuebot_series_players sp
  join crl6mansqueuebot_series s on s.id = sp.series_id
  where s.status = 'reported'
    and s.is_test_data = false
)
update crl6mansqueuebot_series_players sp
set mmr_before = coalesce(ordered.running_mmr_before, 0)
from ordered
where sp.series_id = ordered.series_id
  and sp.player_id = ordered.player_id
  and sp.mmr_before is null;
