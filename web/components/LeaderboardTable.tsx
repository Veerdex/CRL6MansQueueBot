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
  // Only set by boards that carry an authoritative rank of their own (the archived per-season
  // standing); the live board leaves it off and numbers rows by their position in the list.
  position?: number;
  playerId: string;
  displayName: string;
  avatarUrl: string | null;
  band: Band | null;
  // Live top-N overlay (see CLAUDE.md, "Bands / ranks") — a Prism player's `band` column still
  // holds their real underlying band (almost always Sapphire); this flag drives the Prism icon,
  // the gold row/stat styling and the avatar glow independently of that.
  isPrism: boolean;
  // "Finished a season inside the Prism cut" — season_history.made_top10, archived at close.
  // Deliberately NOT `isPrism`: the live rank is cleared by the season soft reset, while the
  // avatar glow has always been the permanent alumni marker for last season's Prism finishers.
  wasPrism: boolean;
  mmr: number;
  wins: number;
  losses: number;
  winRate: number | null;
  onFire: boolean;
  coldStreak: boolean;
}

const PAGE_SIZE = 20;

function formatWinRate(winRate: number | null) {
  return winRate === null ? "—" : `${Math.round(winRate * 100)}%`;
}

// Hex, not rgb() — a hex alpha suffix is appended below (e.g. `${color}20`), which only forms a
// valid CSS color (#RRGGBBAA) when the base is hex; appending to `rgb(...)` is invalid CSS and
// gets silently dropped.
function getBandColor(band: DisplayBand | null): string {
  switch (band) {
    case "Iron":
      return "#7d7d7d";
    case "Garnet":
      return "#ff0000";
    case "Emerald":
      return "#008000";
    case "Sapphire":
      return "#0000ff";
    case "Prism":
      return "#c084fc";
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
  // Draft string + ref mirror the season picker in UnifiedLeaderboard: the field holds whatever
  // is being typed until it's committed, and the ref is only for the invalid-entry flash.
  const [pageInputDraft, setPageInputDraft] = useState("1");
  const pageInputRef = useRef<HTMLInputElement>(null);
  // Set only by the pager's own controls, never by a search-driven page jump — that one belongs
  // to the highlight scroll below and the two must not fight over the viewport.
  const pagerMovedRef = useRef(false);
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

  function flashInvalidPageInput() {
    const el = pageInputRef.current;
    if (!el) return;
    // Remove-then-reflow-then-add so a rapid repeat press restarts the animation instead of
    // being a no-op (the browser otherwise treats re-adding an already-present class as nothing).
    el.classList.remove("field-invalid-flash");
    void el.offsetWidth;
    el.classList.add("field-invalid-flash");
  }

  // Pages are 0-indexed internally and 1-indexed everywhere the reader sees them.
  function goToPage(index: number) {
    setPage(index);
    setPageInputDraft(String(index + 1));
  }

  function handlePrevPage() {
    playTap();
    if (clampedPage <= 0) {
      flashInvalidPageInput();
      return;
    }
    pagerMovedRef.current = true;
    goToPage(clampedPage - 1);
  }

  function handleNextPage() {
    playTap();
    if (clampedPage >= totalPages - 1) {
      flashInvalidPageInput();
      return;
    }
    pagerMovedRef.current = true;
    goToPage(clampedPage + 1);
  }

  function commitPageInput(raw: string) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      flashInvalidPageInput();
      setPageInputDraft(String(clampedPage + 1));
      return;
    }
    if (parsed < 1 || parsed > totalPages) {
      flashInvalidPageInput();
    }
    const target = Math.min(totalPages, Math.max(1, parsed)) - 1;
    // Guarded so the flag can't go stale: a commit that lands on the page already shown doesn't
    // re-render, so the effect below would never run to clear it.
    if (target !== clampedPage) pagerMovedRef.current = true;
    goToPage(target);
  }

  function handleSearch(playerId: string | null) {
    if (!playerId) {
      setHighlightedPlayerId(null);
      return;
    }

    // Find the player's position in the full rows array
    const playerIndex = rows.findIndex((r) => r.playerId === playerId);
    if (playerIndex === -1) return;

    // Jump to whichever page they're on before highlighting, or the scroll effect below has
    // nothing to scroll to.
    goToPage(Math.floor(playerIndex / PAGE_SIZE));
    setHighlightedPlayerId(playerId);
  }

  // The last page is almost always short, so leaving it grows the table underneath the pager and
  // pushes it off the bottom of the screen — you click "previous" and the control you were using
  // walks away from the pointer. Snap to the end of the document, where the pager lives (it's the
  // last thing on the page), which puts it back under the pointer at the same spot every time.
  // Instant, not smooth: a smooth scroll is still animating when an impatient second click lands,
  // and each click would then re-target from a moving position — the arrow would slide away from
  // the cursor mid-press. A step between two equal-length pages leaves the document the same
  // height, so this is a no-op there.
  useEffect(() => {
    if (!pagerMovedRef.current) return;
    pagerMovedRef.current = false;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
  }, [clampedPage]);

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
                const position = row.position ?? start + i + 1;
                // Prism is a live rank again (see CLAUDE.md, "Bands / ranks"), so it displaces
                // the player's underlying band everywhere it's shown — icon, label and color —
                // and drives the gold cut border and gold stats. The avatar glow is the one
                // Prism affordance it does *not* drive: that's `wasPrism` (last season's
                // finishers), so the two can and often will land on different rows.
                const displayBand: DisplayBand | null = row.isPrism ? "Prism" : row.band;
                const showPrismStyling = row.isPrism;
                const isHighlighted = row.playerId === highlightedPlayerId;
                const bandColor = getBandColor(displayBand);
                const backgroundGradient = `linear-gradient(90deg, ${bandColor}20 0%, transparent 100%)`;
                return (
                  <tr
                    key={row.playerId}
                    ref={isHighlighted ? highlightRef : null}
                    className={`row-hover cursor-pointer border-b border-border text-foreground last:border-b-0 ${
                      showPrismStyling ? "top-cut" : ""
                    } ${showPrismStyling ? "gold-row" : ""} ${isHighlighted ? "highlight-pulse" : ""}`}
                    style={{ backgroundImage: backgroundGradient }}
                    onClick={() => goToPlayer(row.playerId)}
                  >
                    <td className={`py-2 pr-3 pl-4 ${showPrismStyling ? "font-semibold text-gold" : ""}`}>{position}</td>
                    <td className="py-2 pr-3 font-medium">
                      <PlayerAvatar avatarUrl={row.avatarUrl} alt={row.displayName} glow={row.wasPrism} />
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

      {/* Same control shape as the season picker above the board — arrows either side of a
          type-in field — so the two read as one family instead of a slider and a stepper. */}
      {rows.length > 0 && totalPages > 1 && (
        <div className="mt-4 flex items-center justify-center gap-2">
          <span className="text-sm font-medium text-muted">Page</span>
          <button
            type="button"
            className="btn-icon"
            onClick={handlePrevPage}
            aria-label="Previous page"
          >
            ‹
          </button>
          <input
            ref={pageInputRef}
            type="number"
            inputMode="numeric"
            className="field w-16 py-1.5 text-center text-sm font-semibold"
            value={pageInputDraft}
            onChange={(e) => setPageInputDraft(e.target.value)}
            onBlur={(e) => commitPageInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            aria-label="Leaderboard page"
          />
          <button
            type="button"
            className="btn-icon"
            onClick={handleNextPage}
            aria-label="Next page"
          >
            ›
          </button>
          <span className="text-sm text-muted">of {totalPages}</span>
        </div>
      )}
    </div>
  );
}
