// Tests a proposed MMR-creation/destruction mechanic on top of standard Elo: a new config
// value (`mmr_creation_factor`, default 0) that breaks the normal zero-sum transfer between
// teams based on how big an upset the result was.
//
// Mechanic (revised per user: a 50/50 game must yield ZERO creation regardless of who wins —
// creation should only respond to genuine upsets, not to how a coin-flip landed):
//   upsetMagnitude = expected(winner) >= 0.5 ? 0 : (0.5 - expected(winner)) * 2
//     // 0 whenever the winner was favored OR the game was an exact coin flip (expected == 0.5).
//     // Scales up to 1 as the winner's pre-game win probability approaches 0 (a huge upset).
//   extra    = mmr_creation_factor * upsetMagnitude       // can be + or -, and is exactly 0
//              whenever upsetMagnitude is 0 (i.e. every non-upset game), independent of factor.
//   - if extra >= 0 (factor positive): the WINNING team's normal zero-sum gain is topped up by
//     extra/3 per player. MMR is created into the system; losing team is untouched.
//   - if extra <  0 (factor negative): the LOSING team's normal zero-sum loss is made worse by
//     extra/3 per player (extra is negative here, so this subtracts more). MMR is destroyed;
//     winning team is untouched.
//   Net system-wide MMR change per game = exactly `extra` (0 at factor=0, and 0 whenever the
//   winner wasn't an underdog, matching standard Elo in both cases).
//
// This reuses the same 996-player / balanced-matchmaking / Bradley-Terry-skill harness as
// simulate-mmr-scale.mjs so results are comparable to that baseline (factor=0 here should
// reproduce it, module the fact that this only runs one seeded stream per factor).
//
// Run with: node scripts/simulate-mmr-creation.mjs

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

// Factors to compare. 0 is the standard-Elo baseline (net MMR must stay ~0 in that row).
const CREATION_FACTORS_TO_TEST = [0, 10, 30, 60, -10, -30, -60];

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

