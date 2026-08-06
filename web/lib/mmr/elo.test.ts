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

describe("computeStreakBonus", () => {
  it("is 0 below a 3-game prior streak", () => {
    expect(computeStreakBonus(0)).toBe(0);
    expect(computeStreakBonus(1)).toBe(0);
    expect(computeStreakBonus(2)).toBe(0);
  });

  it("ramps +1 per game starting at a 3-game prior streak", () => {
    expect(computeStreakBonus(3)).toBe(1);
    expect(computeStreakBonus(4)).toBe(2);
  });

  it("caps at +5", () => {
    expect(computeStreakBonus(7)).toBe(5);
    expect(computeStreakBonus(12)).toBe(5);
  });
});
