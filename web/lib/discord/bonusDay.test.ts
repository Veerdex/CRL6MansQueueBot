import { describe, expect, it } from "vitest";
import { isDayInRange, computeDayTrackingTotals } from "./bonusDay";

// Noon UTC keeps these safely within the same Pacific calendar date regardless of PST/PDT
// (UTC-8/-7), so the exact time-of-day never matters here, only the Y/M/D.
const d = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe("isDayInRange", () => {
  it("single-day range matches only that day", () => {
    expect(isDayInRange(0, 0, 0)).toBe(true);
    expect(isDayInRange(1, 0, 0)).toBe(false);
    expect(isDayInRange(6, 0, 0)).toBe(false);
  });

  it("forward multi-day range matches days within it, inclusive", () => {
    expect(isDayInRange(1, 1, 3)).toBe(true);
    expect(isDayInRange(2, 1, 3)).toBe(true);
    expect(isDayInRange(3, 1, 3)).toBe(true);
    expect(isDayInRange(0, 1, 3)).toBe(false);
    expect(isDayInRange(4, 1, 3)).toBe(false);
  });

  it("wraparound range matches days across the week boundary", () => {
    // Fri(5) -> Sun(0): Fri, Sat, Sun
    expect(isDayInRange(5, 5, 0)).toBe(true);
    expect(isDayInRange(6, 5, 0)).toBe(true);
    expect(isDayInRange(0, 5, 0)).toBe(true);
    expect(isDayInRange(1, 5, 0)).toBe(false);
    expect(isDayInRange(4, 5, 0)).toBe(false);
  });

  it("full-week range matches every day", () => {
    for (let day = 0; day <= 6; day++) {
      expect(isDayInRange(day, 0, 6)).toBe(true);
    }
  });
});

describe("computeDayTrackingTotals", () => {
  // 2026-01-04 is a Sunday.
  it("same day for start and now counts as exactly 1 day", () => {
    const totals = computeDayTrackingTotals(d("2026-01-04"), d("2026-01-04"), true, 6, 6);
    expect(totals.totalDays).toBe(1);
    expect(totals.daysOccurredByWeekday).toEqual([1, 0, 0, 0, 0, 0, 0]);
    expect(totals.superchargedDays).toBe(0); // Sunday isn't in a Saturday-only range
    expect(totals.nonSuperchargedDays).toBe(1);
  });

  it("a full week (Sun..Sat) counts each weekday exactly once", () => {
    const totals = computeDayTrackingTotals(d("2026-01-04"), d("2026-01-10"), true, 6, 6);
    expect(totals.totalDays).toBe(7);
    expect(totals.daysOccurredByWeekday).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(totals.superchargedDays).toBe(1); // the one Saturday (2026-01-10)
    expect(totals.nonSuperchargedDays).toBe(6);
  });

  it("two full weeks doubles every weekday's occurrence count", () => {
    const totals = computeDayTrackingTotals(d("2026-01-04"), d("2026-01-17"), true, 6, 6);
    expect(totals.totalDays).toBe(14);
    expect(totals.daysOccurredByWeekday).toEqual([2, 2, 2, 2, 2, 2, 2]);
    expect(totals.superchargedDays).toBe(2); // both Saturdays
    expect(totals.nonSuperchargedDays).toBe(12);
  });

  it("bonus day disabled means no supercharged days regardless of range", () => {
    const totals = computeDayTrackingTotals(d("2026-01-04"), d("2026-01-17"), false, 6, 6);
    expect(totals.superchargedDays).toBe(0);
    expect(totals.nonSuperchargedDays).toBe(totals.totalDays);
  });

  it("a wraparound range (Fri..Sun) counts every matching day across weeks", () => {
    // Fri(5)->Sun(0): 2026-01-04 (Sun) through 2026-01-17 (Sat) contains Fri/Sat/Sun on
    // 01-04(Sun, first week partial), 01-09/10/11 (Fri/Sat/Sun), 01-16/17 (Fri/Sat, range ends).
    const totals = computeDayTrackingTotals(d("2026-01-04"), d("2026-01-17"), true, 5, 0);
    expect(totals.superchargedDays).toBe(6);
  });
});