// Standard Elo delta, extended with the creation/destruction term above.
function computeEloDeltasWithCreation(players, winner, config, creationFactor) {
  const avgA = teamAverage(players, "A");
  const avgB = teamAverage(players, "B");
  const expectedA = 1 / (1 + Math.pow(10, (avgB - avgA) / config.sScale));
  const expectedByTeam = { A: expectedA, B: 1 - expectedA };

  const expectedWinner = expectedByTeam[winner];
  const upsetMagnitude = expectedWinner >= 0.5 ? 0 : (0.5 - expectedWinner) * 2;
  const extra = creationFactor * upsetMagnitude;
  const loser = winner === "A" ? "B" : "A";
  const beneficiaryTeam = extra >= 0 ? winner : loser;
  const extraPerPlayer = extra / 3;

  return players.map((p) => {
    const score = p.team === winner ? 1 : 0;
    const expected = expectedByTeam[p.team];
    const wasProvisional = p.priorRankGamesPlayed < config.provisionalGames;
    const k = wasProvisional ? config.kFactor * config.provisionalKMultiplier : config.kFactor;
    let delta = (k * (score - expected)) / 3;
    if (p.team === beneficiaryTeam) delta += extraPerPlayer;
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

function runSimulation(creationFactor) {
  const rng = mulberry32(SEED);
  const players = [];
  for (let i = 0; i < NUM_PLAYERS; i++) {
    players.push({ id: `p${i}`, skill: 25 + rng() * 75, mmr: 0, rankGamesPlayed: 0, wins: 0, losses: 0 });
  }

  const totalMmrByRound = [];
  let avgUpsetMagnitudeSum = 0;
  let upsetGameCount = 0;
  let gameCount = 0;

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
      const avgA = mean(eloInputs.filter((p) => p.team === "A").map((p) => p.mmr));
      const avgB = mean(eloInputs.filter((p) => p.team === "B").map((p) => p.mmr));
      const expectedA = 1 / (1 + Math.pow(10, (avgB - avgA) / CONFIG.sScale));
      const expectedWinner = winner === "A" ? expectedA : 1 - expectedA;
      const upsetMagnitude = expectedWinner >= 0.5 ? 0 : (0.5 - expectedWinner) * 2;
      avgUpsetMagnitudeSum += upsetMagnitude;
      if (upsetMagnitude > 0) upsetGameCount++;
      gameCount++;

      const results = computeEloDeltasWithCreation(eloInputs, winner, CONFIG, creationFactor);
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

    if (round % 20 === 0 || round === ROUNDS) {
      totalMmrByRound.push({ round, totalMmr: players.reduce((s, p) => s + p.mmr, 0) });
    }
  }

  const finalMmrs = players.map((p) => p.mmr).sort((a, b) => a - b);
  const skillsUnsorted = players.map((p) => p.skill);
  const mmrsUnsorted = players.map((p) => p.mmr);

  return {
    creationFactor,
    avgUpsetMagnitude: avgUpsetMagnitudeSum / gameCount,
    upsetGameFraction: upsetGameCount / gameCount,
    totalMmrByRound,
    finalTotalMmr: players.reduce((s, p) => s + p.mmr, 0),
    meanMmr: mean(mmrsUnsorted),
    stdevMmr: stdev(mmrsUnsorted),
    correlation: pearsonR(skillsUnsorted, mmrsUnsorted),
    p40: percentile(finalMmrs, 40),
    p70: percentile(finalMmrs, 70),
    p90: percentile(finalMmrs, 90),
    min: finalMmrs[0],
    max: finalMmrs[finalMmrs.length - 1],
  };
}

console.log("=".repeat(90));
console.log(`SIMULATION: ${NUM_PLAYERS} players, ${ROUNDS} rounds — testing mmr_creation_factor`);
console.log("=".repeat(90));

const allResults = CREATION_FACTORS_TO_TEST.map(runSimulation);

console.log(`\nAverage upset magnitude across all games: ${allResults[0].avgUpsetMagnitude.toFixed(4)}`);
console.log(`Fraction of games that were an upset at all (winner's expected win prob < 0.5): ${(allResults[0].upsetGameFraction * 100).toFixed(2)}%`);
console.log("(Both are roughly constant across factors since matchmaking/outcomes are seeded identically — this is the input the mechanic scales against. Non-upset games contribute exactly 0.)");

console.log("\n--- Summary by creation_factor ---");
console.log(
  `${"factor".padEnd(8)} | ${"final total MMR".padEnd(17)} | ${"mean".padEnd(8)} | ${"stdev".padEnd(8)} | ${"corr(skill,mmr)".padEnd(17)} | ${"min".padEnd(9)} | ${"max".padEnd(9)} | p40/p70/p90`
);
for (const r of allResults) {
  console.log(
    `${String(r.creationFactor).padEnd(8)} | ${r.finalTotalMmr.toFixed(1).padEnd(17)} | ${r.meanMmr.toFixed(2).padEnd(8)} | ${r.stdevMmr.toFixed(2).padEnd(8)} | ${r.correlation.toFixed(4).padEnd(17)} | ${r.min.toFixed(1).padEnd(9)} | ${r.max.toFixed(1).padEnd(9)} | ${r.p40.toFixed(1)}/${r.p70.toFixed(1)}/${r.p90.toFixed(1)}`
  );
}

console.log("\n--- Total system MMR drift over rounds (factor=60 and factor=-60) ---");
for (const factor of [60, -60]) {
  const r = allResults.find((x) => x.creationFactor === factor);
  console.log(`\nfactor=${factor}:`);
  for (const point of r.totalMmrByRound) {
    console.log(`  round ${String(point.round).padEnd(4)} total system MMR: ${point.totalMmr.toFixed(1)}`);
  }
}
