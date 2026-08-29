"use client";

import { useMemo, useState } from "react";
import LeaderboardTable, { type MainBoardRow } from "./LeaderboardTable";
import StatsBoard, { type StatsPlayer } from "./StatsBoard";
import PlayerAvatar from "./PlayerAvatar";
import { computeStats, filterGames, FLAME_THRESHOLD, COLD_THRESHOLD } from "@/lib/leaderboard/stats";
import { getRankIconPath, getRankLabel, type DisplayBand } from "@/lib/leaderboard/rankIcon";
import { formatDisplayName } from "@/lib/leaderboard/formatName";
import { playTap } from "@/lib/sound";
import type { CompletedGame, PlayerWithGames } from "@/lib/leaderboard/queries";
import type { SeasonHistoryRow } from "@/lib/supabase/types";

// Hex, not rgb() — these get a hex alpha suffix appended below (e.g. `${color}2e`), which only
// forms a valid CSS color (#RRGGBBAA) when the base is hex; appending to `rgb(...)` is invalid
// CSS and gets silently dropped, which is why the glow wasn't rendering.
// `bright` is the current Prism holder's badge tint (see CLAUDE.md, "Bands / ranks") — a subtly
// brightened variant of the player's own real band color, never a fixed Prism color.
function getBandColor(band: DisplayBand | null, bright = false): string {
  if (bright) {
    switch (band) {
      case "Iron":
        return "#9e9e9e";
      case "Garnet":
        return "#ff4d4d";
      case "Emerald":
        return "#00b34d";
      case "Sapphire":
        return "#4d4dff";
    }
  }
  switch (band) {
    case "Iron":
      return "#7d7d7d";
    case "Garnet":
      return "#ff0000";
    case "Emerald":
      return "#008000";
    case "Sapphire":
      return "#0000ff";
    default:
      // Unranked/null: gray
      return "#464646";
  }
}

type ViewMode = "top-players" | "main" | "all-time";

interface UnifiedLeaderboardProps {
  players: PlayerWithGames[];
  activeSeason: { id: string; season_number: number } | null;
  previousSeason: { id: string; season_number: number } | null;
  previousSeasonHistory: Map<string, SeasonHistoryRow>;
  mmrScale: number;
  mmrShift: number;
  prismTopN: number;
}

function applyMMRTransform(mmr: number, scale: number, shift: number): number {
  return mmr * scale + shift;
}

// Sorts purely on placement then MMR — band is not a ranking priority. All placed players
// (any band) rank strictly by MMR against each other regardless of band; unplaced players
// always group after every placed player (per CLAUDE.md: "the only separation is between
// unbanded and banded players"), then MMR breaks ties within that group too.
function compareLeaderboardRank(a: PlayerWithGames, b: PlayerWithGames): number {
  const placedDiff = Number(b.player.is_placed) - Number(a.player.is_placed);
  if (placedDiff !== 0) return placedDiff;
  const mmrDiff = b.player.mmr - a.player.mmr;
  if (mmrDiff !== 0) return mmrDiff;
  return a.player.id.localeCompare(b.player.id);
}

export default function UnifiedLeaderboard({
  players,
  activeSeason,
  previousSeason,
  previousSeasonHistory,
  mmrScale,
  mmrShift,
  prismTopN,
}: UnifiedLeaderboardProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("main");

  const eligiblePlayers = players.filter(({ player }) => player.total_games_played >= 1);

  // Top Players view: simplified list — unranked players are excluded, not just unbanded on
  // the Main board, since this view is specifically a ranking by band/MMR.
  const topPlayersRows = useMemo(() => {
    return eligiblePlayers
      .filter(({ player }) => player.is_placed)
      .slice()
      .sort(compareLeaderboardRank)
      .slice(0, 20)
      .map((p, idx) => ({
        position: idx + 1,
        displayName: p.player.display_name,
        avatarUrl: p.player.avatar_url,
        band: p.player.is_placed ? p.player.band : null,
        isPrism: p.player.is_prism,
        mmr: p.player.mmr,
      }));
  }, [eligiblePlayers]);

  // Main view: current leaderboard
  const mainBoardRows = useMemo(() => {
    const rows: MainBoardRow[] = eligiblePlayers
      .slice()
      .sort(compareLeaderboardRank)
      .map(({ player, games }) => {
        const rankStats = computeStats(filterGames(games, {}));
        return {
          playerId: player.id,
          displayName: player.display_name,
          avatarUrl: player.avatar_url,
          band: player.is_placed ? player.band : null,
          isPrism: player.is_prism,
          mmr: player.mmr,
          wins: rankStats.wins,
          losses: rankStats.losses,
          winRate: rankStats.winRate,
          onFire: rankStats.currentStreak.type === "W" && rankStats.currentStreak.count >= FLAME_THRESHOLD,
          coldStreak: rankStats.currentStreak.type === "L" && rankStats.currentStreak.count >= COLD_THRESHOLD,
        };
      });
    return rows;
  }, [eligiblePlayers]);

  // All-Time Stats view
  const statsPlayers = useMemo(() => {
    return eligiblePlayers.map(({ player, games }) => ({
      playerId: player.id,
      displayName: player.display_name,
      avatarUrl: player.avatar_url,
      games,
      peakMmr: player.peak_mmr,
    }));
  }, [eligiblePlayers]);

  function selectView(mode: ViewMode) {
    playTap();
    setViewMode(mode);
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
                  const displayBand: DisplayBand | null = row.band;
                  // Prism styling only kicks in once the player has a real band again this
                  // season — right after a season reset everyone's Unranked, Prism or not.
                  const showPrismStyling = row.isPrism && row.band !== null;
                  // Unranked (no band) gets no glow — nothing to color it by.
                  const bandColor = displayBand === null ? null : getBandColor(displayBand, showPrismStyling);
                  const rowGlow = bandColor
                    ? `radial-gradient(ellipse 70% 100% at 0% 50%, ${bandColor}2e 0%, transparent 75%)`
                    : undefined;
                  return (
                    <div
                      key={row.position}
                      className="row-hover flex items-center gap-4 rounded-lg px-4 py-3"
                      style={rowGlow ? { backgroundImage: rowGlow } : undefined}
                    >
                      <div className={`min-w-fit text-sm font-semibold ${showPrismStyling ? "text-gold" : "text-muted"}`}>
                        #{row.position}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-lg font-bold text-foreground truncate">
                          <PlayerAvatar avatarUrl={row.avatarUrl} alt={row.displayName} />
                          {formatDisplayName(row.displayName)}
                        </div>
                      </div>
                      <div className="text-right">
                        <img
                          src={getRankIconPath(displayBand)}
                          alt={getRankLabel(displayBand)}
                          title={getRankLabel(displayBand)}
                          className="h-6 w-6 object-contain"
                        />
                      </div>
                      <div className="text-right min-w-fit">
                        <div className={`text-sm font-semibold ${showPrismStyling ? "text-gold" : "text-foreground"}`}>
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
              Rank Queue standing.
            </p>
            <LeaderboardTable rows={mainBoardRows} mmrScale={mmrScale} mmrShift={mmrShift} />
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
