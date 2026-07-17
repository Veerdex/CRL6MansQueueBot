"use client";

import { useState } from "react";
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
  lastSeasonRank: number | null;
}

const PAGE_SIZE = 20;

function formatWinRate(winRate: number | null) {
  return winRate === null ? "—" : `${Math.round(winRate * 100)}%`;
}

function formatLastSeasonRank(rank: number | null) {
  return rank === null ? "NA" : `#${rank}`;
}

export default function LeaderboardTable({
  rows,
  topCount,
}: {
  rows: MainBoardRow[];
  topCount: number;
}) {
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);
  const start = clampedPage * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  return (
    <div>
      <div className="overflow-hidden overflow-x-auto rounded-xl border border-brand-blue">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="bg-white/5 text-left text-brand-orange">
              <th className="py-2.5 pr-3 pl-4 font-semibold">#</th>
              <th className="py-2.5 pr-3 font-semibold">Player</th>
              <th className="py-2.5 pr-3 font-semibold">Band</th>
              <th className="py-2.5 pr-3 font-semibold">MMR</th>
              <th className="py-2.5 pr-3 font-semibold">W</th>
              <th className="py-2.5 pr-3 font-semibold">L</th>
              <th className="py-2.5 pr-3 font-semibold">Win rate</th>
              <th className="py-2.5 pr-3 font-semibold">Last season</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-10 text-center text-brand-orange">
                  No games played yet.
                </td>
              </tr>
            ) : (
              pageRows.map((row, i) => {
                const position = start + i + 1;
                const isTopCut = position <= topCount;
                return (
                  <tr
                    key={row.playerId}
                    className={`border-b border-brand-blue last:border-b-0 ${
                      isTopCut ? "bg-gold text-zinc-950" : "text-brand-orange"
                    }`}
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
                    <td className="py-2 pr-3">{formatLastSeasonRank(row.lastSeasonRank)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {rows.length > 0 && totalPages > 1 && (
        <div className="mt-4 flex items-center gap-3 text-xs text-brand-orange">
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
            className="h-1.5 flex-1 cursor-pointer accent-brand-orange"
            aria-label="Leaderboard page"
          />
        </div>
      )}
    </div>
  );
}
