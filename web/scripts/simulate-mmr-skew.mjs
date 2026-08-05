// Tests a proposed skew mechanic — Attempt 3, a different architecture from Attempts 1/2 below.
//
// Attempt 1 (uniformly scaling every win or every loss by a fixed multiplier) failed: mean and
// median moved together and skewness stayed ~0. Summing ~100 near-i.i.d. per-player increments
// smooths out shape asymmetry from a uniform rescale (CLT) — it just shifts the mean, doesn't
// create real distributional skew.
//
// Attempt 2 (only amplifying deltas above a fixed "large/upset" threshold) failed even harder:
// literally identical output across every tested factor, because balanced matchmaking keeps
// non-provisional deltas clustered tightly around ~5.33 (the value for a perfectly even game) —
// the threshold never fired at all.
//
// Attempt 3 (this one) is keyed off each player's CURRENT mmr, not the outcome of any one game.
// A player who is already deep on the side that's supposed to stay thin gets any move that would
// push them FURTHER out on that side shrunk — smaller the deeper they already are — while moves
// that pull them back toward 0, and all moves on the other side, are untouched (full-strength,
// standard Elo). This is meant to act like a soft wall: easy to approach the center, increasingly
// resistant the further out you already are on the designated side. Concretely:
//
//   multiplier(currentMmr) = exp(-currentMmr^2 / (2 * sigmaDampened^2))   [only when the game's
//                                                                          raw delta pushes the
//                                                                          player further into
//                                                                          their already-extreme
//                                                                          side]
//   multiplier = 1 otherwise (center-ward moves, or any move on the non-dampened side)
//
// sigmaDampened shrinks as |skewFactor| grows, making the wall stiffer. skewFactor = 0 is
// special-cased to be the exact standard-Elo baseline (no dampening at all), not just a
// very-wide-sigma approximation of it.
//
// Sign convention (arbitrary, stated explicitly since the two skew-direction descriptions given
// in conversation don't agree on which label goes with which behavior): skewFactor > 0 dampens
// the NEGATIVE side (harder to sink further below 0); skewFactor < 0 dampens the POSITIVE side.
// This script measures the actual resulting mean/median/per-side spread and count empirically
// rather than assuming which classical "left skew" / "right skew" label applies — report in
// plain terms (which side ended up wider/narrower, more/less populated) so the mapping to
// whichever convention is intended can be checked directly against the numbers.
//
// Run with: node scripts/simulate-mmr-skew.mjs

const SEED = 42;
const NUM_PLAYERS = 996;
const ROUNDS = 100;
const PLAYERS_PER_LOBBY = 6;
const LOBBIES_PER_ROUND = NUM_PLAYERS / PLAYERS_PER_LOBBY;

const CONFIG = {
  kFactor: 32,
  sScale: 400,
  provisionalGames: 10,
  provisionalKMultiplier: 1.75,
};

// Reference spread scale for the dampening curve, chosen from the established ~58 unskewed
// 100-round stdev. A production version would recompute this from live population stats (e.g.
// current stdev, or min/max) on the same cadence bands.ts already recomputes percentiles daily,
// rather than a hardcoded constant.
const BASE_SIGMA = 50;

const SKEW_FACTORS_TO_TEST = [0, 0.3, 0.6, 0.9, -0.3, -0.6, -0.9];

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(array, rng) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function teamAverage(players, team) {
  const members = players.filter((p) => p.team === team);
  return members.reduce((sum, p) => sum + p.mmr, 0) / members.length;
}

function computeEloDeltasWithDensitySkew(players, winner, config, skewFactor) {
  const avgA = teamAverage(players, "A");
  const avgB = teamAverage(players, "B");
  const expectedA = 1 / (1 + Math.pow(10, (avgB - avgA) / config.sScale));
  const expectedByTeam = { A: expectedA, B: 1 - expectedA };

  // -1 = negative side is dampened, +1 = positive side is dampened, 0 = no dampening at all.
  const dampenedSide = skewFactor > 0 ? -1 : skewFactor < 0 ? 1 : 0;
  const sigmaDampened = BASE_SIGMA * (1 - Math.min(Math.abs(skewFactor), 0.9));

  return players.map((p) => {
    const score = p.team === winner ? 1 : 0;
    const expected = expectedByTeam[p.team];
    const wasProvisional = p.priorRankGamesPlayed < config.provisionalGames;
    const k = wasProvisional ? config.kFactor * config.provisionalKMultiplier : config.kFactor;
    let delta = (k * (score - expected)) / 3;

    if (dampenedSide !== 0) {
      const currentMmr = p.mmr;
      const onDampenedSide = Math.sign(currentMmr) === dampenedSide;
      const pushesFurtherOut = Math.sign(delta) === dampenedSide;
      if (onDampenedSide && pushesFurtherOut) {
        const multiplier = Math.exp(-(currentMmr * currentMmr) / (2 * sigmaDampened * sigmaDampened));
        delta *= multiplier;
      }
    }

    return { playerId: p.playerId, delta, newMmr: p.mmr + delta, wasProvisional };
  });
}

function bestBalancedSplit(members) {
  let best = null;
  const seenSplits = new Set();
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      for (let k = j + 1; k < members.length; k++) {
        const teamA = [members[i], members[j], members[k]];
        const teamAIds = new Set(teamA.map((p) => p.id));
        const teamB = members.filter((m) => !teamAIds.has(m.id));
        const splitKey = [teamA, teamB]
          .map((team) => team.map((p) => p.id).sort().join(","))
          .sort()
          .join("|");
        if (seenSplits.has(splitKey)) continue;
        seenSplits.add(splitKey);
        const avgA = teamA.reduce((sum, p) => sum + p.mmr, 0) / 3;
        const avgB = teamB.reduce((sum, p) => sum + p.mmr, 0) / 3;
        const diff = Math.abs(avgA - avgB);
        if (!best || diff < best.diff) best = { teamA, teamB, diff };
      }
    }
  }
  return { teamA: best.teamA, teamB: best.teamB };
}

