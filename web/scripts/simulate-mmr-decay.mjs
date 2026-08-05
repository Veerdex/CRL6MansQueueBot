// Simulate Team A (1000 MMR) vs Team B (starting at 1000 MMR, decreasing by 50 each game)
// Team A wins all 10 matches

const S_SCALE = 400; // Standard Elo scale

function calculateWinProbability(ratingA, ratingB) {
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / S_SCALE));
  return expectedA * 100;
}

console.log("=".repeat(80));
console.log("SIMULATION: Team A (1000 MMR) vs Team B (Decaying 1000 → 500 MMR)");
console.log("Team A wins all 10 matches");
console.log("=".repeat(80));
console.log();

const teamAMMR = 1000;
let teamBMMR = 1000;
const decayPerGame = 50;

console.log(`${"Match"} | ${"Team A MMR"} | ${"Team B MMR"} | ${"A Win %"} | ${"B Win %"} | ${"MMR Delta"}`);
console.log("-".repeat(80));

for (let match = 1; match <= 10; match++) {
  const predictionA = calculateWinProbability(teamAMMR, teamBMMR);
  const predictionB = 100 - predictionA;

  // Calculate MMR deltas using Elo formula
  // Team A wins, so score = 1 for Team A, 0 for Team B
  // Since teams have 3 players each, we calculate per player
  // Average team rating = (p1 + p2 + p3) / 3 = individual player rating if all equal

  const expectedA = predictionA / 100;
  const expectedB = predictionB / 100;

  // K = 32 (standard), applied per player, split across team (divide by 3)
  const kFactor = 32;
  const deltaPerPlayerA = (kFactor * (1 - expectedA)) / 3;
  const deltaPerPlayerB = (kFactor * (0 - expectedB)) / 3;

  console.log(
    `${match.toString().padEnd(5)} | ${teamAMMR.toString().padEnd(11)} | ${teamBMMR.toString().padEnd(11)} | ${predictionA.toFixed(1).padEnd(7)}% | ${predictionB.toFixed(1).padEnd(7)}% | ${deltaPerPlayerB.toFixed(2)}`
  );

  // Update Team B's MMR (apply delta and then decay)
  teamBMMR += deltaPerPlayerB;
  teamBMMR -= decayPerGame;
}

console.log("-".repeat(80));
console.log();
console.log(`Final Team A MMR: ${teamAMMR}`);
console.log(`Final Team B MMR: ${teamBMMR}`);
console.log(`Team B Total Decline: ${1000 - teamBMMR} MMR`);
console.log();

// Show the dramatic change in win prediction
const initialPrediction = calculateWinProbability(teamAMMR, 1000);
const finalPrediction = calculateWinProbability(teamAMMR, teamBMMR);
console.log(`Win Probability (Team A):`);
console.log(`  Match 1: ${initialPrediction.toFixed(1)}%`);
console.log(`  Match 10: ${finalPrediction.toFixed(1)}%`);
console.log(`  Difference: ${(finalPrediction - initialPrediction).toFixed(1)}% in favor of Team A`);
