"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import SearchBar from "./SearchBar";
import PlayerAvatar from "./PlayerAvatar";
import { formatDisplayName } from "@/lib/leaderboard/formatName";
import { playTap } from "@/lib/sound";
import type { QueueType } from "@/lib/supabase/types";
import type { HeadToHeadGame, HeadToHeadPlayerInfo } from "@/lib/leaderboard/headToHead";

type QueueFilter = QueueType | "all";
type Relation = "with" | "against";
type SortKey = "gamesPlayed" | "diff" | "winRate";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "gamesPlayed", label: "Games" },
  { key: "diff", label: "+/-" },
  { key: "winRate", label: "Win rate" },
];

const QUEUE_OPTIONS: QueueFilter[] = ["all", "rank", "universal"];

export default function HeadToHeadBoard({
  target,
  games,
  players,
}: {
  target: HeadToHeadPlayerInfo;
  games: HeadToHeadGame[];
  players: HeadToHeadPlayerInfo[];
}) {
  const router = useRouter();
  const [queueFilter, setQueueFilter] = useState<QueueFilter>("all");
  const [relation, setRelation] = useState<Relation>("with");
  const [sortKey, setSortKey] = useState<SortKey>("gamesPlayed");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [highlightedPlayerId, setHighlightedPlayerId] = useState<string | null>(null);
  const highlightRef = useRef<HTMLTableRowElement>(null);

  const playersById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);

  // Recomputed client-side on every filter/relation toggle from the full game list handed down
  // by the server — same "fetch once, filter client-side" shape StatsBoard already uses for its
  // queue/season filters, so toggling here needs no round trip.
  const rows = useMemo(() => {
    const acc = new Map<string, { gamesPlayed: number; wins: number; losses: number }>();
    for (const game of games) {
      if (queueFilter !== "all" && game.queueType !== queueFilter) continue;
      const ids = relation === "with" ? game.teammateIds : game.opponentIds;
      for (const id of ids) {
        const entry = acc.get(id) ?? { gamesPlayed: 0, wins: 0, losses: 0 };
        entry.gamesPlayed += 1;
        if (game.won) entry.wins += 1;
        else entry.losses += 1;
        acc.set(id, entry);
      }
    }
    return Array.from(acc.entries()).map(([id, stats]) => {
      const info = playersById.get(id);
      return {
        playerId: id,
        displayName: info?.displayName ?? "Unknown Player",
        avatarUrl: info?.avatarUrl ?? null,
        gamesPlayed: stats.gamesPlayed,
        diff: stats.wins - stats.losses,
        winRate: stats.gamesPlayed > 0 ? stats.wins / stats.gamesPlayed : null,
      };
    });
  }, [games, queueFilter, relation, playersById]);

  const sortedRows = useMemo(() => {
    const withSortValue = rows.map((row) => {
      let value: number;
      switch (sortKey) {
        case "winRate":
          value = row.winRate ?? -1;
          break;
        default:
          value = row[sortKey];
      }
      return { row, value };
    });
    withSortValue.sort((a, b) => (sortDir === "desc" ? b.value - a.value : a.value - b.value));
    return withSortValue.map((x) => x.row);
  }, [rows, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    playTap();
    if (key === sortKey) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function selectQueueFilter(q: QueueFilter) {
    playTap();
    setQueueFilter(q);
  }

  function selectRelation(r: Relation) {
    playTap();
    setRelation(r);
  }

  function handleSearch(playerId: string | null) {
    setHighlightedPlayerId(playerId);
  }

  // Re-centers the whole page on the clicked player rather than doing anything in-place — their
  // head-to-head record is a different data set entirely (a different target's games), not a
  // filter over what's already loaded.
  function goToPlayer(playerId: string) {
    playTap();
    router.push(`/head-to-head/${playerId}`);
  }

  useEffect(() => {
    if (highlightedPlayerId && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
      const timer = setTimeout(() => setHighlightedPlayerId(null), 1800);
      return () => clearTimeout(timer);
    }
  }, [highlightedPlayerId]);

  const header = (
    <tr className="bg-surface-2/60 text-left text-muted">
      <th className="py-2.5 pr-3 pl-4 font-semibold">Player</th>
      {COLUMNS.map((col) => (
        <th
          key={col.key}
          className="cursor-pointer select-none py-2.5 pr-3 font-semibold transition-colors hover:text-foreground"
          onClick={() => toggleSort(col.key)}
        >
          {col.label}
          {sortKey === col.key ? (
            <span className="text-accent-secondary">{sortDir === "desc" ? " ↓" : " ↑"}</span>
          ) : (
            ""
          )}
        </th>
      ))}
    </tr>
  );

  return (
    <div>
      <div className="mb-4 flex items-center gap-1.5">
        <PlayerAvatar avatarUrl={target.avatarUrl} alt={target.displayName} />
        <h2 className="text-lg font-bold text-foreground">{formatDisplayName(target.displayName)}</h2>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-4 text-sm">
        <div className="segmented">
          {(["with", "against"] as const).map((r) => (
            <button
              key={r}
              type="button"
              data-active={relation === r}
              className="segmented-btn capitalize"
              onClick={() => selectRelation(r)}
            >
              {r}
            </button>
          ))}
        </div>
        <div className="segmented">
          {QUEUE_OPTIONS.map((q) => (
            <button
              key={q}
              type="button"
              data-active={queueFilter === q}
              className="segmented-btn capitalize"
              onClick={() => selectQueueFilter(q)}
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      <p className="mb-4 text-sm text-muted">
        {relation === "with"
          ? `${target.displayName}'s record in games played on the same team as each player. Click a column header to sort, or a player to see their head-to-head.`
          : `${target.displayName}'s record in games played against each player. Click a column header to sort, or a player to see their head-to-head.`}
      </p>

      <div className="mb-4 w-full max-w-sm">
        <SearchBar players={rows} onSearch={handleSearch} />
      </div>

      {sortedRows.length === 0 ? (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>{header}</thead>
            <tbody>
              <tr>
                <td colSpan={COLUMNS.length + 1} className="py-10 text-center text-muted">
                  No games yet.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-hidden overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>{header}</thead>
            <tbody>
              {sortedRows.map((row) => {
                const isHighlighted = row.playerId === highlightedPlayerId;
                return (
                  <tr
                    key={row.playerId}
                    ref={isHighlighted ? highlightRef : null}
                    className={`row-hover cursor-pointer border-b border-border text-foreground last:border-b-0 ${
                      isHighlighted ? "highlight-pulse" : ""
                    }`}
                    onClick={() => goToPlayer(row.playerId)}
                  >
                    <td className="py-2 pr-3 pl-4 font-medium">
                      <PlayerAvatar avatarUrl={row.avatarUrl} alt={row.displayName} />
                      {formatDisplayName(row.displayName)}
                    </td>
                    <td className="py-2 pr-3">{row.gamesPlayed}</td>
                    <td
                      className={`py-2 pr-3 font-semibold ${
                        row.diff > 0 ? "text-green-500" : row.diff < 0 ? "text-red-500" : "text-muted"
                      }`}
                    >
                      {row.diff > 0 ? `+${row.diff}` : row.diff}
                    </td>
                    <td className="py-2 pr-3">
                      {row.winRate === null ? "—" : `${Math.round(row.winRate * 100)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
