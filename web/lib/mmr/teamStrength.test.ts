import { describe, expect, it } from "vitest";
import { expectedWinProbabilityA, calculateTeamStrength } from "./teamStrength";

// The shared win-probability helper behind /chances, the website's match-history odds bar, and
// the Winners/Losers headers on the report summary. Those three surfaces quote the same number
// to players, so the contract that matters here is less "this exact decimal" than "symmetric,
// monotonic, and never NaN".
describe("expectedWinProbabilityA", () => {
  const S = 400;

  it("gives two identical teams an even shot", () => {
    expect(expectedWinProbabilityA([100, 50, 0], [100, 50, 0], S)).toBeCloseTo(0.5, 10);
  });

  it("is symmetric — swapping the teams swaps the probability", () => {
    const a = [400, 250, 120];
    const b = [300, 80, -40];
    const pA = expectedWinProbabilityA(a, b, S)!;
    const pB = expectedWinProbabilityA(b, a, S)!;
    expect(pA + pB).toBeCloseTo(1, 10);
  });

  it("favors the stronger team", () => {
    const strong = expectedWinProbabilityA([600, 500, 400], [100, 50, 0], S)!;
    expect(strong).toBeGreaterThan(0.5);
    expect(strong).toBeLessThan(1);
  });

  it("agrees with the raw Elo expectation over calculateTeamStrength", () => {
    const a = [220, 140, -30];
    const b = [310, 90, 40];
    const expected = 1 / (1 + 10 ** ((calculateTeamStrength(b) - calculateTeamStrength(a)) / S));
    expect(expectedWinProbabilityA(a, b, S)).toBe(expected);
  });

  // The guard that keeps "(NaN%)" out of a Discord embed: calculateTeamStrength destructures
  // exactly three ratings, so anything else has to be refused up front rather than quietly
  // producing NaN downstream.
  it("returns null unless both sides have exactly three ratings", () => {
    expect(expectedWinProbabilityA([100, 50], [100, 50, 0], S)).toBeNull();
    expect(expectedWinProbabilityA([100, 50, 0], [100, 50, 0, 25], S)).toBeNull();
    expect(expectedWinProbabilityA([], [], S)).toBeNull();
  });

  it("returns null when any rating is not a finite number", () => {
    expect(expectedWinProbabilityA([100, 50, NaN], [100, 50, 0], S)).toBeNull();
    expect(expectedWinProbabilityA([100, 50, 0], [Infinity, 50, 0], S)).toBeNull();
  });
});
