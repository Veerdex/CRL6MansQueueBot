import { describe, expect, it } from "vitest";
import { isDayInRange } from "./bonusDay";

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
