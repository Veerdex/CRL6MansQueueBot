"use client";

import { useMemo, useRef, useState } from "react";
import LeaderboardTable, { type MainBoardRow } from "./LeaderboardTable";
import StatsBoard, { type StatsPlayer } from "./StatsBoard";
import PlayerAvatar from "./PlayerAvatar";
import { computeStats, filterGames, FLAME_THRESHOLD, COLD_THRESHOLD } from "@/lib/leaderboard/stats";
import { getRankIconPath, getRankLabel, type DisplayBand } from "@/lib/leaderboard/rankIcon";
import { formatDisplayName } from "@/lib/leaderboard/formatName";
import { playTap } from "@/lib/sound";
import type { CompletedGame, PlayerWithGames } from "@/lib/leaderboard/queries";
import type { SeasonHistoryRow, SeasonRow } from "@/lib/supabase/types";

// First N ranked rows (in caller-supplied order) that also meet the min-games gate get the dim
// gold "topFive" row background — independent of, and unrelated to, prism_top_n/is_prism (the
// live single Prism-holder achievement). Applies the same everywhere it's used: Top Players
// (current season and any past season) and Main.
const TOP_FIVE_COUNT = 5;

// Marks the first TOP_FIVE_COUNT items (in order) that satisfy `isEligible`, skipping (not
// renumbering) ineligible ones — so a player short of the games threshold doesn't let a 6th-place
// player inherit the gold background. Written as a pure reduce (no cross-iteration variable
// reassignment) since the render-time immutability lint rejects a plain mutable running counter.
function markTopFive<T>(items: T[], isEligible: (item: T) => boolean): boolean[] {
  return items.reduce<{ flags: boolean[]; remaining: number }>(
    (acc, item) => {
      const eligible = acc.remaining > 0 && isEligible(item);
      return { flags: [...acc.flags, eligible], remaining: eligible ? acc.remaining - 1 : acc.remaining };
    },
    { flags: [], remaining: TOP_FIVE_COUNT },
  ).flags;
}

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
  seasons: SeasonRow[];
  seasonHistory: SeasonHistoryRow[];
  mmrScale: number;
  mmrShift: number;
  prismTopN: number;
  top10MinGames: number;
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
  seasons,
  seasonHistory,
  mmrScale,
  mmrShift,
  prismTopN,
  top10MinGames,
}: UnifiedLeaderboardProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("main");

  const eligiblePlayers = players.filter(({ player }) => player.total_games_played >= 1);
  const playersById = useMemo(() => new Map(players.map((p) => [p.player.id, p.player])), [players]);

  const sortedSeasons = useMemo(
    () => [...seasons].sort((a, b) => a.season_number - b.season_number),
    [seasons],
  );
  const minSeasonNumber = sortedSeasons[0]?.season_number ?? 1;
  const maxSeasonNumber = sortedSeasons[sortedSeasons.length - 1]?.season_number ?? 1;
  const activeSeasonNumber = seasons.find((s) => s.is_active)?.season_number ?? maxSeasonNumber;
  const activeSeasonId = seasons.find((s) => s.is_active)?.id ?? null;

  // Top Players season browser: number input + arrows, defaulting to the current season.
  const [selectedSeasonNumber, setSelectedSeasonNumber] = useState(activeSeasonNumber);
  const [seasonInputDraft, setSeasonInputDraft] = useState(String(activeSeasonNumber));
  const seasonInputRef = useRef<HTMLInputElement>(null);

  const selectedSeason = sortedSeasons.find((s) => s.season_number === selectedSeasonNumber) ?? null;
  // No seasons at all (shouldn't happen in practice — a season is always active) falls back to
  // the live board, same as before this feature existed.
  const isCurrentSeason = selectedSeason?.is_active ?? true;

  function flashInvalidSeasonInput() {
    const el = seasonInputRef.current;
    if (!el) return;
    // Remove-then-reflow-then-add so a rapid repeat press restarts the animation instead of
    // being a no-op (the browser otherwise treats re-adding an already-present class as nothing).
    el.classList.remove("field-invalid-flash");
    void el.offsetWidth;
    el.classList.add("field-invalid-flash");
  }

  function goToSeason(seasonNumber: number) {
    setSelectedSeasonNumber(seasonNumber);
    setSeasonInputDraft(String(seasonNumber));
  }

  function handlePrevSeason() {
    playTap();
    if (selectedSeasonNumber <= minSeasonNumber) {
      flashInvalidSeasonInput();
      return;
    }
    goToSeason(selectedSeasonNumber - 1);
  }

  function handleNextSeason() {
    playTap();
    if (selectedSeasonNumber >= maxSeasonNumber) {
      flashInvalidSeasonInput();
      return;
    }
    goToSeason(selectedSeasonNumber + 1);
  }

  function commitSeasonInput(raw: string) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      flashInvalidSeasonInput();
      setSeasonInputDraft(String(selectedSeasonNumber));
      return;
    }
    if (parsed < minSeasonNumber || parsed > maxSeasonNumber) {
      flashInvalidSeasonInput();
    }
    goToSeason(Math.min(maxSeasonNumber, Math.max(minSeasonNumber, parsed)));
  }

  // Top Players view: simplified list — unranked players are excluded, not just unbanded on
  // the Main board, since this view is specifically a ranking by band/MMR.
  const topPlayersRows = useMemo(() => {
    const sorted = eligiblePlayers
      .filter(({ player }) => player.is_placed)
      .slice()
      .sort(compareLeaderboardRank)
      .slice(0, 20);
    const topFiveFlags = markTopFive(
      sorted,
      (p) => activeSeasonId !== null && filterGames(p.games, { seasonId: activeSeasonId }).length >= top10MinGames,
    );
    return sorted.map((p, idx) => ({
      position: idx + 1,
      displayName: p.player.display_name,
      avatarUrl: p.player.avatar_url,
      band: p.player.is_placed ? p.player.band : null,
      isPrism: p.player.is_prism,
      mmr: p.player.mmr,
      topFive: topFiveFlags[idx],
    }));
  }, [eligiblePlayers, activeSeasonId, top10MinGames]);

  // Past-season standings come from the archived season_history rows, ordered by the rank
  // already computed at season-close time (see seasonClose.ts) rather than recomputed here.
  // Band/avatar/display name follow the same precedent as Hall of Fame: since band is a live-only
  // concept never archived per season, they're sourced from the player's current live row. There's
  // no live Prism concept for a past season, so isPrism is always false here — only the topFive
  // dim-gold background applies to historical standings.
  const historicalTopPlayersRows = useMemo(() => {
    if (!selectedSeason) return [];
    const sorted = seasonHistory
      .filter((h) => h.season_id === selectedSeason.id)
      .sort((a, b) => a.season_rank - b.season_rank)
      .slice(0, 20);
    const topFiveFlags = markTopFive(sorted, (h) => h.season_games_played >= top10MinGames);
    return sorted
      .map((h, idx) => {
        const player = playersById.get(h.player_id);
        if (!player) return null;
        return {
          position: idx + 1,
          displayName: player.display_name,
          avatarUrl: player.avatar_url,
          band: player.band,
          isPrism: false,
          mmr: h.mmr_at_close,
          topFive: topFiveFlags[idx],
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
  }, [seasonHistory, selectedSeason, playersById, top10MinGames]);

  const displayedTopPlayersRows = isCurrentSeason ? topPlayersRows : historicalTopPlayersRows;

  // Main view: current leaderboard
  const mainBoardRows = useMemo(() => {
    const sorted = eligiblePlayers.slice().sort(compareLeaderboardRank);
    const topFiveFlags = markTopFive(
      sorted,
      ({ games }) => activeSeasonId !== null && filterGames(games, { seasonId: activeSeasonId }).length >= top10MinGames,
    );
    const rows: MainBoardRow[] = sorted.map(({ player, games }, idx) => {
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
        topFive: topFiveFlags[idx],
      };
    });
    return rows;
  }, [eligiblePlayers, activeSeasonId, top10MinGames]);

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
            <div className="mb-4 flex items-center justify-center gap-2">
              <span className="text-sm font-medium text-muted">Season</span>
              <button
                type="button"
                className="btn-icon"
                onClick={handlePrevSeason}
                aria-label="Previous season"
              >
                ‹
              </button>
              <input
                ref={seasonInputRef}
                type="number"
                inputMode="numeric"
                className="field w-16 py-1.5 text-center text-sm font-semibold"
                value={seasonInputDraft}
                onChange={(e) => setSeasonInputDraft(e.target.value)}
                onBlur={(e) => commitSeasonInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                aria-label="Season number"
              />
              <button
                type="button"
                className="btn-icon"
                onClick={handleNextSeason}
                aria-label="Next season"
              >
                ›
              </button>
            </div>
            <p className="mb-4 text-sm text-muted">
              {isCurrentSeason
                ? "Top players by MMR ranking. Rank Queue standing only."
                : `Final standings for Season ${selectedSeasonNumber}.`}
            </p>
            {displayedTopPlayersRows.length === 0 ? (
              <div className="py-10 text-center text-muted">No players yet.</div>
            ) : (
              <div className="space-y-2">
                {displayedTopPlayersRows.map((row) => {
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
                      className={`row-hover flex items-center gap-4 rounded-lg px-4 py-3 ${row.topFive ? "gold-row" : ""}`}
                      style={rowGlow ? { backgroundImage: rowGlow } : undefined}
                    >
                      <div className={`min-w-fit text-sm font-semibold ${showPrismStyling ? "text-gold" : "text-muted"}`}>
                        #{row.position}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center text-lg font-bold text-foreground">
                          <PlayerAvatar
                            avatarUrl={row.avatarUrl}
                            alt={row.displayName}
                            glow={row.isPrism}
                          />
                          <span className="truncate">{formatDisplayName(row.displayName)}</span>
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
