import { describe, expect, it } from "vitest";
import { computeEloDeltas, computeStreakBonus, type EloConfig, type EloPlayerInput } from "./elo";

const config: EloConfig = { kFactor: 32, sScale: 400, provisionalGames: 10, provisionalKMultiplier: 1.75 };

function player(id: string, mmr: number, team: "A" | "B", priorRankGamesPlayed = 20): EloPlayerInput {
  return { playerId: id, mmr, team, priorRankGamesPlayed };
}

describe("computeEloDeltas", () => {
  it("splits an even-MMR win/loss 50/50, gains and losses mirrored and summing to zero", () => {
    const players = [
      player("a1", 0, "A"),
      player("a2", 0, "A"),
      player("a3", 0, "A"),
      player("b1", 0, "B"),
      player("b2", 0, "B"),
      player("b3", 0, "B"),
    ];
    const results = computeEloDeltas(players, "A", config);

    const total = results.reduce((sum, r) => sum + r.delta, 0);
    expect(total).toBeCloseTo(0, 10);

    for (const r of results.filter((r) => ["a1", "a2", "a3"].includes(r.playerId))) {
      expect(r.delta).toBeCloseTo(32 / 6, 10); // K * (1 - 0.5) / 3
    }
    for (const r of results.filter((r) => ["b1", "b2", "b3"].includes(r.playerId))) {
      expect(r.delta).toBeCloseTo(-32 / 6, 10);
    }
  });

  it("awards fewer points for an expected win against a much lower-rated team", () => {
    const players = [
      player("a1", 800, "A"),
      player("a2", 800, "A"),
      player("a3", 800, "A"),
      player("b1", 0, "B"),
      player("b2", 0, "B"),
      player("b3", 0, "B"),
    ];
    const results = computeEloDeltas(players, "A", config);
    const winnerDelta = results.find((r) => r.playerId === "a1")!.delta;
    expect(winnerDelta).toBeGreaterThan(0);
    expect(winnerDelta).toBeLessThan(32 / 6);
  });

  it("awards more points for an upset win against a much higher-rated team", () => {
    const players = [
      player("a1", 0, "A"),
      player("a2", 0, "A"),
      player("a3", 0, "A"),
      player("b1", 800, "B"),
      player("b2", 800, "B"),
      player("b3", 800, "B"),
    ];
    const results = computeEloDeltas(players, "A", config);
    const upsetDelta = results.find((r) => r.playerId === "a1")!.delta;
    expect(upsetDelta).toBeGreaterThan(32 / 6);
  });

  it("applies the provisional K multiplier per-player, independent of teammates' status", () => {
    const players = [
      player("provisional", 0, "A", 3), // under provisionalGames=10 -> elevated K
      player("established1", 0, "A", 50),
      player("established2", 0, "A", 50),
      player("b1", 0, "B"),
      player("b2", 0, "B"),
      player("b3", 0, "B"),
    ];
    const results = computeEloDeltas(players, "A", config);

    const provisional = results.find((r) => r.playerId === "provisional")!;
    const established = results.find((r) => r.playerId === "established1")!;

    expect(provisional.wasProvisional).toBe(true);
    expect(established.wasProvisional).toBe(false);
    expect(provisional.delta).toBeCloseTo(established.delta * config.provisionalKMultiplier, 10);
  });

  it("treats a player with exactly provisionalGames prior games as no longer provisional", () => {
    const players = [
      player("edge", 0, "A", 10),
      player("a2", 0, "A"),
      player("a3", 0, "A"),
      player("b1", 0, "B"),
      player("b2", 0, "B"),
      player("b3", 0, "B"),
    ];
    const results = computeEloDeltas(players, "A", config);
    expect(results.find((r) => r.playerId === "edge")!.wasProvisional).toBe(false);
  });

  it("newMmr reflects mmr + delta", () => {
    const players = [
      player("a1", 100, "A"),
      player("a2", 100, "A"),
      player("a3", 100, "A"),
      player("b1", 50, "B"),
      player("b2", 50, "B"),
      player("b3", 50, "B"),
    ];
    const results = computeEloDeltas(players, "A", config);
    for (const r of results) {
      const original = players.find((p) => p.playerId === r.playerId)!.mmr;
      expect(r.newMmr).toBeCloseTo(original + r.delta, 10);
    }
  });
});

