// Tests what MMR dynamics look like when the bot's own current MMR is treated as if it WERE
// ground truth — win probability for each game is drawn directly from the Elo "expected" value
// on current MMR (same formula already used to compute Elo deltas), instead of from a separate
// fixed hidden `skill` value like simulate-mmr-scale.mjs / simulate-mmr-creation.mjs use.
//
// This is a fundamentally different kind of test. There is no independent ground truth left for
// MMR to converge toward — the thing generating outcomes IS the current MMR estimate. Every
// game's win probability is exactly the Elo model's own "expected" value, so each delta has
// expectation 0 by construction: E[delta | current mmr] = K*(expected - expected)/3 = 0. That
// makes every player's MMR trajectory a martingale (a fair random walk with no systematic
// drift) — there's no corr(skill, mmr) to report, since skill and mmr are now the same thing.
//
// What IS meaningful: how much spread/variance emerges over time from pure luck alone, even
// though every player is actually equally "skilled" (there's no hidden skill differentiating
// them at all here). This serves as a noise-floor control to compare against the real
// skill-driven runs — if a real run's MMR spread isn't meaningfully larger than this pure-luck
// control's spread at the same round count, that's a sign luck is still dominating signal.
//
// Also checks for a fairness bug: correlation between arbitrary player index (assigned at
// creation, meaningless) and final MMR should be ~0. A nonzero value would indicate some bias
// in shuffle/matchmaking/RNG rather than pure luck.
//
// Run with: node scripts/simulate-mmr-selfreferential.mjs [csvOutputPath]

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

// Verbatim from web/lib/mmr/elo.ts (standard Elo, no creation/destruction term).
function computeEloDeltas(players, winner, config) {
  const avgA = mean(players.filter((p) => p.team === "A").map((p) => p.mmr));
  const avgB = mean(players.filter((p) => p.team === "B").map((p) => p.mmr));
  const expectedA = 1 / (1 + Math.pow(10, (avgB - avgA) / config.sScale));
  const expectedByTeam = { A: expectedA, B: 1 - expectedA };

  return players.map((p) => {
    const score = p.team === winner ? 1 : 0;
    const expected = expectedByTeam[p.team];
    const wasProvisional = p.priorRankGamesPlayed < config.provisionalGames;
    const k = wasProvisional ? config.kFactor * config.provisionalKMultiplier : config.kFactor;
    const delta = (k * (score - expected)) / 3;
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
  players.push({ id: `p${i}`, index: i, mmr: 0, rankGamesPlayed: 0, wins: 0, losses: 0 });
}

const roundStats = [];

for (let round = 1; round <= ROUNDS; round++) {
  const shuffled = shuffle(players, rng);
  for (let lobby = 0; lobby < LOBBIES_PER_ROUND; lobby++) {
    const members = shuffled.slice(lobby * PLAYERS_PER_LOBBY, (lobby + 1) * PLAYERS_PER_LOBBY);
    const { teamA, teamB } = bestBalancedSplit(members);

    const avgA = mean(teamA.map((p) => p.mmr));
    const avgB = mean(teamB.map((p) => p.mmr));
    const expectedA = 1 / (1 + Math.pow(10, (avgB - avgA) / CONFIG.sScale));
    const winner = rng() < expectedA ? "A" : "B";

    const eloInputs = [
      ...teamA.map((p) => ({ playerId: p.id, mmr: p.mmr, team: "A", priorRankGamesPlayed: p.rankGamesPlayed })),
      ...teamB.map((p) => ({ playerId: p.id, mmr: p.mmr, team: "B", priorRankGamesPlayed: p.rankGamesPlayed })),
    ];
    const results = computeEloDeltas(eloInputs, winner, CONFIG);
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

  if (round % 10 === 0 || round === 1 || round === ROUNDS) {
    const mmrs = players.map((p) => p.mmr);
    const indices = players.map((p) => p.index);
    roundStats.push({
      round,
      meanMmr: mean(mmrs),
      stdevMmr: stdev(mmrs),
      indexBiasCorr: pearsonR(indices, mmrs),
      min: Math.min(...mmrs),
      max: Math.max(...mmrs),
    });
  }
}

console.log("=".repeat(90));
console.log(`SIMULATION: ${NUM_PLAYERS} players, ${ROUNDS} rounds — self-referential MMR (win prob drawn from current MMR)`);
console.log("=".repeat(90));

console.log("\n--- Round-by-round spread growth (pure luck, no hidden skill) ---");
console.log(`${"Round".padEnd(7)} | ${"Mean".padEnd(10)} | ${"Stdev".padEnd(10)} | ${"Min".padEnd(10)} | ${"Max".padEnd(10)} | Index-bias corr`);
for (const r of roundStats) {
  console.log(
    `${String(r.round).padEnd(7)} | ${r.meanMmr.toFixed(2).padEnd(10)} | ${r.stdevMmr.toFixed(2).padEnd(10)} | ${r.min.toFixed(1).padEnd(10)} | ${r.max.toFixed(1).padEnd(10)} | ${r.indexBiasCorr.toFixed(4)}`
  );
}

const finalMmrs = players.map((p) => p.mmr).sort((a, b) => a - b);
console.log("\n--- Final distribution (round " + ROUNDS + ") ---");
console.log(`mean=${mean(finalMmrs).toFixed(2)}, stdev=${stdev(finalMmrs).toFixed(2)}, min=${finalMmrs[0].toFixed(2)}, max=${finalMmrs[finalMmrs.length - 1].toFixed(2)}`);
console.log(`p10=${percentile(finalMmrs, 10).toFixed(2)}, p40=${percentile(finalMmrs, 40).toFixed(2)}, p70=${percentile(finalMmrs, 70).toFixed(2)}, p90=${percentile(finalMmrs, 90).toFixed(2)}, p99=${percentile(finalMmrs, 99).toFixed(2)}`);

const winCounts = players.map((p) => p.wins);
console.log(`\nWin count spread (should also just be luck-driven): mean=${mean(winCounts).toFixed(2)}, stdev=${stdev(winCounts).toFixed(2)}, min=${Math.min(...winCounts)}, max=${Math.max(...winCounts)}`);

const csvPath = process.argv[2];
if (csvPath) {
  const lines = ["id,final_mmr,wins,losses"];
  for (const p of players) lines.push(`${p.id},${p.mmr.toFixed(4)},${p.wins},${p.losses}`);
  writeFileSync(csvPath, lines.join("\n"));
  console.log(`\nWrote ${players.length} rows to ${csvPath}`);
}
