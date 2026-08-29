import { describe, expect, it } from "vitest";
import { computeSafeMedian, decayMmr, diffPrismRoles } from "./seasonClose";

describe("diffPrismRoles", () => {
  it("is a no-op for a repeat top-N finisher who already holds Prism", () => {
    const { toRevokeIds, toGrant } = diffPrismRoles(new Set(["a"]), new Set(["a"]));
    expect(toRevokeIds.size).toBe(0);
    expect(toGrant).toEqual([]);
  });

  it("revokes a holder who drops out of the top N", () => {
    const { toRevokeIds, toGrant } = diffPrismRoles(new Set(["a", "b"]), new Set(["b"]));
    expect(toRevokeIds).toEqual(new Set(["a"]));
    expect(toGrant).toEqual([]);
  });

  it("grants a new top-N finisher who didn't already hold Prism", () => {
    const { toRevokeIds, toGrant } = diffPrismRoles(new Set(["a"]), new Set(["a", "b"]));
    expect(toRevokeIds.size).toBe(0);
    expect(toGrant).toEqual(["b"]);
  });

  it("revokes every current holder when top10Ids is empty (zero-participant season close)", () => {
    const { toRevokeIds, toGrant } = diffPrismRoles(new Set(["a", "b", "c"]), new Set());
    expect(toRevokeIds).toEqual(new Set(["a", "b", "c"]));
    expect(toGrant).toEqual([]);
  });
});

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

  it("halves a negative player toward 0, independent of median and decay_factor", () => {
    expect(decayMmr(-30, 25, 0.25)).toBeCloseTo(-15, 10);
    expect(decayMmr(-30, -9999, 0.25)).toBeCloseTo(-15, 10); // median never consulted for mmr < 0
    expect(decayMmr(-30, 25, 0.5)).toBeCloseTo(-15, 10); // decay_factor never consulted either
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
