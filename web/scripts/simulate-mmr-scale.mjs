// Simulates 996 players with a hidden "true skill" value (25-100) playing 10 rounds of
// balanced 6-mans (166 concurrent lobbies/round, so every player plays exactly once per
// round) to see what raw MMR distribution the real Elo/balancing code converges to. Used to
// pick mmr_scale/mmr_shift (the display-only transform in web/lib/discord/config.ts:
// displayed_mmr = actual_mmr * scale + shift) so the shown numbers read sensibly.
//
// Modeling choices made here (not specified by the user — flagged so they're easy to
// challenge/change):
//   1. Skill ~ Uniform(25, 100) per player, i.i.d. A bell-curve (normal) distribution would
//      cluster players near the middle instead and change the resulting MMR spread/shape —
//      worth rerunning with that if the real population isn't actually uniform.
//   2. True win probability uses a Bradley-Terry model on the *true skill* averages:
//      P(team A wins) = avgSkillA / (avgSkillA + avgSkillB). This is independent of the
//      Elo/MMR math entirely — it's the "ground truth" the simulated games roll against.
//   3. Team balancing uses current MMR (not true skill) via the exact brute-force
//      bestBalancedSplit from web/lib/discord/teamFormation.ts — the balancer only ever sees
//      what the bot would actually know.
//   4. Elo update is verbatim from web/lib/mmr/elo.ts with CLAUDE.md's documented defaults.
//
// Run with: node scripts/simulate-mmr-scale.mjs

const SEED = 42; // change/remove for a different random draw
const NUM_PLAYERS = 996;
const ROUNDS = 100; // same seed as the 10-round run, so rounds 1-10 reproduce identically and this just extends it
const PLAYERS_PER_LOBBY = 6;
const LOBBIES_PER_ROUND = NUM_PLAYERS / PLAYERS_PER_LOBBY; // 166

const CONFIG = {
  kFactor: 32,
  sScale: 400,
  provisionalGames: 10,
  provisionalKMultiplier: 1.75,
};

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) so this is reproducible run-to-run.
// ---------------------------------------------------------------------------
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
const rng = mulberry32(SEED);

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Elo logic, verbatim from web/lib/mmr/elo.ts
// ---------------------------------------------------------------------------
function teamAverage(players, team) {
  const members = players.filter((p) => p.team === team);
  return members.reduce((sum, p) => sum + p.mmr, 0) / members.length;
}

function computeEloDeltas(players, winner, config) {
  const avgA = teamAverage(players, "A");
  const avgB = teamAverage(players, "B");
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

// ---------------------------------------------------------------------------
// Balanced split, verbatim from web/lib/discord/teamFormation.ts's bestBalancedSplit
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------
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
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  return num / Math.sqrt(dx2 * dy2);
}
// OLS fit: ys = a*xs + b (minimizes squared error in ys)
function linregress(xs, ys) {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const a = num / den;
  const b = my - a * mx;
  return { a, b };
}

// ---------------------------------------------------------------------------
// Set up players
// ---------------------------------------------------------------------------
const players = [];
for (let i = 0; i < NUM_PLAYERS; i++) {
  players.push({
    id: `p${i}`,
    skill: 25 + rng() * 75, // Uniform(25, 100)
    mmr: 0,
    rankGamesPlayed: 0,
    wins: 0,
    losses: 0,
  });
}

// ---------------------------------------------------------------------------
// Run rounds
// ---------------------------------------------------------------------------
const roundStats = [];

for (let round = 1; round <= ROUNDS; round++) {
  const shuffled = shuffle(players);

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

  const mmrs = players.map((p) => p.mmr);
  const skills = players.map((p) => p.skill);
  roundStats.push({
    round,
    meanMmr: mean(mmrs),
    stdevMmr: stdev(mmrs),
    correlation: pearsonR(skills, mmrs),
  });
}

// ---------------------------------------------------------------------------
// Final report
// ---------------------------------------------------------------------------
const finalMmrs = players.map((p) => p.mmr).sort((a, b) => a - b);
const finalSkills = players.map((p) => p.skill).sort((a, b) => a - b);
const skillsUnsorted = players.map((p) => p.skill);
const mmrsUnsorted = players.map((p) => p.mmr);

