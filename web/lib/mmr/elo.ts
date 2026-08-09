import type { Team } from "@/lib/supabase/types";
import { calculateTeamStrength } from "./teamStrength";

// Pure Elo engine — no Discord, no DB. See CLAUDE.md, "MMR / Elo": standard Elo, single
// rating per player, team rating = calculateTeamStrength() of the 3 teammates' MMR (weighted
// power mean of the top two, blended with the weakest — see teamStrength.ts), points split
// evenly across the team. Provisional K is applied per player (not blended into one team K)
// since each player's own provisional status is what the spec's "elevated K for a player's
// first N Rank Queue games" describes — teammates with different provisional status
// legitimately gain/lose different amounts on the same result.

export type EloPlayerInput = {
  playerId: string;
  mmr: number;
  team: Team;
  priorRankGamesPlayed: number;
};

export type EloConfig = {
  kFactor: number;
  sScale: number;
  provisionalGames: number;
  provisionalKMultiplier: number;
  // Both optional, defaulting to a no-op (0) when omitted — deltas are computed as plain
  // baseline Elo unless a caller opts in. Non-zero defaults (skewFactor=0.5, minDeltaFloor=2)
  // live in config.ts's KNOWN_CONFIG_DEFAULTS, not here, matching how kFactor/sScale's defaults
  // are supplied by call sites rather than baked into this type.
  skewFactor?: number;
  minDeltaFloor?: number;
};

export type EloResult = {
  playerId: string;
  delta: number;
  newMmr: number;
  wasProvisional: boolean;
};

function teamAverage(players: EloPlayerInput[], team: Team): number {
  const members = players.filter((p) => p.team === team);
  return calculateTeamStrength(members.map((p) => p.mmr));
}

// Reference spread scale for the skew dampening curve below — not admin-configurable, mirrors
// the constant used throughout the scratch simulations in web/scripts/simulate-mmr-*.mjs.
const SKEW_BASE_SIGMA = 50;

export function computeEloDeltas(players: EloPlayerInput[], winner: Team, config: EloConfig): EloResult[] {
  const avgA = teamAverage(players, "A");
  const avgB = teamAverage(players, "B");
  const expectedA = 1 / (1 + 10 ** ((avgB - avgA) / config.sScale));
  const expectedByTeam: Record<Team, number> = { A: expectedA, B: 1 - expectedA };

  const skewFactor = config.skewFactor ?? 0;
  const minDeltaFloor = config.minDeltaFloor ?? 0;
  // Which side of 0 gets its outward-pushing deltas dampened: positive skewFactor dampens the
  // negative side (helps players climb out of the hole), negative skewFactor mirrors it onto
  // the positive side. See CLAUDE.md-adjacent design notes: the dampening only ever shrinks the
  // delta direction that would push a player further into their already-dampened side — a win
  // that pulls them back toward 0 is never touched, so this can't trap a player at a low rank.
  const dampenedSide = skewFactor > 0 ? -1 : skewFactor < 0 ? 1 : 0;
  const sigmaDampened = SKEW_BASE_SIGMA * (1 - Math.min(Math.abs(skewFactor), 0.9));

  return players.map((p) => {
    const score = p.team === winner ? 1 : 0;
    const expected = expectedByTeam[p.team];
    const wasProvisional = p.priorRankGamesPlayed < config.provisionalGames;
    const k = wasProvisional ? config.kFactor * config.provisionalKMultiplier : config.kFactor;
    let delta = (k * (score - expected)) / 3;

    if (dampenedSide !== 0) {
      // The dampening curve is centered on the midpoint between the player's current MMR and
      // where this game's raw (pre-dampening) delta would land them — not current MMR alone.
      // A player sitting just above the dampened-side boundary who's about to be pushed across
      // it would otherwise get zero protection (their pre-game sign doesn't match the dampened
      // side yet, even though the outcome does); averaging in the outcome catches that case
      // instead of only reacting a game late.
      const midpointMmr = p.mmr + delta / 2;
      const onDampenedSide = Math.sign(midpointMmr) === dampenedSide;
      const pushesFurtherOut = Math.sign(delta) === dampenedSide;
      if (onDampenedSide && pushesFurtherOut) {
        const multiplier = Math.exp(-(midpointMmr * midpointMmr) / (2 * sigmaDampened * sigmaDampened));
        delta *= multiplier;
      }
    }

    // Applied last: pushes every nonzero delta further from 0 by a fixed floor amount, in
    // whichever direction it was already headed. Not a clamp on tiny deltas only — it's added
    // unconditionally, so it also inflates already-large deltas by the same fixed amount.
    if (minDeltaFloor > 0 && delta !== 0) {
      delta += Math.sign(delta) * minDeltaFloor;
    }

    return { playerId: p.playerId, delta, newMmr: p.mmr + delta, wasProvisional };
  });
}

// Win-streak MMR bonus (see CLAUDE.md, "MMR / Elo" — streak bonus). Pure and separate from
// computeEloDeltas since it needs a player's prior Rank Queue win-streak length, which lives
// in report history (DB), not anything elo.ts otherwise touches. priorStreak is the player's
// consecutive-win count *before* the game currently being scored — 0 below a 3-game streak,
// then +1 per game up to a +5 cap (priorStreak=3 -> +1, 4 -> +2, 5 -> +3, 6 -> +4, 7+ -> +5).
export function computeStreakBonus(priorStreak: number): number {
  return Math.min(Math.max(priorStreak - 2, 0), 5);
}