describe("computeEloDeltas — skew factor", () => {
  it("with skewFactor=0 (default/omitted), behaves identically to plain baseline Elo", () => {
    const players = [
      player("a1", -300, "A"),
      player("a2", -300, "A"),
      player("a3", -300, "A"),
      player("b1", 100, "B"),
      player("b2", 100, "B"),
      player("b3", 100, "B"),
    ];
    const withZero = computeEloDeltas(players, "B", { ...config, skewFactor: 0 });
    const omitted = computeEloDeltas(players, "B", config);
    for (let i = 0; i < withZero.length; i++) {
      expect(withZero[i].delta).toBeCloseTo(omitted[i].delta, 10);
    }
  });

  it("dampens a negative-MMR player's loss (pushed further negative) but not their win (pulled toward 0)", () => {
    const skewConfig: EloConfig = { ...config, skewFactor: 0.5 };
    const losing = [
      player("a1", -300, "A"),
      player("a2", 0, "A"),
      player("a3", 0, "A"),
      player("b1", 0, "B"),
      player("b2", 0, "B"),
      player("b3", 0, "B"),
    ];
    const lossResult = computeEloDeltas(losing, "B", skewConfig).find((r) => r.playerId === "a1")!;
    const plainLossDelta = computeEloDeltas(losing, "B", config).find((r) => r.playerId === "a1")!.delta;
    expect(lossResult.delta).toBeGreaterThan(plainLossDelta); // shrunk toward 0, i.e. less negative

    const winning = [
      player("a1", -300, "A"),
      player("a2", 0, "A"),
      player("a3", 0, "A"),
      player("b1", 0, "B"),
      player("b2", 0, "B"),
      player("b3", 0, "B"),
    ];
    const winResult = computeEloDeltas(winning, "A", skewConfig).find((r) => r.playerId === "a1")!;
    const plainWinDelta = computeEloDeltas(winning, "A", config).find((r) => r.playerId === "a1")!.delta;
    expect(winResult.delta).toBeCloseTo(plainWinDelta, 10); // untouched — pulls back toward 0
  });

  it("mirrors dampening onto the positive side for a negative skewFactor", () => {
    const skewConfig: EloConfig = { ...config, skewFactor: -0.5 };
    const players = [
      player("a1", 300, "A"),
      player("a2", 0, "A"),
      player("a3", 0, "A"),
      player("b1", 0, "B"),
      player("b2", 0, "B"),
      player("b3", 0, "B"),
    ];
    const winResult = computeEloDeltas(players, "A", skewConfig).find((r) => r.playerId === "a1")!;
    const plainWinDelta = computeEloDeltas(players, "A", config).find((r) => r.playerId === "a1")!.delta;
    expect(winResult.delta).toBeGreaterThan(0);
    expect(winResult.delta).toBeLessThan(plainWinDelta); // win pushed further positive -> dampened
  });
});

describe("computeEloDeltas — confidence multiplier", () => {
  it("with confidenceMultiplier=1 (default/omitted), behaves identically to plain baseline Elo", () => {
    const players = [
      player("a1", 300, "A"),
      player("a2", 0, "A"),
      player("a3", 0, "A"),
      player("b1", 0, "B"),
      player("b2", 0, "B"),
      player("b3", 0, "B"),
    ];
    const withOne = computeEloDeltas(players, "A", { ...config, confidenceMultiplier: 1 });
    const omitted = computeEloDeltas(players, "A", config);
    for (let i = 0; i < withOne.length; i++) {
      expect(withOne[i].delta).toBeCloseTo(omitted[i].delta, 10);
      expect(withOne[i].expected).toBeCloseTo(omitted[i].expected, 10);
    }
  });

  it("above 1, sharpens the expected score and shrinks the favorite's win delta", () => {
    const players = [
      player("a1", 300, "A"),
      player("a2", 0, "A"),
      player("a3", 0, "A"),
      player("b1", 0, "B"),
      player("b2", 0, "B"),
      player("b3", 0, "B"),
    ];
    const boosted = computeEloDeltas(players, "A", { ...config, confidenceMultiplier: 2 });
    const plain = computeEloDeltas(players, "A", config);
    const boostedWinner = boosted.find((r) => r.playerId === "a1")!;
    const plainWinner = plain.find((r) => r.playerId === "a1")!;
    expect(boostedWinner.expected).toBeGreaterThan(plainWinner.expected);
    expect(boostedWinner.delta).toBeLessThan(plainWinner.delta);
    expect(boostedWinner.delta).toBeGreaterThan(0);
  });
});