console.log("=".repeat(70));
console.log(`SIMULATION: ${NUM_PLAYERS} players, ${ROUNDS} rounds, ${LOBBIES_PER_ROUND} lobbies/round`);
console.log("=".repeat(70));

console.log("\n--- Round-by-round convergence (every 10th round + last) ---");
console.log(`${"Round".padEnd(7)} | ${"Mean MMR".padEnd(10)} | ${"Stdev MMR".padEnd(10)} | Corr(skill, mmr)`);
for (const r of roundStats) {
  if (r.round % 10 !== 0 && r.round !== roundStats.length) continue;
  console.log(
    `${String(r.round).padEnd(7)} | ${r.meanMmr.toFixed(2).padEnd(10)} | ${r.stdevMmr.toFixed(2).padEnd(10)} | ${r.correlation.toFixed(4)}`
  );
}

console.log("\n--- Final skill distribution (ground truth, Uniform 25-100) ---");
console.log(`mean=${mean(skillsUnsorted).toFixed(2)}  stdev=${stdev(skillsUnsorted).toFixed(2)}  min=${finalSkills[0].toFixed(2)}  max=${finalSkills[finalSkills.length - 1].toFixed(2)}`);

console.log("\n--- Final raw MMR distribution ---");
console.log(`mean=${mean(mmrsUnsorted).toFixed(2)}  stdev=${stdev(mmrsUnsorted).toFixed(2)}  min=${finalMmrs[0].toFixed(2)}  max=${finalMmrs[finalMmrs.length - 1].toFixed(2)}`);

const pcts = [1, 5, 10, 25, 40, 50, 70, 75, 90, 95, 99];
console.log("\n--- Raw MMR percentiles (band cutoffs use 40/70/90) ---");
for (const p of pcts) {
  console.log(`  p${p.toString().padStart(2)}: ${percentile(finalMmrs, p).toFixed(2)}`);
}

console.log("\n--- Skill percentiles, for comparison ---");
for (const p of pcts) {
  console.log(`  p${p.toString().padStart(2)}: ${percentile(finalSkills, p).toFixed(2)}`);
}

const finalCorrelation = pearsonR(skillsUnsorted, mmrsUnsorted);
const { a: regressionScale, b: regressionShift } = linregress(mmrsUnsorted, skillsUnsorted);

console.log("\n--- Skill vs MMR fit ---");
console.log(`Pearson correlation: ${finalCorrelation.toFixed(4)}`);
console.log(`OLS best fit  skill ≈ mmr * scale + shift:`);
console.log(`  scale (mmr_scale) ≈ ${regressionScale.toFixed(4)}`);
console.log(`  shift (mmr_shift) ≈ ${regressionShift.toFixed(4)}`);

// Alternative heuristic: linearly map the raw p1-p99 MMR range onto the 25-100 skill range,
// rather than minimizing squared error against individual skill values.
const mmrP1 = percentile(finalMmrs, 1);
const mmrP99 = percentile(finalMmrs, 99);
const rangeScale = (100 - 25) / (mmrP99 - mmrP1);
const rangeShift = 25 - rangeScale * mmrP1;
console.log(`\nAlternative (range-matching p1-p99 to 25-100):`);
console.log(`  scale ≈ ${rangeScale.toFixed(4)}`);
console.log(`  shift ≈ ${rangeShift.toFixed(4)}`);

// Dump full per-player data as CSV for external plotting/analysis.
import { writeFileSync } from "fs";
const csvLines = ["player_id,skill,final_mmr,wins,losses"];
for (const p of players) {
  csvLines.push(`${p.id},${p.skill.toFixed(4)},${p.mmr.toFixed(4)},${p.wins},${p.losses}`);
}
const outPath = process.argv[2] || "./simulate-mmr-scale-output.csv";
writeFileSync(outPath, csvLines.join("\n"));
console.log(`\nFull per-player data written to ${outPath}`);
