import { describe, expect, it } from "vitest";
import { allTimeSeasonScore, seasonScoresByPlayerId } from "./allTimeRating";

describe("allTimeSeasonScore", () => {
  it("pays first place exactly 100 at every field size", () => {
    for (const n of [3, 4, 8, 12, 20, 40, 60, 100, 501]) {
      expect(allTimeSeasonScore(1, n)).toBeCloseTo(100, 10);
    }
  });

  it("pays exactly 1 at the halfway place and nothing below it", () => {
    // b = 1 exactly at r = N/2, where the curve is 100^0 = 1 — the last earning place.
    expect(allTimeSeasonScore(4, 8)).toBeCloseTo(1, 10);
    expect(allTimeSeasonScore(5, 8)).toBe(0);
    expect(allTimeSeasonScore(8, 8)).toBe(0);
    expect(allTimeSeasonScore(20, 40)).toBeCloseTo(1, 10);
    expect(allTimeSeasonScore(21, 40)).toBe(0);
  });

  it("matches the reference curve mid-table", () => {
    expect(allTimeSeasonScore(2, 8)).toBeCloseTo(70.2030, 3);
    expect(allTimeSeasonScore(3, 12)).toBeCloseTo(52.4877, 3);
    expect(allTimeSeasonScore(5, 40)).toBeCloseTo(50, 6); // exact midpoint of the N=40 curve
    expect(allTimeSeasonScore(9, 20)).toBeCloseTo(3.1308, 3);
  });

  it("decreases monotonically down the standing and never goes negative", () => {
    for (const n of [5, 8, 13, 20, 41, 60]) {
      for (let r = 2; r <= n; r++) {
        const prev = allTimeSeasonScore(r - 1, n);
        const cur = allTimeSeasonScore(r, n);
        expect(cur).toBeGreaterThanOrEqual(0);
        // Strictly decreasing while anyone is still earning, then flat at 0 for the bottom half.
        if (prev > 0) expect(cur).toBeLessThan(prev);
        else expect(cur).toBe(0);
      }
    }
  });

  it("pays a bigger pool, spread over more places, as the field grows", () => {
    const pool = (n: number) => {
      let total = 0;
      for (let r = 1; r <= n; r++) total += allTimeSeasonScore(r, n);
      return total;
    };
    expect(pool(8)).toBeGreaterThan(200);
    expect(pool(40)).toBeGreaterThan(pool(20));
    expect(pool(20)).toBeGreaterThan(pool(8));
  });

  it("pays nothing for degenerate field sizes or out-of-range placements", () => {
    expect(allTimeSeasonScore(1, 2)).toBe(0); // N/2 - 1 and N - 2 both zero
    expect(allTimeSeasonScore(1, 1)).toBe(0);
    expect(allTimeSeasonScore(1, 0)).toBe(0);
    expect(allTimeSeasonScore(0, 20)).toBe(0);
    expect(allTimeSeasonScore(21, 20)).toBe(0);
    expect(allTimeSeasonScore(Number.NaN, 20)).toBe(0);
  });
});

describe("seasonScoresByPlayerId", () => {
  const standing = (flags: boolean[]) => flags.map((isPlaced, i) => ({ id: `p${i + 1}`, isPlaced }));

  it("densely re-ranks over the placed pool, ignoring where unplaced players finished", () => {
    // 8 placed players scattered through a 10-player standing: the two unplaced finishers must not
    // consume a placement or inflate N, so the result has to equal a clean 8-player standing.
    const mixed = seasonScoresByPlayerId(
      standing([true, false, true, true, true, false, true, true, true, true]),
    );
    const clean = [1, 3, 4, 5, 7, 8, 9, 10].map((n) => `p${n}`);
    expect(mixed.size).toBe(8);
    clean.forEach((id, index) => {
      expect(mixed.get(id)).toBeCloseTo(allTimeSeasonScore(index + 1, 8), 10);
    });
    expect(mixed.has("p2")).toBe(false);
    expect(mixed.has("p6")).toBe(false);
  });

  it("returns an empty map when nobody placed", () => {
    expect(seasonScoresByPlayerId(standing([false, false, false])).size).toBe(0);
    expect(seasonScoresByPlayerId([]).size).toBe(0);
  });
});
