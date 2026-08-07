// Adds heterogeneous participation rates on top of the density-based skew mechanic (see
// simulate-mmr-skew.mjs for the skew mechanism itself). Two per-player attributes are drawn ONCE
// at setup, not re-rolled each round:
//
//   skill = rng()^2 * 40 + 60                    // 60-100, squaring skews the pool toward the low end
//   score = rng()^(2*(1-skill/130)) * 100        // 0-100. Exponent ranges ~1.08 (skill=60) down to
//                                                 // ~0.46 (skill=100): low skill -> exponent >1 skews
//                                                 // the roll toward 0 (convex), high skill -> exponent
//                                                 // <1 skews the roll toward 100 (concave). Same 0-100
//                                                 // range for every player, but the shape of the draw
//                                                 // shifts with skill instead of capping a ceiling.
//
// Each round, every player independently rolls against score/100 as their probability of
// queueing that round. Whoever queues is grouped into as many complete 6-player lobbies as
// possible (balanced by current MMR, same as every other script here); anyone left over after
// the last full lobby just sits out that round, same as a real queue that can't fill.
//
// Run with: node scripts/simulate-mmr-participation.mjs [csvOutputPath]

import { writeFileSync } from "node:fs";

const SEED = 42;
const NUM_PLAYERS = 96;
const ROUNDS = 50;
const PLAYERS_PER_LOBBY = 6;

const CONFIG = {
  kFactor: 32,
  sScale: 400,
  provisionalGames: 10,
  provisionalKMultiplier: 1.75,
};

const BASE_SIGMA = 50;
const SKEW_FACTOR = 0.5;

// Applied last, after skew dampening: pushes every nonzero delta further from 0 by this fixed
// amount, in whichever direction it was already headed (-0.002 -> -2.002, +5.32 -> +7.32). Not a
// floor on magnitude — it's added unconditionally, so it also inflates already-large deltas.
const MIN_CHANGE_MAGNITUDE = 2;

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

    if (delta !== 0) {
      delta += Math.sign(delta) * MIN_CHANGE_MAGNITUDE;
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

const rng = mulberry32(SEED);
const players = [];
for (let i = 0; i < NUM_PLAYERS; i++) {
  const skill = rng() ** 2 * 40 + 60;
  const score = rng() ** (2 * (1 - skill / 130)) * 100;
  players.push({ id: `p${i}`, skill, participationScore: score, mmr: 0, rankGamesPlayed: 0, wins: 0, losses: 0, gamesPlayed: 0, history: [] });
}

for (let round = 1; round <= ROUNDS; round++) {
  const queued = players.filter((p) => rng() < p.participationScore / 100);
  const shuffled = shuffle(queued, rng);
  const lobbiesThisRound = Math.floor(shuffled.length / PLAYERS_PER_LOBBY);

  for (let lobby = 0; lobby < lobbiesThisRound; lobby++) {
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
      p.gamesPlayed++;
      const onWinningTeam = (winner === "A" ? teamA : teamB).some((x) => x.id === p.id);
      if (onWinningTeam) p.wins++;
      else p.losses++;
      p.history.push({ round, gameNumber: p.gamesPlayed, delta: r.delta, mmrAfter: p.mmr, result: onWinningTeam ? "W" : "L", wasProvisional: r.wasProvisional });
    }
  }
}

const finalMmrs = players.map((p) => p.mmr).sort((a, b) => a - b);
const gamesPlayed = players.map((p) => p.gamesPlayed);
const skills = players.map((p) => p.skill);
const scores = players.map((p) => p.participationScore);

console.log("=".repeat(100));
console.log(`SIMULATION: ${NUM_PLAYERS} players, ${ROUNDS} rounds — skew_factor=${SKEW_FACTOR} + skill-linked participation`);
console.log("=".repeat(100));

console.log("\n--- Final MMR distribution ---");
console.log(`min=${finalMmrs[0].toFixed(3)}, max=${finalMmrs[finalMmrs.length - 1].toFixed(3)}, mean=${mean(players.map((p) => p.mmr)).toFixed(3)}, sd=${stdev(players.map((p) => p.mmr)).toFixed(3)}, median=${percentile(finalMmrs, 50).toFixed(3)}`);

