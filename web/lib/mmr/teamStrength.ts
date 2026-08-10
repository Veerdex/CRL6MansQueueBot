// Team strength formula (replaces plain MMR average — decided this session, see CLAUDE.md
// "MMR / Elo"). Weights the top two of a 3-player team's ratings via a generalized power mean,
// blended with a small contribution from the weakest player, so a strong duo carrying a weak
// third player rates higher than a flat average would.
//
// MMR has no floor and can go negative (see CLAUDE.md "MMR / Elo"), but this formula's
// exponentiation is undefined for negative bases. Ratings are transformed onto a positive scale
// first (fixed scale/shift, distinct from the leaderboard's admin-configurable display-only
// mmr_scale/mmr_shift — those never feed into internal comparisons, see the hysteresis_mmr note)
// and clamped at 0 as a backstop for any value still negative after the shift.
//
// Revised this session: the blended result is now returned directly in this shifted/scaled
// space, NOT inverted back down to raw-MMR units. This was an explicit user choice — the
// shift/scale is meant as a one-way move into a different predictor's expected numeric range,
// not a round-trip — and it deliberately widens the Elo expected-score gap (E_A/E_B) for a given
// real MMR difference beyond what s_scale=400 alone would produce on raw MMR. s_scale is
// intentionally left at its existing default (400, admin-configurable) rather than retuned to
// compensate, per the user's explicit choice, so ordinary match outcomes now swing K-factor
// closer to its extremes than before this change.

const TOP_TWO_EXPONENT = 0.785699;
const WEAKEST_WEIGHT = 0.036555;
const STRENGTH_MMR_SCALE = 3.5;
const STRENGTH_MMR_SHIFT = 1550;

export function calculateTeamStrength(playerRatings: number[]): number {
  const [strongest, second, weakest] = playerRatings
    .map((mmr) => Math.max(0, mmr * STRENGTH_MMR_SCALE + STRENGTH_MMR_SHIFT))
    .sort((a, b) => b - a);

  const topTwoCore = ((strongest ** TOP_TWO_EXPONENT + second ** TOP_TWO_EXPONENT) / 2) ** (1 / TOP_TWO_EXPONENT);
  return (1 - WEAKEST_WEIGHT) * topTwoCore + WEAKEST_WEIGHT * weakest;
}
