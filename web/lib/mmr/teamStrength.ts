// Team strength formula (replaces plain MMR average — decided this session, see CLAUDE.md
// "MMR / Elo"). Weights the top two of a 3-player team's ratings via a generalized power mean,
// blended with a small contribution from the weakest player, so a strong duo carrying a weak
// third player rates higher than a flat average would.
//
// MMR has no floor and can go negative (see CLAUDE.md "MMR / Elo"), but this formula's
// exponentiation is undefined for negative bases. Ratings are transformed onto a positive scale
// first (fixed scale/shift, distinct from the leaderboard's admin-configurable display-only
// mmr_scale/mmr_shift — those never feed into internal comparisons, see the hysteresis_mmr note)
// and clamped at 0 as a backstop for any value still negative after the shift. The result is
// shifted and downscaled back to raw MMR units before returning — this keeps the output on the
// same numeric range as a plain MMR average (rather than the much wider scaled/shifted range),
// so callers that feed it into the Elo expected-score formula (R_B - R_A) / S don't need S/K
// retuned: a uniform (no-spread) team round-trips back to exactly its original average.

const TOP_TWO_EXPONENT = 0.785699;
const WEAKEST_WEIGHT = 0.036555;
const STRENGTH_MMR_SCALE = 5;
const STRENGTH_MMR_SHIFT = 1600;

export function calculateTeamStrength(playerRatings: number[]): number {
  const [strongest, second, weakest] = playerRatings
    .map((mmr) => Math.max(0, mmr * STRENGTH_MMR_SCALE + STRENGTH_MMR_SHIFT))
    .sort((a, b) => b - a);

  const topTwoCore = ((strongest ** TOP_TWO_EXPONENT + second ** TOP_TWO_EXPONENT) / 2) ** (1 / TOP_TWO_EXPONENT);
  const strength = (1 - WEAKEST_WEIGHT) * topTwoCore + WEAKEST_WEIGHT * weakest;

  return (strength - STRENGTH_MMR_SHIFT) / STRENGTH_MMR_SCALE;
}
