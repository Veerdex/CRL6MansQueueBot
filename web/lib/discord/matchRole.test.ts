import { describe, expect, it } from "vitest";
import { MATCH_ROLE_NAME_PATTERN, matchRoleName, rainbowRoleColor, roleCreatedAtMs } from "./matchRole";

const channels = (color: number) => [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];

describe("rainbowRoleColor", () => {
  // The user's spec was "random color of the rainbow (not too white and not too black)", which
  // the implementation guarantees structurally by fixing saturation and lightness and varying
  // only the hue. Sweeping every hue is what actually proves the guarantee holds all the way
  // around the wheel rather than just at the handful of hues a random sample happens to hit.
  it("stays a readable mid tone at every hue", () => {
    for (let hue = 0; hue < 360; hue += 1) {
      const color = rainbowRoleColor(() => hue / 360);
      for (const channel of channels(color)) {
        expect(channel).toBeGreaterThanOrEqual(40);
        expect(channel).toBeLessThanOrEqual(240);
      }
    }
  });

  // Discord reads 0 as "no color" (the role renders in the default grey) rather than as black,
  // so it is the one value that would silently drop the styling entirely.
  it("never returns 0 or an out-of-range value", () => {
    for (let hue = 0; hue < 360; hue += 1) {
      const color = rainbowRoleColor(() => hue / 360);
      expect(color).not.toBe(0);
      expect(color).toBeGreaterThan(0);
      expect(color).toBeLessThanOrEqual(0xffffff);
    }
  });

  it("actually varies across the wheel", () => {
    const seen = new Set([0, 0.25, 0.5, 0.75].map((r) => rainbowRoleColor(() => r)));
    expect(seen.size).toBe(4);
  });

  it("covers the whole wheel, including the Math.random() = ~1 edge", () => {
    expect(() => rainbowRoleColor(() => 0.9999999)).not.toThrow();
    const color = rainbowRoleColor(() => 0.9999999);
    for (const channel of channels(color)) {
      expect(channel).toBeGreaterThanOrEqual(40);
      expect(channel).toBeLessThanOrEqual(240);
    }
  });
});

describe("MATCH_ROLE_NAME_PATTERN", () => {
  // The sweep reclaim deletes whatever this matches, so the negative cases matter more than the
  // positive ones — a loose pattern would point a destructive pass at real guild roles.
  it("matches the names this feature creates", () => {
    expect(MATCH_ROLE_NAME_PATTERN.test(matchRoleName(1))).toBe(true);
    expect(MATCH_ROLE_NAME_PATTERN.test(matchRoleName(263))).toBe(true);
  });

  it("does not match look-alike roles a human might create", () => {
    for (const name of ["Match #", "Match #1 Stuff", "match #1", "Prefix Match #1", "Match ##1", "Match", "#1"]) {
      expect(MATCH_ROLE_NAME_PATTERN.test(name)).toBe(false);
    }
  });
});

describe("roleCreatedAtMs", () => {
  // The age floor it feeds is what stops the reclaim pass deleting a role whose id hasn't been
  // written back to the series row yet, so the epoch maths has to be right.
  it("decodes the Discord epoch from a snowflake", () => {
    expect(roleCreatedAtMs("0")).toBe(1420070400000);
    // 2026-10-06T00:00:00.000Z, shifted into snowflake position.
    const ms = Date.UTC(2026, 9, 6);
    expect(roleCreatedAtMs(String(BigInt(ms - 1420070400000) << BigInt(22)))).toBe(ms);
  });

  it("reads a real role id as a plausible past date", () => {
    const created = roleCreatedAtMs("1038689148552364032");
    expect(created).toBeGreaterThan(Date.UTC(2015, 0, 1));
    expect(created).toBeLessThan(Date.now());
  });
});
