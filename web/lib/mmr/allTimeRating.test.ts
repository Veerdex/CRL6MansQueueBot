import { describe, expect, it } from "vitest";
import { allTimeSeasonScore, seasonScoresByPlayerId } from "./allTimeRating";

describe("allTimeSeasonScore", () => {
  it("pays first place exactly 100 at every field size", () => {
    for (const n of [2, 3, 4, 8, 12, 20, 40, 60, 100, 501]) {
      expect(allTimeSeasonScore(1, n)).toBeCloseTo(100, 10);
    }
  });

  it("pays last place exactly 1, so the whole placed pool earns", () => {
    // b = 1 lands on dead last now that the curve is evaluated over a doubled field: r = N/2 = n.
    // This is the property the doubling exists for, and the only thing keeping last place above
    // the sub-1-point floor, so it is asserted across the range rather than at one field size.
    for (const n of [2, 3, 8, 12, 20, 40, 60, 100, 501]) {
      expect(allTimeSeasonScore(n, n)).toBeCloseTo(1, 10);
      expect(allTimeSeasonScore(n, n)).toBeGreaterThan(0);
    }
    // Nobody in the field scores zero, including the places that used to be the dead bottom half.
    for (const n of [8, 40]) {
      for (let r = 1; r <= n; r++) expect(allTimeSeasonScore(r, n)).toBeGreaterThan(0);
    }
  });

  it("matches the reference curve mid-table", () => {
    expect(allTimeSeasonScore(2, 8)).toBeCloseTo(79.5201, 3);
    expect(allTimeSeasonScore(3, 12)).toBeCloseTo(66.2972, 3);
    expect(allTimeSeasonScore(5, 40)).toBeCloseTo(58.8255, 3);
    expect(allTimeSeasonScore(9, 20)).toBeCloseTo(22.3054, 3);
  });

  it("is the old half-field curve evaluated on twice the field", () => {
    // The substitution that made every placement earn: scoring n players is exactly scoring the
    // top half of a 2n-player standing on the pre-change curve. Pins the shape, not just endpoints.
    const oldCurve = (rank: number, n: number) => {
      const half = n / 2 - 1;
      const b = (rank - 1) / half;
      const k = 16.1045061696 * Math.pow(38 / (n - 2), 0.25);
      const a = (100 * Math.log(100)) / (k * half);
      return Math.pow(100, 1 - b / (a + (1 - a) * b));
    };
    for (const n of [8, 13, 20, 44]) {
      for (let r = 1; r <= n; r++) {
        expect(allTimeSeasonScore(r, n)).toBeCloseTo(oldCurve(r, 2 * n), 9);
      }
    }
  });

  it("decreases monotonically down the standing and never goes negative", () => {
    for (const n of [5, 8, 13, 20, 41, 60]) {
      for (let r = 2; r <= n; r++) {
        const prev = allTimeSeasonScore(r - 1, n);
        const cur = allTimeSeasonScore(r, n);
        expect(cur).toBeGreaterThan(0);
        expect(cur).toBeLessThan(prev);
      }
    }
  });

  it("pays a bigger pool, spread over more places, as the field grows", () => {
    const pool = (n: number) => {
      let total = 0;
      for (let r = 1; r <= n; r++) total += allTimeSeasonScore(r, n);
      return total;
    };
    expect(pool(8)).toBeGreaterThan(300);
    expect(pool(40)).toBeGreaterThan(pool(20));
    expect(pool(20)).toBeGreaterThan(pool(8));
  });

  it("pays nothing for degenerate field sizes or out-of-range placements", () => {
    expect(allTimeSeasonScore(1, 1)).toBe(0); // doubled field of 2: N/2 - 1 and N - 2 both zero
    expect(allTimeSeasonScore(1, 0)).toBe(0);
    expect(allTimeSeasonScore(0, 20)).toBe(0);
    expect(allTimeSeasonScore(21, 20)).toBe(0); // past the real field, not the doubled one
    expect(allTimeSeasonScore(40, 20)).toBe(0);
    expect(allTimeSeasonScore(Number.NaN, 20)).toBe(0);
  });
});

describe("seasonScoresByPlayerId", () => {
  const standing = (flags: boolean[]) => flags.map((isPlaced, i) => ({ id: `p${i + 1}`, isPlaced }));

  it("densely re-ranks over the placed pool, ignoring where unplaced players finished", () => {
    // 8 placed players scattered through a 10-player standing: the two unplaced finishers must not
    // consume a placement or inflate the field, so the result has to equal a clean 8-player
    // standing.
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
