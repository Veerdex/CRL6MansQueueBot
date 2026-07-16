-- CRL 6 Mans — Phase 4/6 (MMR engine + reporting) schema.
-- Extends 0001/0002/0005 (additive only, same convention as before).

-- ---------------------------------------------------------------------------
-- rank_games_played: counts only Rank Queue games a player has completed (reported, not
-- cancelled/void). Distinct from players.total_games_played, which counts both queues (used
-- for placement bootstrap — see CLAUDE.md, "Placement bootstrap"). Provisional K needs the
-- rank-only count specifically — see CLAUDE.md, "MMR / Elo".
-- ---------------------------------------------------------------------------

alter table crl6mansqueuebot_players
  add column rank_games_played int not null default 0;

-- ---------------------------------------------------------------------------
-- mmr_delta: the exact MMR change /report applied to this player for this series (0 for
-- Universal Queue games, which never move MMR). Stored so a future `/admin unreport` can
-- unwind it exactly (`mmr -= mmr_delta`) rather than trying to recompute a reverse delta
-- after later games have already moved everyone's rating — see CLAUDE.md, "Reporting &
-- disputes".
-- ---------------------------------------------------------------------------

alter table crl6mansqueuebot_series_players
  add column mmr_delta real not null default 0;
