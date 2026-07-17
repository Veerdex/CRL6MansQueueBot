"use client";

import { useMemo, useState } from "react";
import LeaderboardTable, { type MainBoardRow } from "./LeaderboardTable";
import StatsBoard, { type StatsPlayer } from "./StatsBoard";
import { SEASON_RANK_DISPLAY_MIN_GAMES } from "@/lib/leaderboard/constants";
import { bandRank, computeStats, filterGames } from "@/lib/leaderboard/stats";
import { getRankIconPath, getRankLabel } from "@/lib/leaderboard/rankIcon";
import type { CompletedGame, PlayerWithGames } from "@/lib/leaderboard/queries";
import type { SeasonHistoryRow } from "@/lib/supabase/types";

type ViewMode = "top-players" | "main" | "all-time";

interface UnifiedLeaderboardProps {
  players: PlayerWithGames[];
  activeSeason: { id: string; season_number: number } | null;
  previousSeason: { id: string; season_number: number } | null;
  previousSeasonHistory: Map<string, SeasonHistoryRow>;
}

function viewButtonClass(active: boolean) {
  return active
    ? "bg-brand-blue text-white shadow-lg font-semibold"
    : "bg-zinc-700 text-zinc-300 hover:bg-zinc-600 hover:text-zinc-200 transition-all";
}

export default function UnifiedLeaderboard({
  players,
  activeSeason,
  previousSeason,
  previousSeasonHistory,
}: UnifiedLeaderboardProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("main");
  const [seasonScope, setSeasonScope] = useState<"current" | "previous">("current");

  const eligiblePlayers = players.filter(({ player }) => player.total_games_played >= 1);

  // Top Players view: simplified list
  const topPlayersRows = useMemo(() => {
    return eligiblePlayers
      .sort((a, b) => {
        const bandDiff = bandRank(b.player.band) - bandRank(a.player.band);
        if (bandDiff !== 0) return bandDiff;
        if (!a.player.is_placed) return b.player.total_games_played - a.player.total_games_played;
        return b.player.mmr - a.player.mmr;
      })
      .slice(0, 20)
      .map((p, idx) => ({
        position: idx + 1,
        displayName: p.player.display_name,
        band: p.player.is_placed ? p.player.band : null,
        mmr: p.player.is_placed ? p.player.mmr : null,
      }));
  }, [eligiblePlayers]);

  // Main view: current leaderboard
  const mainBoardRows = useMemo(() => {
    const rows: MainBoardRow[] = eligiblePlayers
      .sort((a, b) => {
        const bandDiff = bandRank(b.player.band) - bandRank(a.player.band);
        if (bandDiff !== 0) return bandDiff;
        if (!a.player.is_placed) return b.player.total_games_played - a.player.total_games_played;
        return b.player.mmr - a.player.mmr;
      })
      .map(({ player, games }) => {
        const rankStats = computeStats(filterGames(games, { queueType: "rank" }));
        const history = previousSeasonHistory.get(player.id);
        const lastSeasonRank =
          history && history.season_games_played >= SEASON_RANK_DISPLAY_MIN_GAMES
            ? history.season_rank
            : null;
        return {
          playerId: player.id,
          displayName: player.display_name,
          band: player.is_placed ? player.band : null,
          mmr: player.is_placed ? player.mmr : null,
          wins: rankStats.wins,
          losses: rankStats.losses,
          winRate: rankStats.winRate,
          lastSeasonRank,
        };
      });
    return rows;
  }, [eligiblePlayers, previousSeasonHistory]);

  // All-Time Stats view
  const statsPlayers = useMemo(() => {
    return eligiblePlayers.map(({ player, games }) => ({
      playerId: player.id,
      displayName: player.display_name,
      games,
    }));
  }, [eligiblePlayers]);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10">
      {/* Settings Row */}
      <div className="mb-6 flex flex-wrap items-center gap-4">
        {/* View Mode Selection */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-brand-blue/60">View:</span>
          {(["top-players", "main", "all-time"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${viewButtonClass(viewMode === mode)}`}
              onClick={() => setViewMode(mode)}
            >
              {mode === "top-players" && "Top Players"}
              {mode === "main" && "Main"}
              {mode === "all-time" && "All-Time Stats"}
            </button>
          ))}
        </div>

        {/* Season Toggle (for Main and All-Time views) */}
        {(viewMode === "main" || viewMode === "all-time") && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-brand-blue/60">Season:</span>
            <button
              type="button"
              className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${viewButtonClass(seasonScope === "current")}`}
              onClick={() => setSeasonScope("current")}
            >
              Current{activeSeason ? ` (#${activeSeason.season_number})` : ""}
            </button>
            <button
              type="button"
              className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${viewButtonClass(seasonScope === "previous")} ${
                previousSeason ? "" : "cursor-not-allowed opacity-50"
              }`}
              onClick={() => previousSeason && setSeasonScope("previous")}
              disabled={!previousSeason}
            >
              Previous{previousSeason ? ` (#${previousSeason.season_number})` : ""}
            </button>
          </div>
        )}
      </div>

      {/* Title below settings */}
      <h1 className="mb-6 text-2xl font-bold text-brand-blue dark:text-white">Leaderboard</h1>

      <div className="rounded-2xl border border-zinc-800 bg-black p-4 shadow-sm sm:p-6">
        {viewMode === "top-players" && (
          <div>
            <p className="mb-4 text-sm text-zinc-500">
              Top players by MMR ranking. Rank Queue standing only.
            </p>
            {topPlayersRows.length === 0 ? (
              <div className="py-10 text-center text-brand-orange">No players yet.</div>
            ) : (
              <div className="space-y-2">
                {topPlayersRows.map((row) => (
                  <div key={row.position} className="flex items-center gap-4 rounded-lg bg-white/5 px-4 py-3 text-brand-orange">
                    <div className="min-w-fit text-sm font-semibold text-brand-orange/60">#{row.position}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-lg font-bold text-white truncate">{row.displayName}</div>
                    </div>
                    <div className="text-right">
                      <img
                        src={getRankIconPath(row.band)}
                        alt={getRankLabel(row.band)}
                        title={getRankLabel(row.band)}
                        className="h-6 w-6"
                      />
                    </div>
                    <div className="text-right min-w-fit">
                      {row.mmr !== null ? (
                        <div className="text-sm font-semibold">{row.mmr.toFixed(0)} MMR</div>
                      ) : (
                        <div className="text-sm text-brand-orange/50">NA</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {viewMode === "main" && (
          <div>
            <p className="mb-4 text-sm text-zinc-500">
              Rank Queue standing. Top 10 rows are the live projected Prism cut.
            </p>
            <LeaderboardTable rows={mainBoardRows} topCount={10} />
          </div>
        )}

        {viewMode === "all-time" && (
          <div>
            <p className="mb-4 text-sm text-zinc-500">
              Click a column header to sort. All-time lifetime stats.
            </p>
            <StatsBoard
              players={statsPlayers}
              mode="all-time"
              currentSeason={null}
              previousSeason={null}
            />
          </div>
        )}
      </div>
    </div>
  );
}
