"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import SearchBar from "./SearchBar";
import PlayerAvatar from "./PlayerAvatar";
import type { CompletedGame } from "@/lib/leaderboard/queries";
import { computeStats, filterGames } from "@/lib/leaderboard/stats";
import { formatDisplayName } from "@/lib/leaderboard/formatName";
import { playTap } from "@/lib/sound";

export interface StatsPlayer {
  playerId: string;
  displayName: string;
  avatarUrl: string | null;
  games: CompletedGame[];
  // Required, not optional — an optional field here silently defaulted to 0 at the one call site
  // that forgot it (UnifiedLeaderboard's home-page All-Time tab), which rendered as "NA" for every
  // player while the standalone /stats/all-time route was correct. Keep it mandatory so a missing
  // peak is a compile error rather than a plausible-looking wrong number.
  peakMmr: number;
}

export interface SeasonRef {
  id: string;
  seasonNumber: number;
}

type SortKey =
  | "gamesPlayed"
  | "wins"
  | "losses"
  | "winRate"
  | "longestWinStreak"
  | "currentStreak"
  | "peakMmr";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "gamesPlayed", label: "Games" },
  { key: "wins", label: "W" },
  { key: "losses", label: "L" },
  { key: "winRate", label: "Win rate" },
  { key: "longestWinStreak", label: "Longest streak" },
  { key: "currentStreak", label: "Current streak" },
];

// Peak MMR is only meaningful on the All-Time board (a season-scoped "peak" would need a
// separate per-season high-water mark this codebase doesn't track).
const PEAK_COLUMN: { key: SortKey; label: string } = { key: "peakMmr", label: "Peak" };

// peak_mmr only starts accumulating once a player claims their rank (crosses
// placement_games_required raw Rank Queue games — currently 3 on the live server); before that
// it's untouched at its raw default of 0. Raw MMR can end up fractionally off 0 from float math
// elsewhere, so treat anything within this epsilon of 0 as "no peak yet" rather than exact
// equality — matches how CLAUDE.md's peak_mmr backfill script itself reasons about the value.
const NO_PEAK_EPSILON = 0.01;

function applyMMRTransform(mmr: number, scale: number, shift: number): number {
  return mmr * scale + shift;
}

export default function StatsBoard({
  players,
  mode,
  currentSeason,
  previousSeason,
  mmrScale = 1,
  mmrShift = 0,
}: {
  players: StatsPlayer[];
  mode: "season" | "all-time";
  currentSeason: SeasonRef | null;
  previousSeason: SeasonRef | null;
  mmrScale?: number;
  mmrShift?: number;
}) {
  const [seasonScope, setSeasonScope] = useState<"current" | "previous">("current");
  const [sortKey, setSortKey] = useState<SortKey>("gamesPlayed");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [highlightedPlayerId, setHighlightedPlayerId] = useState<string | null>(null);
  const highlightRef = useRef<HTMLTableRowElement>(null);

  const selectedSeasonId =
    mode === "season" ? (seasonScope === "current" ? currentSeason?.id : previousSeason?.id) : undefined;

  const rows = useMemo(() => {
    return players.map((p) => {
      const scoped = filterGames(p.games, {
        seasonId: mode === "season" ? selectedSeasonId : undefined,
      });
      const stats = computeStats(scoped);
      return {
        playerId: p.playerId,
        displayName: p.displayName,
        avatarUrl: p.avatarUrl,
        peakMmr: p.peakMmr,
        ...stats,
      };
    });
  }, [players, selectedSeasonId, mode]);

  const showPeakColumn = mode === "all-time";
  const columns = showPeakColumn ? [...COLUMNS, PEAK_COLUMN] : COLUMNS;

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
        case "peakMmr":
          // A "no peak yet" player has raw peakMmr === 0, which is a real, sortable MMR value —
          // sorting on it directly let them land ahead of placed players with a negative raw peak,
          // and displayed as a misleadingly large transformed number (e.g. 1000 at the live
          // mmr_shift). Force them to sort last regardless of direction instead: ±Infinity always
          // loses the desc/asc comparison against a real (finite) peak.
          value =
            Math.abs(row.peakMmr) <= NO_PEAK_EPSILON
              ? sortDir === "desc"
                ? -Infinity
                : Infinity
              : row.peakMmr;
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

  function handleSearch(playerId: string | null) {
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

  const header = (
    <tr className="bg-surface-2/60 text-left text-muted">
      <th className="py-2.5 pr-3 pl-4 font-semibold">Player</th>
      {columns.map((col) => (
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
      <div className="mb-4 flex flex-wrap items-center gap-4 text-sm">
        {mode === "season" && (
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

      <div className="mb-4 w-full max-w-sm">
        <SearchBar players={rows} onSearch={handleSearch} />
      </div>

      {sortedRows.length === 0 ? (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>{header}</thead>
            <tbody>
              <tr>
                <td colSpan={columns.length + 1} className="py-10 text-center text-muted">
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
              {sortedRows.map((row) => {
                const isHighlighted = row.playerId === highlightedPlayerId;
                return (
                  <tr
                    key={row.playerId}
                    ref={isHighlighted ? highlightRef : null}
                    className={`row-hover border-b border-border text-foreground last:border-b-0 ${
                      isHighlighted ? "highlight-pulse" : ""
                    }`}
                  >
                    <td className="py-2 pr-3 pl-4 font-medium">
                      <PlayerAvatar avatarUrl={row.avatarUrl} alt={row.displayName} />
                      {formatDisplayName(row.displayName)}
                    </td>
                    <td className="py-2 pr-3">{row.gamesPlayed}</td>
                    <td className="py-2 pr-3">{row.wins}</td>
                    <td className="py-2 pr-3">{row.losses}</td>
                    <td className="py-2 pr-3">
                      {row.winRate === null ? "—" : `${Math.round(row.winRate * 100)}%`}
                    </td>
                    <td className="py-2 pr-3">{row.longestWinStreak}</td>
                    <td className="py-2 pr-3">
                      {row.currentStreak.type ? (
                        <span
                          className={
                            row.currentStreak.type === "W"
                              ? "text-green-400"
                              : row.currentStreak.type === "L"
                                ? "text-red-400"
                                : ""
                          }
                        >
                          {row.currentStreak.type}
                          {row.currentStreak.count}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    {showPeakColumn && (
                      <td className="py-2 pr-3">
                        {Math.abs(row.peakMmr) <= NO_PEAK_EPSILON
                          ? "NA"
                          : Math.round(applyMMRTransform(row.peakMmr, mmrScale, mmrShift))}
                      </td>
                    )}
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
