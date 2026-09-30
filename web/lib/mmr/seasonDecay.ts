// Pure season-close MMR soft-reset formula — see CLAUDE.md, "Seasons". Split out of
// seasonClose.ts (which stays "server-only"-guarded) into its own dependency-free module so it
// can be imported from contexts that can't carry the "server-only" marker package — notably
// web/scripts/backfill-mmr-before.ts, a plain tsx script (no Next.js "react-server" resolution
// condition to make the server-only guard a no-op the way Next/Vitest do). seasonClose.ts
// re-exports both functions so its own existing import sites/tests are unaffected.
//
// CURRENTLY DISABLED — see SYMMETRIC_NEGATIVE_DECAY below. The live behavior is the older
// `mmr / 2` halving for below-zero players; everything the next paragraph describes applies only
// to the mmr >= 0 half until that constant is flipped to true. The symmetric form is kept here,
// implemented and tested, rather than deleted, so re-enabling it is a one-line change.
//
// One continuous formula across the whole domain:
//   new = (mmr * median) / (median + decay_factor * |mmr|)
// A hyperbolic (Michaelis-Menten style) compression toward 0, scaled by the pool median. Writing
// the denominator's mmr term as |mmr| makes the function odd — g(-x) === -g(x) — so a player 30
// below zero is pulled toward zero by exactly as much as a player 30 above it. Previously the
// below-zero half was a separate `mmr / 2` hack that ignored both the median and decay_factor;
// that left a slope discontinuity at 0 (0.5 on the left, 1.0 on the right), so a player a hair
// below zero moved proportionally twice as far as one a hair above. decay_factor would then be the
// single lever on both halves of the pool.
//
// Why it is off: the symmetric form pulls below-zero players back toward 0 *more slowly* than
// `mmr / 2` does (on the live pool, noah -53.47 decays to -35.53 rather than -26.74), which runs
// against commit 814ee7c ("Halve negative MMR at season close instead of thirding it") — a
// deliberate decision to speed up recovery for the bottom of the ladder. Turning the halving back
// on preserves that; the trade-off given up is decay_factor acting as one lever across both halves.
//
// Properties this relies on, for median > 0 (see computeSafeMedian below for how that's assured):
//   - Strictly increasing everywhere: on x >= 0, d/dx[xM/(M+fx)] = M^2/(M+fx)^2 > 0, and the odd
//     extension inherits that, so the reset never reorders players by MMR. This holds under the
//     shipped halving too, by a two-piece argument instead of an odd one: mmr/2 is strictly
//     increasing on x < 0, the hyperbolic half is strictly increasing on x >= 0, and both
//     approach 0 at 0, so the combined function is strictly increasing across the whole domain.
//   - Sign-preserving and never crossing 0: the denominator M + f*|mmr| is always positive, so
//     the result carries mmr's own sign and decayMmr(0, ...) is exactly 0 (a never-played player
//     stays at 0).
//   - Bounded by ±median/decay_factor, which is what compresses a runaway top (or bottom) far
//     harder than the middle of the pool.

// Flip to true to make the decay symmetric about 0 (the formula documented above). While false,
// below-zero players keep the `mmr / 2` halving from commit 814ee7c. Deliberately a module
// constant rather than a config key: this is a code-level toggle over which formula is correct,
// not runtime behavior an admin should tune, and routing it through the config table would need a
// migration to be hand-applied before it could take effect.
const SYMMETRIC_NEGATIVE_DECAY = false;

