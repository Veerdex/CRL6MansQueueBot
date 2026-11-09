import { describe, expect, it } from "vitest";
import {
  PERMANENT_TIMEOUT,
  formatRemaining,
  queueBlockedMessage,
  timeoutDurationMs,
  timeoutState,
  timeoutUntilForStrikeLevel,
  timeoutUntilFromDuration,
} from "./queueTimeoutRules";

const NOW = new Date("2026-11-09T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("timeoutUntilFromDuration", () => {
  it("adds days, hours and minutes to now", () => {
    expect(timeoutUntilFromDuration(timeoutDurationMs(1, 2, 30), NOW)).toBe("2026-11-10T14:30:00.000Z");
  });
  it("clears the timeout for a zero duration", () => {
    expect(timeoutUntilFromDuration(timeoutDurationMs(0, 0, 0), NOW)).toBeNull();
  });
});

describe("timeoutUntilForStrikeLevel", () => {
  it("maps strikes 1-4 to 1d, 3d, 1w, 30d", () => {
    expect([1, 2, 3, 4].map((l) => new Date(timeoutUntilForStrikeLevel(l, NOW)!).getTime() - NOW.getTime())).toEqual([
      1 * DAY,
      3 * DAY,
      7 * DAY,
      30 * DAY,
    ]);
  });
  it("is permanent from strike 5 on", () => {
    expect(timeoutUntilForStrikeLevel(5, NOW)).toBe(PERMANENT_TIMEOUT);
    expect(timeoutUntilForStrikeLevel(9, NOW)).toBe(PERMANENT_TIMEOUT);
  });
  it("clears the timeout at strike 0", () => {
    expect(timeoutUntilForStrikeLevel(0, NOW)).toBeNull();
  });
});

describe("timeoutState / queueBlockedMessage", () => {
  it("treats null and past timestamps as no timeout", () => {
    expect(timeoutState(null, NOW).kind).toBe("none");
    expect(queueBlockedMessage("2026-11-09T11:59:00.000Z", NOW)).toBeNull();
  });
  it("reports the remaining time for an active timeout", () => {
    const msg = queueBlockedMessage("2026-11-11T15:30:00.000Z", NOW);
    expect(msg).toContain("**2d 3h 30m**");
    expect(msg).toContain(`<t:${Date.parse("2026-11-11T15:30:00.000Z") / 1000}:R>`);
  });
  it("reports a permanent timeout", () => {
    expect(queueBlockedMessage(PERMANENT_TIMEOUT, NOW)).toMatch(/permanently/);
  });
});

describe("formatRemaining", () => {
  it("rounds up to the minute and never shows zero", () => {
    expect(formatRemaining(1)).toBe("1m");
    expect(formatRemaining(60 * 60 * 1000)).toBe("1h");
    expect(formatRemaining(DAY + 61_000)).toBe("1d 2m");
  });
});
