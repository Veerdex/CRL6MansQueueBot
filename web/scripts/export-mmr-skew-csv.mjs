// One-off export: runs the density-based skew simulation (see simulate-mmr-skew.mjs for the full
// mechanism writeup) for a fixed set of skew factors and writes one CSV with per-player final
// state, tagged by factor, so the three runs can be compared/plotted directly.
//
// Run with: node scripts/export-mmr-skew-csv.mjs [outputPath]

import { writeFileSync } from "node:fs";

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

const BASE_SIGMA = 50;
const FACTORS_TO_EXPORT = [0, 0.3, 0.5, 0.9];

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

  return players;
}

const outputDir = process.argv[2] || ".";

for (const factor of FACTORS_TO_EXPORT) {
  const players = runSimulation(factor);
  const lines = ["player_id,skill,final_mmr,wins,losses,rank_games_played"];
  for (const p of players) {
    lines.push(`${p.id},${p.skill.toFixed(4)},${p.mmr.toFixed(4)},${p.wins},${p.losses},${p.rankGamesPlayed}`);
  }
  const factorLabel = String(factor).replace(".", "_");
  const outputPath = `${outputDir}/mmr-skew-factor-${factorLabel}.csv`;
  writeFileSync(outputPath, lines.join("\n"));
  console.log(`Wrote ${lines.length - 1} rows to ${outputPath}`);
}
