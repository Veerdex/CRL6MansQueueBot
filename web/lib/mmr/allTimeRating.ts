// All-time rating — the permanent, cross-season career score. Every closed season hands out a
// points pool to that season's placed players by final standing; a player's all-time rating is the
// sum of every per-season score they've ever earned (stored per season on
// `crl6mansqueuebot_season_history.season_score`, never as a running total on the player row, so
// the number is always re-derivable and a re-close or a corrected standing can't leave a
// denormalized counter wrong). Currently written at season close and otherwise dormant — nothing
// on the site or in Discord reads it yet.
//
// Pure and dependency-free (no "server-only", no Supabase) so it stays importable from tsx
// scripts and unit tests, matching seasonDecay.ts — see CLAUDE.md, "MMR calculations should
// remain pure".
//
// The curve, with r = 1-based placement and N = number of placed players that season:
//   b(r,N) = (r - 1) / (N/2 - 1)
//   k(N)   = 16.1045061696 * (38 / (N - 2))^q          (q = 0.25)
//   a(N)   = 100*ln(100) / (k(N) * (N/2 - 1))
//   score  = 100^(1 - b / (a + (1 - a)*b))
//
// Properties that fall out of it, all relied on below:
//   - 1st place always scores exactly 100, at every field size (b = 0 makes the exponent 1).
//   - b = 1 exactly at r = N/2, where the score is exactly 100^0 = 1. That is the last earning
//     place, so the bottom half of the field earns nothing without needing a separate rule — the
//     user's "anybody in the bottom 50% doesn't earn anything ... if the score is below 1 they
//     earn nothing" is one statement, not two.
//   - Past b = 1 the expression is not just small but unusable: its denominator has a pole at
//     b = a/(a-1) (whenever a > 1, i.e. every field below ~N=70), so it is never evaluated there.
//   - Larger fields pay out more in total and reward depth: k(N) shrinks as N grows, flattening
//     the curve so mid-table placements keep real value (N=8 pays 3 players ~202 points total,
//     N=40 pays 19 players ~565).
export const ALL_TIME_RATING_Q = 0.25;
const K_COEFFICIENT = 16.1045061696;
const K_REFERENCE_N = 38;

// Points a single placement is worth. `rank` is 1-based over the placed pool only, `placedCount`
// is the size of that same pool — both must exclude unplaced players (they don't participate in
// the standing at all, so counting them would inflate N and shift the whole curve).
export function allTimeSeasonScore(rank: number, placedCount: number): number {
  // N <= 2 divides by zero twice (N/2 - 1 and N - 2). A one- or two-player "season" has no
  // meaningful standing to reward, so it simply pays nothing rather than getting a special case.
  if (placedCount <= 2) return 0;
  if (!Number.isFinite(rank) || rank < 1 || rank > placedCount) return 0;

  const half = placedCount / 2 - 1;
  const b = (rank - 1) / half;
  if (b > 1) return 0; // bottom half — also keeps the pole below out of reach

  const k = K_COEFFICIENT * Math.pow(K_REFERENCE_N / (placedCount - 2), ALL_TIME_RATING_Q);
  const a = (100 * Math.log(100)) / (k * half);
  const score = Math.pow(100, 1 - b / (a + (1 - a) * b));

  // Belt-and-braces on the user's stated floor: anything that would round in under a point pays
  // nothing. Unreachable for b <= 1 given the properties above, but it makes the rule explicit.
  return score < 1 ? 0 : score;
}

// Scores a whole season's final standing. `standing` must already be in finishing order (the same
// MMR-desc order season_history's `season_rank` uses) and may include unplaced players: they're
// dropped, and the survivors are then *densely* re-ranked 1..N over the placed pool. Skipping the
// re-rank and reusing season_rank would leave gaps wherever an unplaced player finished mid-table,
// which both shifts every score below the gap down the curve and overstates N.
export function seasonScoresByPlayerId(
  standing: { id: string; isPlaced: boolean }[],
): Map<string, number> {
  const placed = standing.filter((p) => p.isPlaced);
  return new Map(placed.map((p, index) => [p.id, allTimeSeasonScore(index + 1, placed.length)]));
}