describe("computeEloDeltas — min delta floor", () => {
  it("with minDeltaFloor=0 (default/omitted), behaves identically to plain baseline Elo", () => {
    const players = [
      player("a1", 0, "A"),
      player("a2", 0, "A"),
      player("a3", 0, "A"),
      player("b1", 0, "B"),
      player("b2", 0, "B"),
      player("b3", 0, "B"),
    ];
    const withZero = computeEloDeltas(players, "A", { ...config, minDeltaFloor: 0 });
    const omitted = computeEloDeltas(players, "A", config);
    for (let i = 0; i < withZero.length; i++) {
      expect(withZero[i].delta).toBeCloseTo(omitted[i].delta, 10);
    }
  });

  it("pushes every nonzero delta further from 0 by the floor amount, in the same direction", () => {
    const players = [
      player("a1", 0, "A"),
      player("a2", 0, "A"),
      player("a3", 0, "A"),
      player("b1", 0, "B"),
      player("b2", 0, "B"),
      player("b3", 0, "B"),
    ];
    const plain = computeEloDeltas(players, "A", config);
    const floored = computeEloDeltas(players, "A", { ...config, minDeltaFloor: 2 });
    for (let i = 0; i < plain.length; i++) {
      const expectedDelta = plain[i].delta + Math.sign(plain[i].delta) * 2;
      expect(floored[i].delta).toBeCloseTo(expectedDelta, 10);
    }
    const winner = floored.find((r) => r.playerId === "a1")!;
    const loser = floored.find((r) => r.playerId === "b1")!;
    expect(winner.delta).toBeCloseTo(32 / 6 + 2, 10);
    expect(loser.delta).toBeCloseTo(-32 / 6 - 2, 10);
  });
});

describe("computeEloDeltas — series length multiplier", () => {
  it("with seriesLengthMultiplier=1 (default/omitted), behaves identically to plain baseline Elo", () => {
    const players = [
      player("a1", 0, "A"),
      player("a2", 0, "A"),
      player("a3", 0, "A"),
      player("b1", 0, "B"),
      player("b2", 0, "B"),
      player("b3", 0, "B"),
    ];
    const withOne = computeEloDeltas(players, "A", { ...config, seriesLengthMultiplier: 1 });
    const omitted = computeEloDeltas(players, "A", config);
    for (let i = 0; i < withOne.length; i++) {
      expect(withOne[i].delta).toBeCloseTo(omitted[i].delta, 10);
    }
  });

  it("scales the fully-formed delta, floor included — not just the K-scaled earned component", () => {
    const players = [
      player("a1", 900, "A"),
      player("a2", 900, "A"),
      player("a3", 900, "A"),
      player("b1", 0, "B"),
      player("b2", 0, "B"),
      player("b3", 0, "B"),
    ];
    const floorConfig: EloConfig = { ...config, minDeltaFloor: 2 };
    const plain = computeEloDeltas(players, "A", floorConfig);
    const bo3 = computeEloDeltas(players, "A", { ...floorConfig, seriesLengthMultiplier: 0.6 });
    const bo7 = computeEloDeltas(players, "A", { ...floorConfig, seriesLengthMultiplier: 1.4 });
    for (let i = 0; i < plain.length; i++) {
      expect(bo3[i].delta).toBeCloseTo(plain[i].delta * 0.6, 10);
      expect(bo7[i].delta).toBeCloseTo(plain[i].delta * 1.4, 10);
    }
    // BO7's win is more than double BO3's, even though the heavy favorite's plain "earned"
    // component (before the flat floor) is tiny — proving the floor itself got scaled too.
    const bo3Winner = bo3.find((r) => r.playerId === "a1")!;
    const bo7Winner = bo7.find((r) => r.playerId === "a1")!;
    expect(bo7Winner.delta).toBeGreaterThan(bo3Winner.delta * 2);
  });
});

describe("computeStreakBonus", () => {
  it("is 0 below a 3-game prior streak, at any expected value", () => {
    expect(computeStreakBonus(0, 0.5)).toBe(0);
    expect(computeStreakBonus(1, 0.5)).toBe(0);
    expect(computeStreakBonus(2, 0.5)).toBe(0);
  });

  it("ramps +1 per game starting at a 3-game prior streak, unscaled at expected<=0.5", () => {
    expect(computeStreakBonus(3, 0.5)).toBe(1);
    expect(computeStreakBonus(4, 0.5)).toBe(2);
    expect(computeStreakBonus(4, 0.2)).toBe(2);
  });

  it("caps at +5, unscaled at expected<=0.5", () => {
    expect(computeStreakBonus(7, 0.5)).toBe(5);
    expect(computeStreakBonus(12, 0.1)).toBe(5);
  });

  it("tapers linearly to 0 as expected approaches 1", () => {
    expect(computeStreakBonus(7, 0.75)).toBeCloseTo(2.5, 10);
    expect(computeStreakBonus(7, 0.9)).toBeCloseTo(1, 10);
    expect(computeStreakBonus(7, 1)).toBe(0);
  });
});
