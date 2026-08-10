// Pure season-close MMR soft-reset formula — see CLAUDE.md, "Seasons". Split out of
// seasonClose.ts (which stays "server-only"-guarded) into its own dependency-free module so it
// can be imported from contexts that can't carry the "server-only" marker package — notably
// web/scripts/backfill-mmr-before.ts, a plain tsx script (no Next.js "react-server" resolution
// condition to make the server-only guard a no-op the way Next/Vitest do). seasonClose.ts
// re-exports both functions so its own existing import sites/tests are unaffected.
//
// Two-piece formula, continuous at mmr = 0 (both pieces equal 0 there, so no jump):
//   mmr >= 0: new = (mmr * median) / (median + decay_factor * mmr)
//     A hyperbolic (Michaelis-Menten style) decay toward 0, scaled by the pool median. Strictly
//     increasing in mmr and safe from crossing 0 or reordering players *only when median > 0* —
//     see computeSafeMedian below for why the median fed into this can't be trusted as-is.
//   mmr < 0: new = mmr / 3
//     Negative MMR (no floor during normal play — see CLAUDE.md, "MMR / Elo") recovers toward
//     0 at a fixed 3x-closer rate each season, independent of the median.
// Both pieces are strictly increasing in `mmr` and agree at the boundary, so the combined
// function is strictly increasing across the whole domain — it never reorders players by MMR.

export function decayMmr(mmr: number, median: number, decayFactor: number): number {
  if (mmr < 0) return mmr / 3;
  if (mmr === 0) return 0;
  return (mmr * median) / (median + decayFactor * mmr);
}

// A plain median of the placed pool's raw mmr can go negative — a live example: with
// mmr_scale/mmr_shift chosen so display MMR looks like a normal positive range, more than half
// the placed pool can still sit below raw MMR 0 (display MMR only looks healthy because of the
// shift). When that happens the mmr>=0 branch above stops being safe: its denominator
// (median + decay_factor*mmr) crosses zero at mmr = -median/decay_factor, and any player whose
// mmr sits near that value gets a wildly amplified or sign-flipped result — including players
// reordering past others who started below them, which is exactly the invariant this formula
// is supposed to guarantee.
//
// Fix: shift every value up by the pool's own minimum (so the lowest player sits at exactly 0)
// before taking the median, guaranteeing a non-negative scaling constant. The shift is used only
// to derive this one constant — decayMmr still runs on each player's real, unshifted mmr, so the
// mmr<0 branch's "/3, recovers toward 0" behavior is completely unaffected by this. For a pool
// that's already all non-negative, the shift is 0 and this is identical to a plain median — no
// behavior change for a community that was never hitting the bug.
export function computeSafeMedian(mmrs: number[]): number {
  const shift = Math.max(0, -Math.min(...mmrs));
  const shifted = mmrs.map((m) => m + shift).sort((a, b) => a - b);
  const mid = Math.floor(shifted.length / 2);
  return shifted.length % 2 === 0 ? (shifted[mid - 1] + shifted[mid]) / 2 : shifted[mid];
}
