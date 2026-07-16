import { describe, expect, it } from "vitest";
import { bandRank, computeStats, filterGames } from "./stats";
import type { CompletedGame } from "./queries";

function game(overrides: Partial<CompletedGame> = {}): CompletedGame {
  return {
    seriesId: "s1",
    seasonId: "season1",
    queueType: "rank",
    playedAt: "2026-01-01T00:00:00Z",
    team: "A",
    won: true,
    ...overrides,
  };
}

describe("filterGames", () => {
  const games = [
    game({ seriesId: "1", seasonId: "s1", queueType: "rank" }),
    game({ seriesId: "2", seasonId: "s1", queueType: "universal" }),
    game({ seriesId: "3", seasonId: "s2", queueType: "rank" }),
  ];

  it("returns all games with no filter", () => {
    expect(filterGames(games, {})).toHaveLength(3);
  });

  it("filters by seasonId", () => {
    const result = filterGames(games, { seasonId: "s1" });
    expect(result.map((g) => g.seriesId)).toEqual(["1", "2"]);
  });

  it("filters by queueType", () => {
    const result = filterGames(games, { queueType: "rank" });
    expect(result.map((g) => g.seriesId)).toEqual(["1", "3"]);
  });

  it("treats queueType 'all' as no filter", () => {
    expect(filterGames(games, { queueType: "all" })).toHaveLength(3);
  });

  it("combines seasonId and queueType filters", () => {
    const result = filterGames(games, { seasonId: "s1", queueType: "rank" });
    expect(result.map((g) => g.seriesId)).toEqual(["1"]);
  });
});

describe("computeStats", () => {
  it("returns null win rate and zeroed stats for no games", () => {
    const stats = computeStats([]);
    expect(stats).toEqual({
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      winRate: null,
      currentStreak: { type: null, count: 0 },
      longestWinStreak: 0,
    });
  });

  it("counts wins, losses, and win rate", () => {
    const games = [game({ won: true }), game({ won: true }), game({ won: false })];
    const stats = computeStats(games);
    expect(stats.gamesPlayed).toBe(3);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(1);
    expect(stats.winRate).toBeCloseTo(2 / 3, 10);
  });

  it("tracks the longest win streak across non-consecutive runs", () => {
    // W W L W W W L W -> longest is 3
    const results = [true, true, false, true, true, true, false, true];
    const games = results.map((won) => game({ won }));
    expect(computeStats(games).longestWinStreak).toBe(3);
  });

  it("reports the current streak as the trailing run, win or loss", () => {
    const winStreak = [true, false, true, true, true].map((won) => game({ won }));
    expect(computeStats(winStreak).currentStreak).toEqual({ type: "W", count: 3 });

    const lossStreak = [true, true, false, false].map((won) => game({ won }));
    expect(computeStats(lossStreak).currentStreak).toEqual({ type: "L", count: 2 });
  });

  it("current streak of a single game matches its result", () => {
    expect(computeStats([game({ won: true })]).currentStreak).toEqual({ type: "W", count: 1 });
    expect(computeStats([game({ won: false })]).currentStreak).toEqual({ type: "L", count: 1 });
  });
});

describe("bandRank", () => {
  it("orders bands Iron < Garnet < Emerald < Sapphire", () => {
    expect(bandRank("Iron")).toBeLessThan(bandRank("Garnet"));
    expect(bandRank("Garnet")).toBeLessThan(bandRank("Emerald"));
    expect(bandRank("Emerald")).toBeLessThan(bandRank("Sapphire"));
  });

  it("ranks null (unplaced) below every real band", () => {
    expect(bandRank(null)).toBeLessThan(bandRank("Iron"));
  });
});
