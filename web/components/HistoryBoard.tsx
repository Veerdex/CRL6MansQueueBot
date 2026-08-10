"use client";

import { useMemo, useState } from "react";
import HistoryPlayerFilter from "./HistoryPlayerFilter";
import MatchHistoryCard from "./MatchHistoryCard";
import type { MatchHistoryEntry } from "@/lib/leaderboard/history";

const PAGE_SIZE = 10;

export default function HistoryBoard({
  matches,
  players,
  mmrScale,
  mmrShift,
}: {
  matches: MatchHistoryEntry[];
  players: { playerId: string; displayName: string }[];
  mmrScale: number;
  mmrShift: number;
}) {
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    if (!selectedPlayerId) return matches;
    return matches.filter(
      (m) =>
        m.teamA.some((p) => p.playerId === selectedPlayerId) ||
        m.teamB.some((p) => p.playerId === selectedPlayerId),
    );
  }, [matches, selectedPlayerId]);

  function selectPlayer(playerId: string | null) {
    setSelectedPlayerId(playerId);
    setPage(0);
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);
  const pageMatches = filtered.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);

  return (
    <div className="space-y-4">
      <HistoryPlayerFilter players={players} selectedPlayerId={selectedPlayerId} onSelect={selectPlayer} />

      {pageMatches.length === 0 ? (
        <div className="rounded-xl border border-border py-10 text-center text-sm text-muted">
          No reported matches{selectedPlayerId ? " for this player" : ""} yet.
        </div>
      ) : (
        <div className="space-y-3">
          {pageMatches.map((match) => (
            <MatchHistoryCard key={match.seriesId} match={match} mmrScale={mmrScale} mmrShift={mmrShift} />
          ))}
        </div>
      )}

      {filtered.length > 0 && totalPages > 1 && (
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
            aria-label="Match history page"
          />
        </div>
      )}
    </div>
  );
}
