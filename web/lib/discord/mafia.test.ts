import { describe, expect, it } from "vitest";
import { MAFIA_OBJECTIVES, assignObjectives, resolveMafiaCount } from "./mafia";

describe("resolveMafiaCount", () => {
  it("returns the requested count for 1-6", () => {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(resolveMafiaCount(n)).toBe(n);
    }
  });

  it("clamps a count above the lobby size", () => {
    expect(resolveMafiaCount(9)).toBe(6);
  });

  // 0 is the coin-flip case: one mafia or none, decided at finalize time.
  it("resolves 0 to either 0 or 1, and reaches both over many draws", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const n = resolveMafiaCount(0);
      expect([0, 1]).toContain(n);
      seen.add(n);
    }
    expect(seen).toEqual(new Set([0, 1]));
  });
});

describe("assignObjectives", () => {
  it("deals nothing for a count of 0", () => {
    expect(assignObjectives(0)).toEqual([]);
  });

  it("deals distinct objectives while the deck lasts", () => {
    for (let n = 1; n <= MAFIA_OBJECTIVES.length; n++) {
      const dealt = assignObjectives(n);
      expect(dealt).toHaveLength(n);
      expect(new Set(dealt).size).toBe(n);
      for (const o of dealt) expect(MAFIA_OBJECTIVES).toContain(o);
    }
  });

  // Six mafia but only five objectives — per spec the sixth draws a repeat rather than going
  // without, so the run is still full length and every entry is still a real objective.
  it("repeats one objective when all six players are mafia", () => {
    for (let i = 0; i < 50; i++) {
      const dealt = assignObjectives(6);
      expect(dealt).toHaveLength(6);
      expect(new Set(dealt).size).toBe(MAFIA_OBJECTIVES.length);
      for (const o of dealt) expect(MAFIA_OBJECTIVES).toContain(o);
    }
  });

  it("does not always deal the objectives in list order", () => {
    const firsts = new Set(Array.from({ length: 100 }, () => assignObjectives(1)[0]));
    expect(firsts.size).toBeGreaterThan(1);
  });
});
