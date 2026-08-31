import { describe, expect, it } from "vitest";
import { computeSafeMedian, decayMmr } from "./seasonClose";

describe("computeSafeMedian", () => {
  it("matches a plain median when the whole pool is already non-negative", () => {
    expect(computeSafeMedian([0, 10, 20, 30])).toBe(15);
    expect(computeSafeMedian([5, 15, 25])).toBe(15);
  });

  it("shifts the pool so the median is always non-negative, without discarding relative spacing", () => {
    // min is -30, so everything shifts up by 30 before the median is taken.
    const median = computeSafeMedian([-30, -10, 10, 30]);
    expect(median).toBe(30); // shifted: [0, 20, 40, 60] -> median (20+40)/2 = 30
    expect(median).toBeGreaterThan(0);
  });

  it("stays non-negative even when the pool is majority-negative", () => {
    const median = computeSafeMedian([-90, -80, -70, -10, 5, 10]);
    expect(median).toBeGreaterThanOrEqual(0);
  });
});

describe("decayMmr", () => {
  it("is continuous at mmr = 0", () => {
    expect(decayMmr(0, 25, 0.25)).toBe(0);
  });

  // Live behavior (SYMMETRIC_NEGATIVE_DECAY = false in seasonDecay.ts) — commit 814ee7c.
  it("halves a negative player toward 0, independent of median and decay_factor", () => {
    expect(decayMmr(-30, 25, 0.25)).toBe(-15);
    expect(decayMmr(-30, 50, 0.25)).toBe(-15);
    expect(decayMmr(-30, 25, 0.5)).toBe(-15);
  });

  // Flip SYMMETRIC_NEGATIVE_DECAY to true in lib/mmr/seasonDecay.ts and unskip this block to put
  // the below-zero half back on the same median-scaled formula as the above-zero half. Kept rather
  // than deleted so the alternative stays implemented and specified — see that file's header for
  // the trade-off (symmetric decay recovers negatives more slowly than the halving does).
  describe.skip("symmetric negative decay", () => {
    it("compresses a negative player toward 0 with the same median-scaled formula as a positive one", () => {
      // (-30 * 25) / (25 + 0.25 * 30) — the mmr >= 0 expression with |mmr| in the denominator.
      expect(decayMmr(-30, 25, 0.25)).toBeCloseTo(-750 / 32.5, 10);
      // Both the median and decay_factor move a below-zero player, which the `mmr / 2` branch
      // does not: decay_factor becomes a single lever across the whole pool.
      expect(decayMmr(-30, 50, 0.25)).toBeCloseTo(-1500 / 57.5, 10);
      expect(decayMmr(-30, 25, 0.5)).toBeCloseTo(-750 / 40, 10);
    });

    it("is odd — a player N below zero is pulled toward zero exactly as far as one N above", () => {
      for (const mmr of [0.001, 0.54, 5, 30, 116.307]) {
        expect(decayMmr(-mmr, 52.9326, 0.5)).toBeCloseTo(-decayMmr(mmr, 52.9326, 0.5), 12);
      }
    });
  });

  it("leaves every rating untouched when the median is degenerate rather than wiping the pool", () => {
    // computeSafeMedian returns 0 when at least half the pool ties at the minimum. Without the
    // guard the formula sends every player to 0 — and 0/0 = NaN for one already there.
    expect(computeSafeMedian([0, 0, 10])).toBe(0);
    for (const mmr of [-10, 0, 10]) {
      expect(decayMmr(mmr, 0, 0.25)).toBe(mmr);
    }
  });

  it("never reorders players when median is safe (positive)", () => {
    const mmrs = [-30, -10, 5, 10, 30, 90];
    const median = computeSafeMedian(mmrs);
    const decayed = mmrs.map((m) => decayMmr(m, median, 0.25));
    for (let i = 1; i < decayed.length; i++) {
      expect(decayed[i]).toBeGreaterThan(decayed[i - 1]);
    }
  });

  it("stays monotonic and reproduces the live 27-player regression case (mmr_scale=7.25, mmr_shift=1000)", () => {
    // Raw MMR back-converted from a real leaderboard snapshot's display MMR — 10 of 18 placed
    // players were below raw 0, which used to send the plain pool median negative and blow up
    // the mmr>=0 branch (e.g. the highest-MMR player dropping below players who started under
    // them). computeSafeMedian's shift keeps the median positive without touching the < 0 branch.
    const rawMmrs = [
      91.03448276, 82.62068966, 30.34482759, 17.51724138, 15.72413793, 10.89655172, 9.931034483,
      9.931034483, -2.75862069, -6.482758621, -11.5862069, -14.20689655, -16, -17.24137931,
      -19.86206897, -21.37931034, -28.82758621, -30.34482759,
    ];
    const median = computeSafeMedian(rawMmrs);
    expect(median).toBeGreaterThan(0);

    const decayed = rawMmrs.map((m) => decayMmr(m, median, 0.25));
    const sortedBefore = [...rawMmrs].sort((a, b) => a - b);
    const decayedInSameOrder = sortedBefore.map((m) => decayMmr(m, median, 0.25));
    // Non-decreasing, not strictly increasing: two players tied on raw MMR (9.931034483
    // appears twice in this real snapshot) must decay to the same value, not get reordered.
    for (let i = 1; i < decayedInSameOrder.length; i++) {
      expect(decayedInSameOrder[i]).toBeGreaterThanOrEqual(decayedInSameOrder[i - 1]);
    }

    // The highest-MMR player must still land above every other player after decay.
    expect(Math.max(...decayed)).toBe(decayed[0]);
  });

  it("pins the live calibration case: highest-MMR player lands at display MMR ~1350 (mmr_scale=7.25, mmr_shift=1000, decay_factor=0.25)", () => {
    // Regression pin for the specific ask that motivated computeSafeMedian: with the fix applied
    // and decay_factor left at its unchanged default (0.25), 1zen1zen (raw 91.03448276, the pool's
    // highest) should decay to display MMR ~1350 with no further decay_factor tuning. If this
    // breaks, either the shift rule changed or decay_factor drifted from 0.25 — both are worth
    // knowing about explicitly rather than silently.
    const rawMmrs = [
      91.03448276, 82.62068966, 30.34482759, 17.51724138, 15.72413793, 10.89655172, 9.931034483,
      9.931034483, -2.75862069, -6.482758621, -11.5862069, -14.20689655, -16, -17.24137931,
      -19.86206897, -21.37931034, -28.82758621, -30.34482759,
    ];
    const median = computeSafeMedian(rawMmrs);
    const decayedRaw = decayMmr(rawMmrs[0], median, 0.25);
    expect(decayedRaw).toBeCloseTo(48.3014, 2);
    const displayAfter = decayedRaw * 7.25 + 1000;
    expect(displayAfter).toBeCloseTo(1350.18, 1);
  });
});

// The decay pool covers every non-test player, placed or not (changed 2026-08-31). Previously it
// filtered on is_placed, which let an unplaced player carry an un-decayed rating past a placed
// player they had finished below — the formula's strictly-increasing guarantee only ever held
// within the pool, never across its boundary.
describe("decay pool covers unplaced players", () => {
  it("keeps a placed and an unplaced player in their original order", () => {
    // The live pair that surfaced this: Murc (placed, 10.83) finished above Synthey (unplaced,
    // 10.35) and, under the old placed-only pool, started the next season below them.
    const pool = [10.8285, 10.3494, 116.307, -53.474, 0];
    const median = computeSafeMedian(pool);
    const murc = decayMmr(10.8285, median, 0.5);
    const synthey = decayMmr(10.3494, median, 0.5);
    expect(murc).toBeGreaterThan(synthey);
  });

  it("leaves a never-played player at exactly 0", () => {
    expect(decayMmr(0, 52.933, 0.5)).toBe(0);
  });
});
