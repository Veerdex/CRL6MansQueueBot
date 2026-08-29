"use client";

import { useEffect, useState } from "react";
import HallOfFameSeasonSection from "./HallOfFameSeasonSection";
import type { HallOfFameSeason } from "@/lib/leaderboard/hallOfFame";

const CONFETTI_COLORS = ["#d4af37", "#c0c0c8", "#cd7f32", "#ff8238", "#004ba4"];
const CONFETTI_COUNT = 70;

// Holds the seasonId of the most recently closed season this browser has already been shown the
// popup for. Per-browser rather than per-account: the leaderboard is public and has no login, so
// there is nowhere server-side to record "this visitor has seen it". Consequence — clearing site
// data, a different browser, or a private window all re-show it once.
const LAST_SEEN_SEASON_KEY = "crl6mans:hof-popup-last-season";

// Let the leaderboard paint before the celebration fades in over it, rather than having the modal
// already covering the page on first frame.
const POPUP_APPEAR_DELAY_MS = 400;

interface ConfettiPiece {
  left: number;
  delay: number;
  duration: number;
  color: string;
  width: number;
  height: number;
}

// Deterministic pseudo-random, seeded by index — not Math.random(), so this stays a pure function
// of a fixed-size array and can be computed once at module load. That sidesteps both React's
// render-purity rule (Math.random() during render is impure/non-idempotent) and a server/client
// hydration mismatch (a "use client" component is still rendered once on the server first).
function seeded(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

// Two independent knobs, deliberately separated — conflating them is what made the first pass read
// as a blink. FALL_*_SECONDS is how long a single piece takes to cross the ~120vh keyframe (i.e.
// fall speed); EMIT_SECONDS is how long the burst keeps launching new pieces (i.e. how staggered
// the shower looks). Total effect ≈ EMIT + FALL_MAX.
//
// Fall time is 3x the original 1.2-1.8s (direct request): 120vh of travel in ~1.5s is roughly
// 1000px/sec on a 1080p screen, which registers as a flicker rather than falling confetti. Scale
// both FALL bounds by the same factor to change speed without changing the spread.
const CONFETTI_FALL_MIN_SECONDS = 3.6;
const CONFETTI_FALL_MAX_SECONDS = 5.4;

// Emission window, set to run the whole effect 50% longer (direct request). Total effect is
// EMIT + FALL_MAX, so lengthening emission stretches the shower without touching fall speed:
// 1.2 + 5.4 = 6.6s became 4.5 + 5.4 = 9.9s. Note this trades off against on-screen density —
// spreading the same CONFETTI_COUNT over a longer window means fewer pieces airborne at once,
// so raise the count alongside this if the shower starts looking sparse.
const CONFETTI_EMIT_SECONDS = 4.5;

const CONFETTI: ConfettiPiece[] = Array.from({ length: CONFETTI_COUNT }, (_, i) => {
  // Seeded off i + 1, not i: sin(0) is exactly 0, so every seeded() call for i = 0 returns 0 and
  // that piece is pinned to left: 0% at minimum size with zero delay — a visible artifact stuck to
  // the screen edge on every open.
  const n = i + 1;
  return {
    left: seeded(n * 12.9898) * 100,
    delay: seeded(n * 78.233) * CONFETTI_EMIT_SECONDS,
    duration:
      CONFETTI_FALL_MIN_SECONDS + seeded(n * 37.719) * (CONFETTI_FALL_MAX_SECONDS - CONFETTI_FALL_MIN_SECONDS),
    color: CONFETTI_COLORS[Math.floor(seeded(n * 4.898) * CONFETTI_COLORS.length)],
    width: 6 + seeded(n * 19.19) * 6,
    height: 4 + seeded(n * 91.7) * 6,
  };
});

export default function HallOfFamePopup({
  season,
  mmrScale,
  mmrShift,
}: {
  season: HallOfFameSeason | null;
  mmrScale: number;
  mmrShift: number;
}) {
  // Starts closed so the server renders nothing and the first client paint matches it. localStorage
  // is browser-only, so deciding this during render would either crash on the server or diverge from
  // it — the visibility decision has to happen after mount, in an effect.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!season) return;
    let lastSeen: string | null = null;
    try {
      lastSeen = window.localStorage.getItem(LAST_SEEN_SEASON_KEY);
    } catch {
      // Storage blocked (private mode, site-data restrictions). Degrade to showing the popup —
      // an occasional repeat celebration beats silently never showing it for those visitors.
    }
    if (lastSeen === season.seasonId) return;

    const timer = window.setTimeout(() => setOpen(true), POPUP_APPEAR_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [season]);

  // Recorded on dismiss, not on show. The season is only burned once the visitor has actually seen
  // and closed the celebration — someone who navigates away during POPUP_APPEAR_DELAY_MS, or who
  // leaves before it registers, still gets their turn next visit.
  function dismiss() {
    setOpen(false);
    if (!season) return;
    try {
      window.localStorage.setItem(LAST_SEEN_SEASON_KEY, season.seasonId);
    } catch {
      // Same as the read above — a failed write just means it may show again next visit.
    }
  }

  if (!season || !open) return null;

  return (
    <div
      className="animate-in fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-black/70 backdrop-blur-sm"
      onClick={dismiss}
    >
      <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
        {CONFETTI.map((piece, i) => (
          <span
            key={i}
            className="confetti-piece"
            style={{
              // Rounded to a few decimal places: the browser's CSSOM re-serializes a style
              // attribute's numeric values at lower precision than a raw JS float produces, so a
              // long unrounded string (e.g. "3.5439799996311194%") reads back differently after
              // parsing than what React rendered, causing a spurious hydration mismatch warning
              // even though the underlying seeded value is identical server and client.
              left: `${piece.left.toFixed(2)}%`,
              width: `${piece.width.toFixed(2)}px`,
              height: `${piece.height.toFixed(2)}px`,
              backgroundColor: piece.color,
              animationDelay: `${piece.delay.toFixed(3)}s`,
              animationDuration: `${piece.duration.toFixed(3)}s`,
            }}
          />
        ))}
      </div>

      <div
        className="relative z-10 max-h-[90vh] w-full max-w-2xl overflow-y-auto px-4 py-6"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={dismiss}
          className="btn-icon absolute top-0 right-2 z-10 bg-surface-2/80"
          aria-label="Close"
        >
          ✕
        </button>
        <p className="mb-3 text-center text-sm font-semibold tracking-wide text-gold uppercase">Season Complete!</p>
        <HallOfFameSeasonSection season={season} mmrScale={mmrScale} mmrShift={mmrShift} />
      </div>
    </div>
  );
}
