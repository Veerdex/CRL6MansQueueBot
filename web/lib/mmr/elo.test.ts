import { describe, expect, it } from "vitest";
import { computeEloDeltas, type EloConfig, type EloPlayerInput } from "./elo";

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