// Roster-aware wrapper over decayMmr: the rule the season close actually applies to a player.
//
// An unplaced player below 0 is left EXACTLY as they are, rather than halved toward it. The
// halving is a recovery mechanic for the bottom of the ladder (commit 814ee7c), but for a player
// who never placed it was a pure reward for absence: their MMR moved toward 0 every close, so
// sitting out a season was strictly better than playing, and a player could ride repeated closes
// back up to par having never queued. On the live pool at the time this was written, 21 unplaced
// players sat below 0 and would have been handed 64.8 raw MMR (~469 display points) between them
// for doing nothing, the worst single case being +80 display — more than a supercharged BO7 win.
//
// Scoped to unplaced deliberately. A *placed* player below 0 still halves: they completed a real
// placement run, and compressing the ladder toward the middle is what the soft reset is for. This
// is a user decision, not a derivation — the same absence argument does technically apply to them.
//
// isPlaced is read at decay time, which seasonClose.ts runs BEFORE
// resetAllPlacementsToUnranked() wipes is_placed/rank_games_played across the whole roster, so it
// means "placed during the season being closed" rather than "placed right now" (right now, just
// after a close, is nobody). The exemption is therefore per-season and escapable: a frozen player
// who plays their placement games next season is placed at the following close and decays
// normally.
//
// Deliberately NOT folded into decayMmr itself. That function stays a pure function of
// (mmr, median, decayFactor) because reconstructMmrHistory.ts imports it for the live history
// replay behind recomputeTruePeakMmr (/correct, /admin correct-report), and that replay's `placed`
// set is never cleared at a season boundary — it models "ever placed", not per-season placement,
// so it cannot express this rule correctly without also modelling the placement reset. Leaving the
// replay on the plain formula keeps it exactly as accurate as it was: it is already documented
// best-effort, snaps to season_history checkpoints at every boundary, and its only consumer (peak
// MMR) clamps at Math.max(current, 0) for placed players only, so a below-zero divergence cannot
// move a peak.
//
// Note this breaks decayMmr's "never reorders players" property *across* the placed/unplaced
// split — an exempt unplaced player at -30 stays put while a placed player at -40 halves to -20
// and passes them. That is intended and harmless: ordering only matters for the leaderboard and
// band cutoffs, both of which exclude unplaced players, and every placement is cleared moments
// later anyway. Within either group the ordering guarantee still holds.
export function decayPlayerMmr(mmr: number, isPlaced: boolean, median: number, decayFactor: number): number {
  if (!isPlaced && mmr < 0) return mmr;
  return decayMmr(mmr, median, decayFactor);
}

export function decayMmr(mmr: number, median: number, decayFactor: number): number {
  // A non-positive median would make this meaningless or undefined — at median === 0 every player
  // collapses to 0 (and 0/0 = NaN for a player already at 0), which would silently wipe the pool.
  // computeSafeMedian can still return 0 for a degenerate pool where at least half the players tie
  // at the minimum (e.g. [0, 0, 10]), so leave those ratings untouched rather than destroy them.
  if (median <= 0) return mmr;
  // Guarded above, not inside this branch, on purpose: the degenerate-median case is a real bug in
  // the halving path too (mmr / 2 is fine, but the mmr >= 0 half still hits 0/0 = NaN at mmr 0).
  if (!SYMMETRIC_NEGATIVE_DECAY && mmr < 0) return mmr / 2;
  // mmr === 0 needs no special case: (0 * median) / (median + 0) is exactly 0.
  return (mmr * median) / (median + decayFactor * Math.abs(mmr));
}

// A plain median of the placed pool's raw mmr can go negative — a live example: with
// mmr_scale/mmr_shift chosen so display MMR looks like a normal positive range, more than half
// the placed pool can still sit below raw MMR 0 (display MMR only looks healthy because of the
// shift). A negative median breaks decayMmr above: its denominator (median + decay_factor*|mmr|)
// crosses zero at |mmr| = -median/decay_factor, and any player whose mmr sits near that value gets
// a wildly amplified or sign-flipped result — including players reordering past others who started
// below them, which is exactly the invariant that formula is supposed to guarantee.
//
// Fix: shift every value up by the pool's own minimum (so the lowest player sits at exactly 0)
// before taking the median, guaranteeing a non-negative scaling constant. The shift is used only
// to derive this one constant — decayMmr still runs on each player's real, unshifted mmr, so a
// below-zero player is compressed by their true distance from 0, not a shifted stand-in. For a pool
// that's already all non-negative, the shift is 0 and this is identical to a plain median — no
// behavior change for a community that was never hitting the bug.
export function computeSafeMedian(mmrs: number[]): number {
  const shift = Math.max(0, -Math.min(...mmrs));
  const shifted = mmrs.map((m) => m + shift).sort((a, b) => a - b);
  const mid = Math.floor(shifted.length / 2);
  return shifted.length % 2 === 0 ? (shifted[mid - 1] + shifted[mid]) / 2 : shifted[mid];
}
