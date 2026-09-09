import { describe, expect, it } from "vitest";
import { computeEloDeltas, computeStreakMultiplier, type EloConfig, type EloPlayerInput } from "./elo";

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

describe("computeStreakMultiplier", () => {
  it("pays nothing on the first two wins of a run, at any expected value", () => {
    // priorStreak is the count *before* this game, so 0 is a player's first win and 1 their second.
    expect(computeStreakMultiplier(0, 0.5, 1.5)).toBe(1);
    expect(computeStreakMultiplier(1, 0.2, 1.5)).toBe(1);
  });

  it("ramps one fifth of the way to the ceiling per game from the third win on", () => {
    expect(computeStreakMultiplier(2, 0.5, 1.5)).toBeCloseTo(1.1, 10);
    expect(computeStreakMultiplier(3, 0.5, 1.5)).toBeCloseTo(1.2, 10);
    expect(computeStreakMultiplier(4, 0.5, 1.5)).toBeCloseTo(1.3, 10);
    expect(computeStreakMultiplier(5, 0.5, 1.5)).toBeCloseTo(1.4, 10);
  });

  it("caps at the ceiling from the seventh win on, and stays there for an underdog", () => {
    expect(computeStreakMultiplier(6, 0.5, 1.5)).toBeCloseTo(1.5, 10);
    expect(computeStreakMultiplier(7, 0.5, 1.5)).toBeCloseTo(1.5, 10);
    expect(computeStreakMultiplier(12, 0.5, 1.5)).toBeCloseTo(1.5, 10);
    // expected < 0.5 is an underdog win — the taper is clamped at 1, never above it, so a long
    // streak is worth the same 1.5x whether the win was a coin flip or an upset.
    expect(computeStreakMultiplier(12, 0.1, 1.5)).toBeCloseTo(1.5, 10);
  });

  it("tapers back toward 1x as the win becomes a foregone conclusion", () => {
    expect(computeStreakMultiplier(7, 0.75, 1.5)).toBeCloseTo(1.25, 10);
    expect(computeStreakMultiplier(7, 0.9, 1.5)).toBeCloseTo(1.1, 10);
    expect(computeStreakMultiplier(7, 1, 1.5)).toBe(1);
  });

  it("honours a non-default ceiling, and 1 disables it entirely", () => {
    expect(computeStreakMultiplier(6, 0.5, 2)).toBeCloseTo(2, 10);
    expect(computeStreakMultiplier(2, 0.5, 2)).toBeCloseTo(1.2, 10);
    expect(computeStreakMultiplier(12, 0.5, 1)).toBe(1);
  });
});

describe("computeEloDeltas — win-streak multiplier", () => {
  // Two identical teams, so expected is exactly 0.5 and the taper is exactly 1 — every number
  // below is the multiplier's full effect with nothing else moving.
  const even = (streak: number): EloPlayerInput[] => [
    { playerId: "a1", mmr: 100, team: "A", priorRankGamesPlayed: 20, priorRankWinStreak: streak },
    { playerId: "a2", mmr: 100, team: "A", priorRankGamesPlayed: 20 },
    { playerId: "a3", mmr: 100, team: "A", priorRankGamesPlayed: 20 },
    { playerId: "b1", mmr: 100, team: "B", priorRankGamesPlayed: 20, priorRankWinStreak: streak },
    { playerId: "b2", mmr: 100, team: "B", priorRankGamesPlayed: 20 },
    { playerId: "b3", mmr: 100, team: "B", priorRankGamesPlayed: 20 },
  ];
  const streakConfig: EloConfig = { ...config, minDeltaFloor: 2, streakMaxMultiplier: 1.5 };

  it("scales the earned Elo term but never the flat minDeltaFloor", () => {
    const plain = computeEloDeltas(even(0), "A", streakConfig).find((r) => r.playerId === "a1")!;
    const streaked = computeEloDeltas(even(7), "A", streakConfig).find((r) => r.playerId === "a1")!;
    // 32 * 0.5 / 3 = 5.3333 earned, + 2.0 floor.
    expect(plain.delta).toBeCloseTo(7.33333, 4);
    // Earned term 1.5x'd to 8.0, floor still a flat +2 rather than 1.5x'd to 3.
    expect(streaked.delta).toBeCloseTo(10, 4);
    expect(streaked.streakMultiplier).toBeCloseTo(1.5, 10);
    expect(plain.streakMultiplier).toBe(1);
  });

  it("is worth the same percentage at every series length", () => {
    // The regression this rewrite exists for: as a flat +bonus added AFTER
    // seriesLengthMultiplier, an identical streak was worth ~125% of a BO3 delta but only ~54%
    // of a BO7's. As a multiplier inside it, the ratio is length-invariant.
    const ratioAt = (seriesLengthMultiplier: number) => {
      const cfg = { ...streakConfig, seriesLengthMultiplier };
      const plain = computeEloDeltas(even(0), "A", cfg).find((r) => r.playerId === "a1")!;
      const streaked = computeEloDeltas(even(7), "A", cfg).find((r) => r.playerId === "a1")!;
      return streaked.delta / plain.delta;
    };
    expect(ratioAt(0.6)).toBeCloseTo(ratioAt(1), 10);
    expect(ratioAt(1.4)).toBeCloseTo(ratioAt(1), 10);
  });

  it("never applies to a loser, however long their streak", () => {
    const results = computeEloDeltas(even(12), "A", streakConfig);
    const loser = results.find((r) => r.playerId === "b1")!;
    const plainLoser = computeEloDeltas(even(0), "A", streakConfig).find((r) => r.playerId === "b1")!;
    expect(loser.streakMultiplier).toBe(1);
    expect(loser.delta).toBeCloseTo(plainLoser.delta, 10);
    expect(loser.delta).toBeLessThan(0);
  });

  it("defaults to a no-op when streakMaxMultiplier is omitted", () => {
    const results = computeEloDeltas(even(12), "A", { ...config, minDeltaFloor: 2 });
    const winner = results.find((r) => r.playerId === "a1")!;
    expect(winner.streakMultiplier).toBe(1);
    expect(winner.delta).toBeCloseTo(7.33333, 4);
  });
});
