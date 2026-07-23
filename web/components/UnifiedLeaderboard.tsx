"use client";

import { useMemo, useState } from "react";
import LeaderboardTable, { type MainBoardRow } from "./LeaderboardTable";
import StatsBoard, { type StatsPlayer } from "./StatsBoard";
import { bandRank, computeStats, filterGames } from "@/lib/leaderboard/stats";
import { getRankIconPath, getRankLabel } from "@/lib/leaderboard/rankIcon";
import { playTap } from "@/lib/sound";
import type { CompletedGame, PlayerWithGames } from "@/lib/leaderboard/queries";
import type { SeasonHistoryRow, Band } from "@/lib/supabase/types";

function getBandColor(band: Band | null): string {
  switch (band) {
    case "Iron":
      return "rgb(125, 125, 125)";
    case "Garnet":
      return "rgb(255, 0, 0)";
    case "Emerald":
      return "rgb(0, 128, 0)";
    case "Sapphire":
      return "rgb(0, 0, 255)";
    default:
      // Unranked/null: gray
      return "rgb(70, 70, 70)";
  }
}

function getPrismColor(): string {
  return "rgb(255, 255, 255)";
}

type ViewMode = "top-players" | "main" | "all-time";

interface UnifiedLeaderboardProps {
  players: PlayerWithGames[];
  activeSeason: { id: string; season_number: number } | null;
  previousSeason: { id: string; season_number: number } | null;
  previousSeasonHistory: Map<string, SeasonHistoryRow>;
  mmrScale: number;
  mmrShift: number;
}

function applyMMRTransform(mmr: number, scale: number, shift: number): number {
  return mmr * scale + shift;
}

export default function UnifiedLeaderboard({
  players,
  activeSeason,
  previousSeason,
  previousSeasonHistory,
  mmrScale,
  mmrShift,
}: UnifiedLeaderboardProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("main");
  const [seasonScope, setSeasonScope] = useState<"current" | "previous">("current");

  const eligiblePlayers = players.filter(({ player }) => player.total_games_played >= 1);

  // Top Players view: simplified list
  const topPlayersRows = useMemo(() => {
    return eligiblePlayers
      .sort((a, b) => {
        const bandDiff = bandRank(a.player.band) - bandRank(b.player.band);
        if (bandDiff !== 0) return bandDiff;
        if (!b.player.is_placed) return a.player.total_games_played - b.player.total_games_played;
        return a.player.mmr - b.player.mmr;
      })
      .slice(0, 20)
      .map((p, idx) => ({
        position: idx + 1,
        displayName: p.player.display_name,
        band: p.player.is_placed ? p.player.band : null,
        mmr: p.player.mmr,
      }));
  }, [eligiblePlayers]);

  // Main view: current leaderboard
  const mainBoardRows = useMemo(() => {
    const rows: MainBoardRow[] = eligiblePlayers
      .sort((a, b) => {
        const bandDiff = bandRank(a.player.band) - bandRank(b.player.band);
        if (bandDiff !== 0) return bandDiff;
        if (!b.player.is_placed) return a.player.total_games_played - b.player.total_games_played;
        return a.player.mmr - b.player.mmr;
      })
      .map(({ player, games }) => {
        const rankStats = computeStats(filterGames(games, { queueType: "rank" }));
        return {
          playerId: player.id,
          displayName: player.display_name,
          band: player.is_placed ? player.band : null,
          mmr: player.mmr,
          wins: rankStats.wins,
          losses: rankStats.losses,
          winRate: rankStats.winRate,
        };
      });
    return rows;
  }, [eligiblePlayers]);

  // All-Time Stats view
  const statsPlayers = useMemo(() => {
    return eligiblePlayers.map(({ player, games }) => ({
      playerId: player.id,
      displayName: player.display_name,
      games,
    }));
  }, [eligiblePlayers]);

  function selectView(mode: ViewMode) {
    playTap();
    setViewMode(mode);
  }

  function selectSeasonScope(scope: "current" | "previous") {
    if (scope === "previous" && !previousSeason) return;
    playTap();
    setSeasonScope(scope);
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10">
      <h1 className="animate-in mb-6 text-2xl font-bold text-foreground">Leaderboard</h1>

      {/* Settings Row */}
      <div className="animate-in mb-6 flex flex-wrap items-center gap-4">
        {/* View Mode Selection */}
        <div className="segmented">
          {(["top-players", "main", "all-time"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              data-active={viewMode === mode}
              className="segmented-btn"
              onClick={() => selectView(mode)}
            >
              {mode === "top-players" && "Top Players"}
              {mode === "main" && "Main"}
              {mode === "all-time" && "All-Time Stats"}
            </button>
          ))}
        </div>

        {/* Season Toggle (for Main and All-Time views) */}
        {(viewMode === "main" || viewMode === "all-time") && (
          <div className="segmented">
            <button
              type="button"
              data-active={seasonScope === "current"}
              data-season="true"
              className="segmented-btn"
              onClick={() => selectSeasonScope("current")}
            >
              Current Season
            </button>
            <button
              type="button"
              data-active={seasonScope === "previous"}
              data-season="true"
              className={`segmented-btn ${previousSeason ? "" : "cursor-not-allowed opacity-40"}`}
              onClick={() => selectSeasonScope("previous")}
              disabled={!previousSeason}
            >
              Previous Season
            </button>
          </div>
        )}
      </div>

      <div className="panel animate-in-delay-1 p-4 sm:p-6">
        {viewMode === "top-players" && (
          <div>
            <p className="mb-4 text-sm text-muted">
              Top players by MMR ranking. Rank Queue standing only.
            </p>
            {topPlayersRows.length === 0 ? (
              <div className="py-10 text-center text-muted">No players yet.</div>
            ) : (
              <div className="space-y-2">
                {topPlayersRows.map((row) => {
                  const bandColor = row.band === "Sapphire" && row.position <= 10
                    ? getPrismColor()
                    : getBandColor(row.band);
                  const backgroundGradient = `linear-gradient(90deg, ${bandColor}20 0%, transparent 100%)`;
                  return (
                    <div
                      key={row.position}
                      className="row-hover flex items-center gap-4 rounded-lg px-4 py-3"
                      style={{ backgroundImage: backgroundGradient }}
                    >
                      <div className="min-w-fit text-sm font-semibold text-muted">#{row.position}</div>
                      <div className="flex-1 min-w-0">
                        <div className="text-lg font-bold text-foreground truncate">{row.displayName}</div>
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
                        <div className="text-sm font-semibold text-foreground">
                          {Math.round(applyMMRTransform(row.mmr, mmrScale, mmrShift))} MMR
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {viewMode === "main" && (
          <div>
            <p className="mb-4 text-sm text-muted">
              Rank Queue standing. Top 10 rows are the live projected Prism cut.
            </p>
            <LeaderboardTable rows={mainBoardRows} topCount={10} mmrScale={mmrScale} mmrShift={mmrShift} />
          </div>
        )}

        {viewMode === "all-time" && (
          <div>
            <p className="mb-4 text-sm text-muted">
              Click a column header to sort. All-time lifetime stats.
            </p>
            <StatsBoard
              players={statsPlayers}
              mode="all-time"
              currentSeason={null}
              previousSeason={null}
              mmrScale={mmrScale}
              mmrShift={mmrShift}
            />
          </div>
        )}
      </div>
    </div>
  );
}
