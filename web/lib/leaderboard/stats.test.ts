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
    game({ seriesId: "1", seasonId: "s1" }),
    game({ seriesId: "2", seasonId: "s1" }),
    game({ seriesId: "3", seasonId: "s2" }),
  ];

  it("returns all games with no filter", () => {
    expect(filterGames(games, {})).toHaveLength(3);
  });

  it("filters by seasonId", () => {
    const result = filterGames(games, { seasonId: "s1" });
    expect(result.map((g) => g.seriesId)).toEqual(["1", "2"]);
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

  describe("currentSeasonId (season-boundary reset)", () => {
    // Regression case: a player ("Tony") who ended last season on a 9-game win streak and
    // hasn't played since must show a 0 current streak on the All-Time Stats board, not a stale
    // one bridging into a season that's since closed.
    it("zeroes the current streak when the player's last game predates the current season", () => {
      const games = Array.from({ length: 9 }, () => game({ seasonId: "season1", won: true }));
      expect(computeStats(games, "season2").currentStreak).toEqual({ type: null, count: 0 });
      // longestWinStreak is a lifetime record and must be unaffected.
      expect(computeStats(games, "season2").longestWinStreak).toBe(9);
    });

    it("does not let a streak bridge from a prior season into the current one", () => {
      const games = [
        ...[true, true, true].map((won) => game({ seasonId: "season1", won })),
        ...[true, true].map((won) => game({ seasonId: "season2", won })),
      ];
      // Without the season boundary this would read 5 (bridging both seasons' win runs).
      expect(computeStats(games, "season2").currentStreak).toEqual({ type: "W", count: 2 });
    });

    it("still lets a streak span multiple games within the same current season", () => {
      const games = [true, true, true].map((won) => game({ seasonId: "season2", won }));
      expect(computeStats(games, "season2").currentStreak).toEqual({ type: "W", count: 3 });
    });

    it("without currentSeasonId, keeps the old unrestricted (bridging) behavior", () => {
      const games = [
        ...[true, true, true].map((won) => game({ seasonId: "season1", won })),
        ...[true, true].map((won) => game({ seasonId: "season2", won })),
      ];
      expect(computeStats(games).currentStreak).toEqual({ type: "W", count: 5 });
    });
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
