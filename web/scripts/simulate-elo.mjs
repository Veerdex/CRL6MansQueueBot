// Elo config (defaults from config.ts)
const CONFIG = {
  kFactor: 32,
  sScale: 400,
  provisionalGames: 10,
  provisionalKMultiplier: 1.75,
};

// Elo calculation logic (from web/lib/mmr/elo.ts)
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

// Initialize 6 players
const players = [
  { id: "p1", name: "Player 1 (Always Wins)", mmr: 0, rankGamesPlayed: 0, wins: 0 },
  { id: "p2", name: "Player 2", mmr: 0, rankGamesPlayed: 0, wins: 0 },
  { id: "p3", name: "Player 3", mmr: 0, rankGamesPlayed: 0, wins: 0 },
  { id: "p4", name: "Player 4", mmr: 0, rankGamesPlayed: 0, wins: 0 },
  { id: "p5", name: "Player 5", mmr: 0, rankGamesPlayed: 0, wins: 0 },
  { id: "p6", name: "Player 6", mmr: 0, rankGamesPlayed: 0, wins: 0 },
];

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function runSimulation(scenarioName) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`SIMULATION: ${scenarioName}`);
  console.log(`${"=".repeat(60)}\n`);

  // Reset players
  players.forEach((p) => {
    p.mmr = 0;
    p.rankGamesPlayed = 0;
    p.wins = 0;
  });

  // Play 10 games
  for (let game = 1; game <= 10; game++) {
    // Randomly assign teams
    const shuffled = shuffle(players);
    const teamA = shuffled.slice(0, 3);
    const teamB = shuffled.slice(3, 6);

    // Determine winner: Player 1 always wins
    const winnerTeam = teamA.some((p) => p.id === "p1") ? "A" : "B";

    // Prepare Elo inputs
    const eloInputs = [
      ...teamA.map((p) => ({ playerId: p.id, mmr: p.mmr, team: "A", priorRankGamesPlayed: p.rankGamesPlayed })),
      ...teamB.map((p) => ({ playerId: p.id, mmr: p.mmr, team: "B", priorRankGamesPlayed: p.rankGamesPlayed })),
    ];

    // Compute deltas
    const results = computeEloDeltas(eloInputs, winnerTeam, {
      kFactor: CONFIG.kFactor,
      sScale: CONFIG.sScale,
      provisionalGames: CONFIG.provisionalGames,
      provisionalKMultiplier: CONFIG.provisionalKMultiplier,
    });

    // Update players
    const resultsById = new Map(results.map((r) => [r.playerId, r]));
    players.forEach((p) => {
      const result = resultsById.get(p.id);
      p.mmr = result.newMmr;
      p.rankGamesPlayed++;
      if ((winnerTeam === "A" && teamA.some((x) => x.id === p.id)) || (winnerTeam === "B" && teamB.some((x) => x.id === p.id))) {
        p.wins++;
      }
    });

    console.log(`Game ${game}:`);
    console.log(`  Team A: ${teamA.map((p) => p.name.split(" ")[1]).join(", ")}`);
    console.log(`  Team B: ${teamB.map((p) => p.name.split(" ")[1]).join(", ")}`);
    console.log(`  Winner: Team ${winnerTeam}`);
    console.log();
  }

  // Sort by MMR and display results
  const sorted = [...players].sort((a, b) => b.mmr - a.mmr);
  console.log(`FINAL RESULTS (sorted by MMR):`);
  console.log("-".repeat(60));
  console.log(`${`Player`.padEnd(25)} | ${"MMR".padEnd(10)} | ${"Wins".padEnd(6)} | ${"Losses"}`);
  console.log("-".repeat(60));
  sorted.forEach((p) => {
    const losses = 10 - p.wins;
    console.log(
      `${p.name.padEnd(25)} | ${p.mmr.toFixed(1).padEnd(10)} | ${p.wins.toString().padEnd(6)} | ${losses}`
    );
  });
  console.log("-".repeat(60));
  console.log(`Average MMR: ${(sorted.reduce((sum, p) => sum + p.mmr, 0) / 6).toFixed(1)}`);
  console.log(`MMR Range: ${sorted[0].mmr.toFixed(1)} to ${sorted[sorted.length - 1].mmr.toFixed(1)}`);
}

// Run simulations
runSimulation("BALANCED TEAMS (Random Assignment)");
runSimulation("CAPTAINS DRAFT (Random Assignment)");