function mean(arr) {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}
function stdev(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}
function skewness(arr) {
  const m = mean(arr);
  const s = stdev(arr);
  const n = arr.length;
  const m3 = arr.reduce((sum, x) => sum + (x - m) ** 3, 0) / n;
  return m3 / s ** 3;
}
function percentile(sortedArr, p) {
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}
function pearsonR(xs, ys) {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0,
    dx2 = 0,
    dy2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  return num / Math.sqrt(dx2 * dy2);
}

function runSimulation(skewFactor) {
  const rng = mulberry32(SEED);
  const players = [];
  for (let i = 0; i < NUM_PLAYERS; i++) {
    players.push({ id: `p${i}`, skill: 25 + rng() * 75, mmr: 0, rankGamesPlayed: 0, wins: 0, losses: 0 });
  }

  for (let round = 1; round <= ROUNDS; round++) {
    const shuffled = shuffle(players, rng);
    for (let lobby = 0; lobby < LOBBIES_PER_ROUND; lobby++) {
      const members = shuffled.slice(lobby * PLAYERS_PER_LOBBY, (lobby + 1) * PLAYERS_PER_LOBBY);
      const { teamA, teamB } = bestBalancedSplit(members);

      const avgSkillA = mean(teamA.map((p) => p.skill));
      const avgSkillB = mean(teamB.map((p) => p.skill));
      const pTeamAWins = avgSkillA / (avgSkillA + avgSkillB);
      const winner = rng() < pTeamAWins ? "A" : "B";

      const eloInputs = [
        ...teamA.map((p) => ({ playerId: p.id, mmr: p.mmr, team: "A", priorRankGamesPlayed: p.rankGamesPlayed })),
        ...teamB.map((p) => ({ playerId: p.id, mmr: p.mmr, team: "B", priorRankGamesPlayed: p.rankGamesPlayed })),
      ];

      const results = computeEloDeltasWithDensitySkew(eloInputs, winner, CONFIG, skewFactor);
      const resultsById = new Map(results.map((r) => [r.playerId, r]));

      for (const p of members) {
        const r = resultsById.get(p.id);
        p.mmr = r.newMmr;
        p.rankGamesPlayed++;
        const onWinningTeam = (winner === "A" ? teamA : teamB).some((x) => x.id === p.id);
        if (onWinningTeam) p.wins++;
        else p.losses++;
      }
    }
  }

  const finalMmrs = players.map((p) => p.mmr).sort((a, b) => a - b);
  const skillsUnsorted = players.map((p) => p.skill);
  const mmrsUnsorted = players.map((p) => p.mmr);

  const negSide = mmrsUnsorted.filter((x) => x < 0);
  const posSide = mmrsUnsorted.filter((x) => x > 0);

  return {
    skewFactor,
    mean: mean(mmrsUnsorted),
    median: percentile(finalMmrs, 50),
    stdev: stdev(mmrsUnsorted),
    skewness: skewness(mmrsUnsorted),
    correlation: pearsonR(skillsUnsorted, mmrsUnsorted),
    min: finalMmrs[0],
    max: finalMmrs[finalMmrs.length - 1],
    p10: percentile(finalMmrs, 10),
    p90: percentile(finalMmrs, 90),
    negCount: negSide.length,
    posCount: posSide.length,
    negStdev: negSide.length ? stdev(negSide) : 0,
    posStdev: posSide.length ? stdev(posSide) : 0,
  };
}

console.log("=".repeat(120));
console.log(`SIMULATION: ${NUM_PLAYERS} players, ${ROUNDS} rounds — testing density-based skew (Attempt 3)`);
console.log("=".repeat(120));

const allResults = SKEW_FACTORS_TO_TEST.map(runSimulation);

console.log("\n--- Summary by skew_factor ---");
console.log(
  `${"factor".padEnd(7)} | ${"mean".padEnd(8)} | ${"median".padEnd(8)} | ${"stdev".padEnd(7)} | ${"skewness".padEnd(9)} | ${"corr".padEnd(7)} | ${"min".padEnd(8)} | ${"max".padEnd(8)}`
);
for (const r of allResults) {
  console.log(
    `${String(r.skewFactor).padEnd(7)} | ${r.mean.toFixed(2).padEnd(8)} | ${r.median.toFixed(2).padEnd(8)} | ${r.stdev.toFixed(2).padEnd(7)} | ${r.skewness.toFixed(4).padEnd(9)} | ${r.correlation.toFixed(3).padEnd(7)} | ${r.min.toFixed(1).padEnd(8)} | ${r.max.toFixed(1).padEnd(8)}`
  );
}

console.log("\n--- Per-side density check (count and spread on each side of 0) ---");
console.log(`${"factor".padEnd(7)} | ${"neg count".padEnd(10)} | ${"pos count".padEnd(10)} | ${"neg stdev".padEnd(10)} | ${"pos stdev".padEnd(10)}`);
for (const r of allResults) {
  console.log(
    `${String(r.skewFactor).padEnd(7)} | ${String(r.negCount).padEnd(10)} | ${String(r.posCount).padEnd(10)} | ${r.negStdev.toFixed(2).padEnd(10)} | ${r.posStdev.toFixed(2).padEnd(10)}`
  );
}

console.log("\n--- p10/p90 spread (tail check) ---");
for (const r of allResults) {
  console.log(`factor=${r.skewFactor}: p10=${r.p10.toFixed(1)}, p90=${r.p90.toFixed(1)}`);
}
