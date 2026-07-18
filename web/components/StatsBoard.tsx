"use client";

import { useMemo, useState } from "react";
import type { CompletedGame } from "@/lib/leaderboard/queries";
import { computeStats, filterGames } from "@/lib/leaderboard/stats";
import { playTap } from "@/lib/sound";
import type { QueueType } from "@/lib/supabase/types";

export interface StatsPlayer {
  playerId: string;
  displayName: string;
  games: CompletedGame[];
}

export interface SeasonRef {
  id: string;
  seasonNumber: number;
}

type QueueFilter = QueueType | "all";
type SortKey = "gamesPlayed" | "wins" | "losses" | "winRate" | "longestWinStreak" | "currentStreak";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "gamesPlayed", label: "Games" },
  { key: "wins", label: "W" },
  { key: "losses", label: "L" },
  { key: "winRate", label: "Win rate" },
  { key: "longestWinStreak", label: "Longest streak" },
  { key: "currentStreak", label: "Current streak" },
];

const QUEUE_OPTIONS: QueueFilter[] = ["all", "rank", "universal"];

export default function StatsBoard({
  players,
  mode,
  currentSeason,
  previousSeason,
}: {
  players: StatsPlayer[];
  mode: "season" | "all-time";
  currentSeason: SeasonRef | null;
  previousSeason: SeasonRef | null;
}) {
  const [queueFilter, setQueueFilter] = useState<QueueFilter>("all");
  const [seasonScope, setSeasonScope] = useState<"current" | "previous">("current");
  const [sortKey, setSortKey] = useState<SortKey>("gamesPlayed");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const selectedSeasonId =
    mode === "season" ? (seasonScope === "current" ? currentSeason?.id : previousSeason?.id) : undefined;

  const rows = useMemo(() => {
    return players.map((p) => {
      const scoped = filterGames(p.games, {
        seasonId: mode === "season" ? selectedSeasonId : undefined,
        queueType: queueFilter,
      });
      const stats = computeStats(scoped);
      return { playerId: p.playerId, displayName: p.displayName, ...stats };
    });
  }, [players, queueFilter, selectedSeasonId, mode]);

  const sortedRows = useMemo(() => {
    const withSortValue = rows.map((row) => {
      let value: number;
      switch (sortKey) {
        case "winRate":
          value = row.winRate ?? -1;
          break;
        case "currentStreak":
          value =
            row.currentStreak.type === "W"
              ? row.currentStreak.count
              : row.currentStreak.type === "L"
                ? -row.currentStreak.count
                : 0;
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

  function selectSeasonScope(scope: "current" | "previous") {
    if (scope === "previous" && !previousSeason) return;
    playTap();
    setSeasonScope(scope);
  }

  function selectQueueFilter(q: QueueFilter) {
    playTap();
    setQueueFilter(q);
  }

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
            <span className="text-accent">{sortDir === "desc" ? " ↓" : " ↑"}</span>
          ) : (
            ""
          )}
        </th>
      ))}
    </tr>
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-4 text-sm">
        {mode === "season" && (
          <div className="segmented">
            <button
              type="button"
              data-active={seasonScope === "current"}
              className="segmented-btn"
              onClick={() => selectSeasonScope("current")}
            >
              Current{currentSeason ? ` (#${currentSeason.seasonNumber})` : ""}
            </button>
            <button
              type="button"
              data-active={seasonScope === "previous"}
              className={`segmented-btn ${previousSeason ? "" : "cursor-not-allowed opacity-40"}`}
              onClick={() => selectSeasonScope("previous")}
              disabled={!previousSeason}
            >
              Previous{previousSeason ? ` (#${previousSeason.seasonNumber})` : ""}
            </button>
          </div>
        )}
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

      {sortedRows.length === 0 ? (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>{header}</thead>
            <tbody>
              <tr>
                <td colSpan={COLUMNS.length + 1} className="py-10 text-center text-muted">
                  No players yet.
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
              {sortedRows.map((row) => (
                <tr key={row.playerId} className="row-hover border-b border-border text-foreground last:border-b-0">
                  <td className="py-2 pr-3 pl-4 font-medium">{row.displayName}</td>
                  <td className="py-2 pr-3">{row.gamesPlayed}</td>
                  <td className="py-2 pr-3">{row.wins}</td>
                  <td className="py-2 pr-3">{row.losses}</td>
                  <td className="py-2 pr-3">
                    {row.winRate === null ? "—" : `${Math.round(row.winRate * 100)}%`}
                  </td>
                  <td className="py-2 pr-3">{row.longestWinStreak}</td>
                  <td className="py-2 pr-3">
                    {row.currentStreak.type ? `${row.currentStreak.type}${row.currentStreak.count}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
