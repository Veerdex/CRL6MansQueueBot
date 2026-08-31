"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import HistoryPlayerFilter from "./HistoryPlayerFilter";
import MatchHistoryCard from "./MatchHistoryCard";
import { playTap } from "@/lib/sound";
import type { MatchHistoryEntry } from "@/lib/leaderboard/history";

const PAGE_SIZE = 12;

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
  // Draft string + ref mirror LeaderboardTable's pager and the season picker: the field holds
  // whatever is being typed until it's committed, and the ref is only for the invalid-entry flash.
  const [pageInputDraft, setPageInputDraft] = useState("1");
  const pageInputRef = useRef<HTMLInputElement>(null);
  // Set only by the pager's own controls, so a page reset caused by changing the player filter
  // doesn't yank the viewport to the bottom of a board the reader just re-filtered.
  const pagerMovedRef = useRef(false);

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
    setPageInputDraft("1");
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);
  const pageMatches = filtered.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);

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

  // Same reasoning as LeaderboardTable's pager scroll: the last page is almost always short, so
  // leaving it grows the card grid underneath the pager and pushes it off the bottom of the
  // screen — you click "previous" and the control you were using walks away from the pointer.
  // Snap to the end of the document, where the pager lives, so it lands back under the pointer.
  // Instant rather than smooth, because a smooth scroll is still animating when an impatient
  // second click arrives and would re-target from a moving position. A step between two
  // equal-length pages leaves the document the same height, so this is a no-op there.
  useEffect(() => {
    if (!pagerMovedRef.current) return;
    pagerMovedRef.current = false;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
  }, [clampedPage]);

  return (
    <div className="space-y-4">
      <HistoryPlayerFilter players={players} selectedPlayerId={selectedPlayerId} onSelect={selectPlayer} />

      {pageMatches.length === 0 ? (
        <div className="rounded-xl border border-border py-10 text-center text-sm text-muted">
          No reported matches{selectedPlayerId ? " for this player" : ""} yet.
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(480px,1fr))] gap-4">
          {pageMatches.map((match) => (
            <MatchHistoryCard key={match.seriesId} match={match} mmrScale={mmrScale} mmrShift={mmrShift} />
          ))}
        </div>
      )}

      {/* Same control shape as the leaderboard's pager and the season picker — arrows either side
          of a type-in field — so every pager on the site reads as one family. */}
      {filtered.length > 0 && totalPages > 1 && (
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
            aria-label="Match history page"
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
