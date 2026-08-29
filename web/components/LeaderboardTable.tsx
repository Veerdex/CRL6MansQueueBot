"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import SearchBar from "./SearchBar";
import PlayerAvatar from "./PlayerAvatar";
import { getRankIconPath, getRankLabel, type DisplayBand } from "@/lib/leaderboard/rankIcon";
import { formatDisplayName } from "@/lib/leaderboard/formatName";
import { playTap } from "@/lib/sound";
import type { Band } from "@/lib/supabase/types";

export interface MainBoardRow {
  playerId: string;
  displayName: string;
  avatarUrl: string | null;
  band: Band | null;
  // Season-end achievement, held additively alongside `band` (see CLAUDE.md, "Bands / ranks") —
  // drives the gold text/brightened badge styling once the player has a real band again this
  // season (gated on `band !== null` at the render site), never a display-band substitute.
  isPrism: boolean;
  mmr: number;
  wins: number;
  losses: number;
  winRate: number | null;
  onFire: boolean;
  coldStreak: boolean;
  // First 5 ranked rows (in this board's own order) that also meet the top10_min_games
  // games-this-season threshold — independent of, and may coexist with, isPrism. Drives a dim
  // gold row background only, never the gold text/border that isPrism gets.
  topFive: boolean;
}

const PAGE_SIZE = 20;

function formatWinRate(winRate: number | null) {
  return winRate === null ? "—" : `${Math.round(winRate * 100)}%`;
}

// Hex, not rgb() — a hex alpha suffix is appended below (e.g. `${color}20`), which only forms a
// valid CSS color (#RRGGBBAA) when the base is hex; appending to `rgb(...)` is invalid CSS and
// gets silently dropped.
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

function applyMMRTransform(mmr: number, scale: number, shift: number): number {
  return mmr * scale + shift;
}

export default function LeaderboardTable({
  rows,
  mmrScale,
  mmrShift,
}: {
  rows: MainBoardRow[];
  mmrScale: number;
  mmrShift: number;
}) {
  const router = useRouter();
  const [page, setPage] = useState(0);
  const [highlightedPlayerId, setHighlightedPlayerId] = useState<string | null>(null);
  const highlightRef = useRef<HTMLTableRowElement>(null);

  function goToPlayer(playerId: string) {
    playTap();
    router.push(`/head-to-head/${playerId}`);
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);
  const start = clampedPage * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  function handleSearch(playerId: string | null) {
    if (!playerId) {
      setHighlightedPlayerId(null);
      return;
    }

    // Find the player's position in the full rows array
    const playerIndex = rows.findIndex((r) => r.playerId === playerId);
    if (playerIndex === -1) return;

    // Calculate which page the player is on
    const playerPage = Math.floor(playerIndex / PAGE_SIZE);
    setPage(playerPage);
    setHighlightedPlayerId(playerId);
  }

  useEffect(() => {
    if (highlightedPlayerId && highlightRef.current) {
      // Scroll the row into view
      highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });

      // Remove the animation class after it completes (3 cycles * 0.6s = 1.8s)
      const timer = setTimeout(() => {
        setHighlightedPlayerId(null);
      }, 1800);

      return () => clearTimeout(timer);
    }
  }, [highlightedPlayerId]);

  return (
    <div className="space-y-4">
      <SearchBar players={rows} onSearch={handleSearch} />
      <div className="overflow-hidden overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="bg-surface-2/60 text-left text-muted">
              <th className="py-2.5 pr-3 pl-4 font-semibold">#</th>
              <th className="py-2.5 pr-3 font-semibold">Player</th>
              <th className="py-2.5 pr-3 font-semibold">Band</th>
              <th className="py-2.5 pr-3 font-semibold">MMR</th>
              <th className="py-2.5 pr-3 font-semibold">W</th>
              <th className="py-2.5 pr-3 font-semibold">L</th>
              <th className="py-2.5 pr-3 font-semibold">Win rate</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-10 text-center text-muted">
                  No games played yet.
                </td>
              </tr>
            ) : (
              pageRows.map((row, i) => {
                const position = start + i + 1;
                const displayBand: DisplayBand | null = row.band;
                // Prism styling (gold text, brightened badge) only kicks in once the player has
                // a real band again this season — right after a season reset everyone's
                // Unranked, Prism or not. See CLAUDE.md, "Bands / ranks".
                const showPrismStyling = row.isPrism && row.band !== null;
                const isHighlighted = row.playerId === highlightedPlayerId;
                const bandColor = getBandColor(displayBand, showPrismStyling);
                const backgroundGradient = `linear-gradient(90deg, ${bandColor}20 0%, transparent 100%)`;
                return (
                  <tr
                    key={row.playerId}
                    ref={isHighlighted ? highlightRef : null}
                    className={`row-hover cursor-pointer border-b border-border text-foreground last:border-b-0 ${
                      showPrismStyling ? "top-cut" : ""
                    } ${row.topFive ? "gold-row" : ""} ${isHighlighted ? "highlight-pulse" : ""}`}
                    style={{ backgroundImage: backgroundGradient }}
                    onClick={() => goToPlayer(row.playerId)}
                  >
                    <td className={`py-2 pr-3 pl-4 ${showPrismStyling ? "font-semibold text-gold" : ""}`}>{position}</td>
                    <td className="py-2 pr-3 font-medium">
                      <PlayerAvatar avatarUrl={row.avatarUrl} alt={row.displayName} glow={row.isPrism} />
                      {formatDisplayName(row.displayName)}
                      {row.onFire && (
                        <span className="ml-1" title="3+ game win streak">
                          🔥
                        </span>
                      )}
                      {row.coldStreak && (
                        <span className="ml-1" title="3+ game losing streak">
                          🥶
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <img
                        src={getRankIconPath(displayBand)}
                        alt={getRankLabel(displayBand)}
                        title={getRankLabel(displayBand)}
                        className="h-6 w-6 object-contain"
                      />
                    </td>
                    <td className={`py-2 pr-3 ${showPrismStyling ? "font-semibold text-gold" : ""}`}>
                      {Math.round(applyMMRTransform(row.mmr, mmrScale, mmrShift))}
                    </td>
                    <td className={`py-2 pr-3 ${showPrismStyling ? "font-semibold text-gold" : ""}`}>{row.wins}</td>
                    <td className={`py-2 pr-3 ${showPrismStyling ? "font-semibold text-gold" : ""}`}>{row.losses}</td>
                    <td className={`py-2 pr-3 ${showPrismStyling ? "font-semibold text-gold" : ""}`}>
                      {formatWinRate(row.winRate)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {rows.length > 0 && totalPages > 1 && (
        <div className="mt-4 flex items-center gap-3 text-xs text-muted">
          <span className="whitespace-nowrap">
            Page {clampedPage + 1} / {totalPages}
          </span>
          <input
            type="range"
            min={0}
            max={totalPages - 1}
            step={1}
            value={clampedPage}
            onChange={(e) => setPage(Number(e.target.value))}
            className="h-1.5 flex-1 cursor-pointer accent-accent"
            aria-label="Leaderboard page"
          />
        </div>
      )}
    </div>
  );
}
