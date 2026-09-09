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
  // Consecutive Rank Queue wins *before* this series — see streaks.ts's getPriorRankWinStreak,
  // which excludes the series being scored so it can't count itself. Feeds
  // computeStreakMultiplier below for a winner and is ignored entirely for a loser. Optional,
  // defaulting to 0 (no streak) when omitted, so callers that don't model streaks are unaffected.
  priorRankWinStreak?: number;
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
  // Divides sScale for the expected-score used in this module's own delta math (and, via
  // EloResult.expected, the win-streak bonus taper) — but never touches the website's History
  // page or /chances, since those recompute their own win-odds independently, live off the
  // current s_scale config, with no knowledge of this multiplier. That's the whole point of a
  // separate knob: tune how confident the Elo math itself is without retroactively shifting what
  // any past or future match's odds display shows. Optional, defaulting to a no-op 1x when
  // omitted; its live default (1) lives in config.ts's KNOWN_CONFIG_DEFAULTS as
  // mmr_confidence_multiplier, matching kFactor/sScale's pattern.
  confidenceMultiplier?: number;
  // Multiplies the fully-formed delta — after skew dampening and minDeltaFloor, not before —
  // see CLAUDE.md, "Team formation" for BO3/5/7's 0.6x/1.0x/1.4x. Deliberately NOT folded into
  // kFactor like bonus_day_multiplier: kFactor scaling only grows the "earned" score-expected
  // term, which minDeltaFloor's flat add-on can dwarf on a near-certain result (a heavy BO7
  // favorite winning as expected landed only a couple points ahead of the same BO3 win, since the
  // scaled term was tiny and the flat floor dominated both). Applying the length multiplier last
  // instead scales the whole delta, floor included, so BO7 stays proportionally bigger than BO3
  // regardless of how lopsided the win was. Optional, defaulting to a no-op 1x when omitted.
  seriesLengthMultiplier?: number;
  // Ceiling for the win-streak multiplier applied to a winner's earned Elo term — 1.5 means a
  // maxed streak in an even matchup earns 1.5x that term. Deliberately scales ONLY that term and
  // not minDeltaFloor's flat add-on: the floor is the guaranteed participation payout, and form
  // shouldn't compound with it. It also lands INSIDE seriesLengthMultiplier rather than after it,
  // which is where the flat +bonus this replaced used to sit — that placement made an identical
  // streak worth 125% of a BO3's delta but only 54% of a BO7's, since the bonus was a fixed
  // number of points divided by a base the series length had already scaled. As a multiplier on
  // the term itself, a streak is now worth the same percentage at every series length. Optional,
  // defaulting to a no-op 1x when omitted; its live default (1.5) lives in config.ts's
  // KNOWN_CONFIG_DEFAULTS as streak_bonus_max_multiplier.
  streakMaxMultiplier?: number;
};

export type EloResult = {
  playerId: string;
  delta: number;
  newMmr: number;
  wasProvisional: boolean;
  // This player's team's pre-game win probability as actually used for their delta above,
  // computed at config.sScale / confidenceMultiplier — also the input to
  // computeStreakMultiplier's taper. Deliberately decoupled from the website's independently-computed History
  // page / /chances odds (see confidenceMultiplier on EloConfig).
  expected: number;
  // The win-streak multiplier actually applied to this player's Elo term above — 1 for every
  // loser, for a winner on their first or second win of a run, and whenever the feature is off.
  // Surfaced for reporting and audit only: unlike the flat bonus it replaced, callers do not need
  // it to assemble the delta, which already includes it.
  streakMultiplier: number;
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
  // See EloConfig.confidenceMultiplier: divides sScale for this expected-score calculation only
  // — the website's own win-odds displays compute their own, independent of this config.
  const effectiveSScale = config.sScale / (config.confidenceMultiplier ?? 1);
  const expectedA = 1 / (1 + 10 ** ((avgB - avgA) / effectiveSScale));
  const expectedByTeam: Record<Team, number> = { A: expectedA, B: 1 - expectedA };

  const streakMaxMultiplier = config.streakMaxMultiplier ?? 1;
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
    // Winners only. A loser's streak is 0 by definition the moment this series settles, and
    // applying a >1 multiplier to their negative delta would turn a reward into a punishment.
    const streakMultiplier =
      p.team === winner ? computeStreakMultiplier(p.priorRankWinStreak ?? 0, expected, streakMaxMultiplier) : 1;
    // Scales the earned Elo term and nothing else — minDeltaFloor is added further down, outside
    // this deliberately (see EloConfig.streakMaxMultiplier).
    let delta = ((k * (score - expected)) / 3) * streakMultiplier;

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

    // See EloConfig.seriesLengthMultiplier: applied last, over the whole delta (floor included).
    delta *= config.seriesLengthMultiplier ?? 1;

    return { playerId: p.playerId, delta, newMmr: p.mmr + delta, wasProvisional, expected: expectedByTeam[p.team], streakMultiplier };
  });
}

// Win-streak MMR multiplier (see CLAUDE.md, "MMR / Elo" — streak bonus). Pure and kept separate
// from computeEloDeltas's own math because priorStreak comes from report history (DB), which
// elo.ts otherwise never touches — it reaches the calculation as EloPlayerInput.priorRankWinStreak.
//
// Ramps across five tiers. priorStreak is the count *before* the game being scored, so the first
// paying tier at priorStreak 2 is a player's THIRD consecutive win — deliberately one game
// earlier than the flat +1..+5 bonus this replaced, which didn't pay until the fourth. That also
// lines the MMR up with FLAME_THRESHOLD (3), so the 🔥 next to a name and the extra MMR now start
// on the same game instead of a game apart. From there it's one fifth of the way to maxMultiplier
// per further win, hitting the ceiling on the seventh (at the live 1.5 default: 3rd win -> 1.1x,
// 4th -> 1.2x, 5th -> 1.3x, 6th -> 1.4x, 7th+ -> 1.5x).
//
// expected is the winning team's pre-game win probability (possibly confidence-boosted — see
// EloConfig.confidenceMultiplier) and tapers the multiplier back toward 1x as the win looks more
// like a foregone conclusion: full value at expected<=0.5 (a coin flip, or an underdog win),
// falling linearly to no bonus at all as expected approaches 1. A near-certain favorite winning
// exactly as expected earns nothing extra for their streak, however long it has run.
export function computeStreakMultiplier(priorStreak: number, expected: number, maxMultiplier: number): number {
  const tier = Math.min(Math.max(priorStreak - 1, 0), 5);
  const taper = Math.min(Math.max(2 * (1 - expected), 0), 1);
  return 1 + (maxMultiplier - 1) * (tier / 5) * taper;
}
