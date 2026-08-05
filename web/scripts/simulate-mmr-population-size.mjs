// Runs the density-based skew Elo simulation (see simulate-mmr-skew.mjs for the full mechanism
// writeup) at several different population sizes to see how the extreme min/max final MMR values
// scale with sample size alone, under a fixed skew factor. More players means more independent
// 100-round random walks, so the single most extreme walk among them tends to be more extreme
// purely from having more draws, on top of whatever the skew mechanic itself does to the tails.
//
// SKEW_FACTOR defaults to 0.5 (dampens the negative side, per simulate-mmr-skew.mjs's sign
// convention) — change the constant below to test other factors, or 0 to fall back to plain
// baseline Elo.
//
// Each population size must be divisible by 6 (one 3v3 lobby); all five requested sizes are.
//
// Run with: node scripts/simulate-mmr-population-size.mjs [csvOutputPath]

import { writeFileSync } from "node:fs";

const SEED = 42;
const ROUNDS = 100;
const PLAYERS_PER_LOBBY = 6;

const CONFIG = {
  kFactor: 32,
  sScale: 400,
  provisionalGames: 10,
  provisionalKMultiplier: 1.75,
};

// Reference spread scale for the dampening curve, same constant used in simulate-mmr-skew.mjs.
const BASE_SIGMA = 50;

const SKEW_FACTOR = 0.5;

const POPULATION_SIZES = [36, 132, 228, 324, 420];

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

// Verbatim from simulate-mmr-skew.mjs's Attempt 3 mechanism.
function computeEloDeltasWithDensitySkew(players, winner, config, skewFactor) {
  const avgA = mean(players.filter((p) => p.team === "A").map((p) => p.mmr));
  const avgB = mean(players.filter((p) => p.team === "B").map((p) => p.mmr));
  const expectedA = 1 / (1 + Math.pow(10, (avgB - avgA) / config.sScale));
  const expectedByTeam = { A: expectedA, B: 1 - expectedA };

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

// Verbatim from web/lib/discord/teamFormation.ts.
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

function runSimulation(numPlayers) {
  const rng = mulberry32(SEED);
  const players = [];
  for (let i = 0; i < numPlayers; i++) {
    players.push({ id: `p${i}`, skill: 25 + rng() * 75, mmr: 0, rankGamesPlayed: 0, wins: 0, losses: 0 });
  }
  const lobbiesPerRound = numPlayers / PLAYERS_PER_LOBBY;

  for (let round = 1; round <= ROUNDS; round++) {
    const shuffled = shuffle(players, rng);
    for (let lobby = 0; lobby < lobbiesPerRound; lobby++) {
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
      const results = computeEloDeltasWithDensitySkew(eloInputs, winner, CONFIG, SKEW_FACTOR);
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

  const mmrs = players.map((p) => p.mmr);
  return {
    numPlayers,
    min: Math.min(...mmrs),
    max: Math.max(...mmrs),
    mean: mean(mmrs),
    stdev: stdev(mmrs),
  };
}

console.log("=".repeat(90));
console.log(`SIMULATION: skew_factor=${SKEW_FACTOR}, ${ROUNDS} rounds — min/max vs. population size`);
console.log("=".repeat(90));

const results = POPULATION_SIZES.map(runSimulation);

console.log(`\n${"players".padEnd(9)} | ${"min".padEnd(9)} | ${"max".padEnd(9)} | ${"range".padEnd(9)} | ${"mean".padEnd(8)} | ${"stdev".padEnd(8)}`);
for (const r of results) {
  console.log(
    `${String(r.numPlayers).padEnd(9)} | ${r.min.toFixed(1).padEnd(9)} | ${r.max.toFixed(1).padEnd(9)} | ${(r.max - r.min).toFixed(1).padEnd(9)} | ${r.mean.toFixed(2).padEnd(8)} | ${r.stdev.toFixed(2).padEnd(8)}`
  );
}

const csvPath = process.argv[2];
if (csvPath) {
  const lines = ["num_players,min_mmr,max_mmr,range,mean,stdev"];
  for (const r of results) {
    lines.push(`${r.numPlayers},${r.min.toFixed(4)},${r.max.toFixed(4)},${(r.max - r.min).toFixed(4)},${r.mean.toFixed(4)},${r.stdev.toFixed(4)}`);
  }
  writeFileSync(csvPath, lines.join("\n"));
  console.log(`\nWrote ${results.length} rows to ${csvPath}`);
}