console.log("\n--- Games played distribution (out of 50 rounds max) ---");
console.log(`min=${Math.min(...gamesPlayed)}, max=${Math.max(...gamesPlayed)}, mean=${mean(gamesPlayed).toFixed(2)}, sd=${stdev(gamesPlayed).toFixed(2)}`);
console.log(`corr(skill, games played) = ${pearsonR(skills, gamesPlayed).toFixed(4)}`);
console.log(`corr(participation score, games played) = ${pearsonR(scores, gamesPlayed).toFixed(4)}`);
console.log(`corr(games played, final mmr) = ${pearsonR(gamesPlayed, players.map((p) => p.mmr)).toFixed(4)}`);

console.log("\n--- Skill / participation score input distributions (sanity check) ---");
console.log(`skill: min=${Math.min(...skills).toFixed(2)}, max=${Math.max(...skills).toFixed(2)}, mean=${mean(skills).toFixed(2)}`);
console.log(`participation score: min=${Math.min(...scores).toFixed(2)}, max=${Math.max(...scores).toFixed(2)}, mean=${mean(scores).toFixed(2)}`);

const csvPath = process.argv[2];
if (csvPath) {
  const lines = ["player_id,skill,participation_score,final_mmr,wins,losses,games_played"];
  for (const p of players) {
    lines.push(`${p.id},${p.skill.toFixed(4)},${p.participationScore.toFixed(4)},${p.mmr.toFixed(4)},${p.wins},${p.losses},${p.gamesPlayed}`);
  }
  writeFileSync(csvPath, lines.join("\n"));
  console.log(`\nWrote ${players.length} rows to ${csvPath}`);
}

// --- Provisional vs. standard delta stats, across every recorded game for every player ---
const allGames = players.flatMap((p) => p.history);
const provisionalGames = allGames.filter((h) => h.wasProvisional);
const standardGames = allGames.filter((h) => !h.wasProvisional);

function deltaStats(games, label) {
  const deltas = games.map((h) => h.delta);
  const absDeltas = deltas.map((d) => Math.abs(d));
  console.log(`${label}: n=${games.length}, mean_signed_delta=${mean(deltas).toFixed(4)}, mean_abs_delta=${mean(absDeltas).toFixed(4)}, min=${Math.min(...deltas).toFixed(3)}, max=${Math.max(...deltas).toFixed(3)}`);
}

console.log(`\n${"=".repeat(100)}`);
console.log("PROVISIONAL VS. STANDARD DELTA STATS (all players, all games)");
console.log(`${"=".repeat(100)}`);
deltaStats(provisionalGames, "Provisional games (first 10 rank games per player)");
deltaStats(standardGames, "Standard games (11th+ rank game per player)");

// --- Best / worst performer game-by-game breakdown ---------------------------------------
// "Best"/"worst" = highest/lowest final MMR. Worst is additionally constrained to >=10 games
// played, so a single lucky/unlucky game from a low-participation player can't win the label.
const MIN_GAMES_FOR_WORST = 10;

const bestPlayer = players.reduce((best, p) => (p.mmr > best.mmr ? p : best), players[0]);
const eligibleForWorst = players.filter((p) => p.gamesPlayed >= MIN_GAMES_FOR_WORST);
const worstPlayer = eligibleForWorst.reduce((worst, p) => (p.mmr < worst.mmr ? p : worst), eligibleForWorst[0]);

function printHistory(label, p) {
  console.log(`\n--- ${label}: ${p.id} (skill=${p.skill.toFixed(2)}, participation_score=${p.participationScore.toFixed(2)}, final_mmr=${p.mmr.toFixed(3)}, games=${p.gamesPlayed}, W-L=${p.wins}-${p.losses}) ---`);
  console.log(`${"Game#".padEnd(6)} | ${"Round".padEnd(6)} | ${"Result".padEnd(6)} | ${"Provisional".padEnd(11)} | ${"Delta".padEnd(10)} | ${"MMR After"}`);
  console.log("-".repeat(60));
  for (const h of p.history) {
    console.log(
      `${h.gameNumber.toString().padEnd(6)} | ${h.round.toString().padEnd(6)} | ${h.result.padEnd(6)} | ${(h.wasProvisional ? "yes" : "no").padEnd(11)} | ${h.delta.toFixed(3).padEnd(10)} | ${h.mmrAfter.toFixed(3)}`
    );
  }
}

console.log(`\n${"=".repeat(100)}`);
console.log("BEST / WORST PERFORMER BREAKDOWN");
console.log(`${"=".repeat(100)}`);
printHistory("BEST performer (highest final MMR)", bestPlayer);
printHistory(`WORST performer (lowest final MMR, min ${MIN_GAMES_FOR_WORST} games)`, worstPlayer);
