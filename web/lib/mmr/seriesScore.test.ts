import { describe, expect, it } from "vitest";
import { computeScoreMarginMultiplier, flippedSeriesResult, formatSeriesResult, sameSeriesResult, seriesGameCount, seriesResultMultiplier, seriesScoreChanged, validateSeriesScore, type SeriesResult } from "./seriesScore";

describe("computeScoreMarginMultiplier", () => {
  it("pays a sweep more than 1x at every length", () => {
    expect(computeScoreMarginMultiplier(3, 2, 0)).toBeCloseTo(1.1786, 4);
    expect(computeScoreMarginMultiplier(5, 3, 0)).toBeCloseTo(1.2976, 4);
    expect(computeScoreMarginMultiplier(7, 4, 0)).toBeCloseTo(1 + 0.5 / 1.2, 10);
  });

  it("matches the agreed table for closer series", () => {
    expect(computeScoreMarginMultiplier(3, 2, 1)).toBeCloseTo(0.9571, 4);
    expect(computeScoreMarginMultiplier(5, 3, 1)).toBeCloseTo(1.0595, 4);
    expect(computeScoreMarginMultiplier(5, 3, 2)).toBeCloseTo(0.7857, 4);
    expect(computeScoreMarginMultiplier(7, 4, 1)).toBeCloseTo(1.1667, 4);
    expect(computeScoreMarginMultiplier(7, 4, 2)).toBeCloseTo(0.9, 10);
    expect(computeScoreMarginMultiplier(7, 4, 3)).toBeCloseTo(0.6, 10);
  });

  it("damps only the part above 1x by 1.2 and leaves sub-1x scores untouched", () => {
    // Raw BO7 4-0 is 1.5x -> 1 + 0.5/1.2; raw BO7 4-2 is 0.9x and stays 0.9x.
    expect(computeScoreMarginMultiplier(7, 4, 0)).toBeCloseTo(1 + 0.5 / 1.2, 10);
    expect(computeScoreMarginMultiplier(7, 4, 2)).toBeCloseTo(0.9, 10);
  });

  it("depends only on the margin, so a corrected (flipped) score keeps the same multiplier", () => {
    expect(computeScoreMarginMultiplier(5, 3, 1)).toBe(computeScoreMarginMultiplier(5, 1, 3));
  });
});

describe("validateSeriesScore", () => {
  it("treats a null series length as a Best of 5", () => {
    expect(seriesGameCount(null)).toBe(5);
    expect(validateSeriesScore(3, 2, null)).toEqual({ ok: true, reporterWon: true, winnerGames: 3, loserGames: 2 });
    expect(validateSeriesScore(2, 1, null).ok).toBe(false);
  });

  it("derives the winner from either side's perspective", () => {
    expect(validateSeriesScore(1, 4, "bo7")).toEqual({ ok: true, reporterWon: false, winnerGames: 4, loserGames: 1 });
    expect(validateSeriesScore(2, 0, "bo3")).toEqual({ ok: true, reporterWon: true, winnerGames: 2, loserGames: 0 });
  });

  it("rejects ties, unfinished, impossible and non-integer scores", () => {
    expect(validateSeriesScore(2, 2, "bo3").ok).toBe(false);
    expect(validateSeriesScore(3, 3, "bo5").ok).toBe(false);
    expect(validateSeriesScore(2, 1, "bo5").ok).toBe(false);
    expect(validateSeriesScore(3, 2, "bo3").ok).toBe(false);
    expect(validateSeriesScore(4, 3, "bo5").ok).toBe(false);
    expect(validateSeriesScore(-1, 3, "bo5").ok).toBe(false);
    expect(validateSeriesScore(3, 1.5, "bo5").ok).toBe(false);
  });
});

describe("series results (corrections)", () => {
  const scored: SeriesResult = { winner: "A", winnerGames: 3, loserGames: 1 };
  const unscored: SeriesResult = { winner: "A", winnerGames: null, loserGames: null };

  it("a flip keeps the margin, and so the multiplier", () => {
    expect(flippedSeriesResult(scored)).toEqual({ winner: "B", winnerGames: 3, loserGames: 1 });
    expect(seriesResultMultiplier(flippedSeriesResult(scored), "bo5")).toBe(seriesResultMultiplier(scored, "bo5"));
    expect(flippedSeriesResult(unscored)).toEqual({ winner: "B", winnerGames: null, loserGames: null });
  });

  it("treats winner and score together as the identity of a result", () => {
    expect(sameSeriesResult(scored, { winner: "A", winnerGames: 3, loserGames: 1 })).toBe(true);
    expect(sameSeriesResult(scored, { winner: "A", winnerGames: 3, loserGames: 2 })).toBe(false);
    expect(sameSeriesResult(scored, { winner: "B", winnerGames: 3, loserGames: 1 })).toBe(false);
    expect(sameSeriesResult(scored, unscored)).toBe(false);
  });

  it("is 1x with no score, and the margin formula with one", () => {
    expect(seriesResultMultiplier(unscored, "bo7")).toBe(1);
    expect(seriesResultMultiplier({ winner: "B", winnerGames: 4, loserGames: 3 }, "bo7")).toBeCloseTo(0.6, 10);
    expect(seriesResultMultiplier({ winner: "B", winnerGames: 3, loserGames: 2 }, null)).toBeCloseTo(0.7857, 4);
  });

  it("formats with and without a score", () => {
    expect(formatSeriesResult({ winner: "B", winnerGames: 3, loserGames: 2 })).toBe("Team B 3–2");
    expect(formatSeriesResult(unscored)).toBe("Team A");
  });
});

describe("seriesScoreChanged", () => {
  it("is false for a flip, which keeps the report-time multiplier", () => {
    const scored: SeriesResult = { winner: "A", winnerGames: 3, loserGames: 1 };
    expect(seriesScoreChanged(scored, flippedSeriesResult(scored))).toBe(false);
    const unscored: SeriesResult = { winner: "A", winnerGames: null, loserGames: null };
    expect(seriesScoreChanged(unscored, flippedSeriesResult(unscored))).toBe(false);
  });

  it("is true when the score itself changes, winner or not", () => {
    expect(seriesScoreChanged({ winner: "A", winnerGames: 3, loserGames: 0 }, { winner: "A", winnerGames: 3, loserGames: 2 })).toBe(true);
    expect(seriesScoreChanged({ winner: "A", winnerGames: null, loserGames: null }, { winner: "A", winnerGames: 3, loserGames: 2 })).toBe(true);
  });
});
