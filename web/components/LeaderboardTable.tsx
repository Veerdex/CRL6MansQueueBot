"use client";

import { useEffect, useRef, useState } from "react";
import SearchBar from "./SearchBar";
import { getRankIconPath, getRankLabel } from "@/lib/leaderboard/rankIcon";
import type { Band } from "@/lib/supabase/types";

export interface MainBoardRow {
  playerId: string;
  displayName: string;
  band: Band | null;
  mmr: number | null;
  wins: number;
  losses: number;
  winRate: number | null;
}

const PAGE_SIZE = 20;

function formatWinRate(winRate: number | null) {
  return winRate === null ? "—" : `${Math.round(winRate * 100)}%`;
}

export default function LeaderboardTable({
  rows,
  topCount,
}: {
  rows: MainBoardRow[];
  topCount: number;
}) {
  const [page, setPage] = useState(0);
  const [highlightedPlayerId, setHighlightedPlayerId] = useState<string | null>(null);
  const highlightRef = useRef<HTMLTableRowElement>(null);

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
                const isTopCut = position <= topCount;
                const isHighlighted = row.playerId === highlightedPlayerId;
                return (
                  <tr
                    key={row.playerId}
                    ref={isHighlighted ? highlightRef : null}
                    className={`row-hover border-b border-border text-foreground last:border-b-0 ${
                      isTopCut ? "top-cut" : ""
                    } ${isHighlighted ? "highlight-pulse" : ""}`}
                  >
                    <td className="py-2 pr-3 pl-4">{position}</td>
                    <td className="py-2 pr-3 font-medium">{row.displayName}</td>
                    <td className="py-2 pr-3">
                      <img
                        src={getRankIconPath(row.band)}
                        alt={getRankLabel(row.band)}
                        title={getRankLabel(row.band)}
                        className="h-6 w-6"
                      />
                    </td>
                    <td className="py-2 pr-3">{row.mmr === null ? "NA" : Math.round(row.mmr)}</td>
                    <td className="py-2 pr-3">{row.wins}</td>
                    <td className="py-2 pr-3">{row.losses}</td>
                    <td className="py-2 pr-3">{formatWinRate(row.winRate)}</td>
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
