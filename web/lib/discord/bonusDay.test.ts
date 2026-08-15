import { describe, expect, it } from "vitest";
import { isDayInRange, computeDayTrackingTotals, computeDayAdvanceSteps, pacificDateString } from "./bonusDay";

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
    const totals = computeDayTrackingTotals(d("2026-01-04"), d("2026-01-04"));
    expect(totals.totalDays).toBe(1);
    expect(totals.daysOccurredByWeekday).toEqual([1, 0, 0, 0, 0, 0, 0]);
  });

  it("a full week (Sun..Sat) counts each weekday exactly once", () => {
    const totals = computeDayTrackingTotals(d("2026-01-04"), d("2026-01-10"));
    expect(totals.totalDays).toBe(7);
    expect(totals.daysOccurredByWeekday).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it("two full weeks doubles every weekday's occurrence count", () => {
    const totals = computeDayTrackingTotals(d("2026-01-04"), d("2026-01-17"));
    expect(totals.totalDays).toBe(14);
    expect(totals.daysOccurredByWeekday).toEqual([2, 2, 2, 2, 2, 2, 2]);
  });
});

describe("pacificDateString", () => {
  it("formats as YYYY-MM-DD in the Pacific calendar date", () => {
    expect(pacificDateString(d("2026-01-04"))).toBe("2026-01-04");
    expect(pacificDateString(d("2026-08-08"))).toBe("2026-08-08");
  });
});

describe("computeDayAdvanceSteps", () => {
  // 2026-08-08 is a Saturday.
  it("no steps when today has already been marked", () => {
    expect(computeDayAdvanceSteps("2026-08-08", "2026-08-08", true, 6, 6)).toEqual([]);
  });

  it("one step per fully-elapsed day, excluding today", () => {
    const steps = computeDayAdvanceSteps("2026-08-08", "2026-08-11", true, 6, 6);
    expect(steps.map((s) => s.date)).toEqual(["2026-08-09", "2026-08-10", "2026-08-11"]);
  });

  it("classifies each step against the bonus range at the moment it's evaluated", () => {
    // 2026-08-15 is the next Saturday after 2026-08-08.
    const steps = computeDayAdvanceSteps("2026-08-08", "2026-08-16", true, 6, 6);
    const supercharged = steps.filter((s) => s.supercharged).map((s) => s.date);
    expect(supercharged).toEqual(["2026-08-15"]);
  });

  it("bonus day disabled means no step is ever supercharged", () => {
    const steps = computeDayAdvanceSteps("2026-08-08", "2026-08-16", false, 6, 6);
    expect(steps.every((s) => !s.supercharged)).toBe(true);
  });

  it("a changed bonus range never revisits an already-marked day", () => {
    // Day 1 (2026-08-08, Saturday) is marked supercharged under the default Saturday-only range.
    const day1 = computeDayAdvanceSteps("2026-08-07", "2026-08-08", true, 6, 6);
    expect(day1).toEqual([{ date: "2026-08-08", supercharged: true }]);

    // The admin later widens the range to Fri-Sun. Advancing from the *already-marked* 08-08
    // only evaluates the new day (08-09, Sunday) — 08-08 never reappears here to be
    // reclassified, even though it would also match the new range.
    const day2 = computeDayAdvanceSteps("2026-08-08", "2026-08-09", true, 5, 0);
    expect(day2).toEqual([{ date: "2026-08-09", supercharged: true }]); // Sunday is in Fri-Sun
  });
});
