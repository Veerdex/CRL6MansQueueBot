import { describe, expect, it } from "vitest";
import {
  MAFIA_OBJECTIVES,
  MAFIA_TEAM_OBJECTIVES,
  MAFIA_TEAM_FALLBACK_DISPLAY_MMR,
  assignObjectives,
  assignTeamObjectives,
  mafiaFallbackRating,
  resolveMafiaCount,
  splitMafiaTeams,
} from "./mafia";

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

  // One objective per lobby seat is the whole point of the six-item list: an all-mafia game has
  // to hand out six *different* goals, never a repeat.
  it("gives all six players a distinct objective when everyone is mafia", () => {
    expect(MAFIA_OBJECTIVES).toHaveLength(6);
    for (let i = 0; i < 50; i++) {
      const dealt = assignObjectives(6);
      expect(dealt).toHaveLength(6);
      expect(new Set(dealt).size).toBe(6);
      expect([...dealt].sort()).toEqual([...MAFIA_OBJECTIVES].sort());
    }
  });

  it("does not always deal the objectives in list order", () => {
    const firsts = new Set(Array.from({ length: 100 }, () => assignObjectives(1)[0]));
    expect(firsts.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Team Mafia (mode 'team_objective') — no mafia, two MMR-balanced teams, one objective each.
// ---------------------------------------------------------------------------

describe("assignTeamObjectives", () => {
  // Never the same goal twice, by explicit user choice: "Go to overtime" in particular would
  // otherwise be completed by both teams at once, making the objective worth nothing.
  it("always deals two different objectives from the list", () => {
    for (let i = 0; i < 200; i++) {
      const [blue, orange] = assignTeamObjectives();
      expect(blue).not.toBe(orange);
      expect(MAFIA_TEAM_OBJECTIVES).toContain(blue);
      expect(MAFIA_TEAM_OBJECTIVES).toContain(orange);
    }
  });

  it("can deal every objective in the list", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) for (const o of assignTeamObjectives()) seen.add(o);
    expect(seen).toEqual(new Set(MAFIA_TEAM_OBJECTIVES));
  });
});

describe("mafiaFallbackRating", () => {
  // The spec's "default to 1100, not 1000" is in *display* MMR: 1000 is display-zero under the
  // live transform, which would model a newcomer as the worst player in the lobby.
  it("converts the display default back through the live scale/shift", () => {
    expect(mafiaFallbackRating(7.25, 1000)).toBeCloseTo((1100 - 1000) / 7.25, 10);
    expect(mafiaFallbackRating(7.25, 1000) * 7.25 + 1000).toBeCloseTo(MAFIA_TEAM_FALLBACK_DISPLAY_MMR, 10);
  });

  it("is the raw default itself when no transform is configured", () => {
    expect(mafiaFallbackRating(1, 0)).toBe(1100);
  });

  it("falls back to 0 rather than dividing by a zero scale", () => {
    expect(mafiaFallbackRating(0, 1000)).toBe(0);
  });
});

describe("splitMafiaTeams", () => {
  const lobby = (mmrs: number[]) => mmrs.map((mmr, i) => ({ discord_id: `p${i}`, mmr }));
  const ratingFor = (players: { discord_id: string; mmr: number }[]) => (id: string) =>
    players.find((p) => p.discord_id === id)!.mmr;

  it("always makes two teams of three covering the whole lobby", () => {
    const players = lobby([120, 80, 40, 10, -5, -40]);
    for (let i = 0; i < 50; i++) {
      const { blue, orange } = splitMafiaTeams(players, ratingFor(players));
      expect(blue).toHaveLength(3);
      expect(orange).toHaveLength(3);
      const all = [...blue, ...orange].map((p) => p.discord_id);
      expect(new Set(all).size).toBe(6);
      expect(new Set(all)).toEqual(new Set(players.map((p) => p.discord_id)));
    }
  });

  // The whole point of balancing on MMR: the obvious stacked split must never be the answer.
  it("picks the balanced split over stacking the top three together", () => {
    const players = lobby([100, 90, 80, 20, 10, 0]);
    for (let i = 0; i < 50; i++) {
      const { blue } = splitMafiaTeams(players, ratingFor(players));
      const ids = new Set(blue.map((p) => p.discord_id));
      expect(ids).not.toEqual(new Set(["p0", "p1", "p2"]));
      expect(ids).not.toEqual(new Set(["p3", "p4", "p5"]));
    }
  });

  it("produces the same split regardless of join order", () => {
    const players = lobby([64, 31, 12, 3, -9, -55]);
    const pairFor = (list: typeof players) => {
      const { blue, orange } = splitMafiaTeams(list, ratingFor(players));
      return [blue, orange]
        .map((t) => t.map((p) => p.discord_id).sort().join(","))
        .sort()
        .join("|");
    };
    const reversed = [...players].reverse();
    expect(pairFor(reversed)).toBe(pairFor(players));
  });

  // bestBalancedSplit enumerates i<j<k, so its teamA always contains members[0]. Without the coin
  // flip in splitMafiaTeams, the first player to join (the host) would be Blue in every game.
  it("does not always put the first player to join on Blue", () => {
    const players = lobby([50, 40, 30, 20, 10, 0]);
    const hostSides = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const { blue } = splitMafiaTeams(players, ratingFor(players));
      hostSides.add(blue.some((p) => p.discord_id === "p0") ? "blue" : "orange");
    }
    expect(hostSides).toEqual(new Set(["blue", "orange"]));
  });

  it("treats a lobby with no ratings at all as fully balanced rather than erroring", () => {
    const players = lobby([0, 0, 0, 0, 0, 0]);
    const { blue, orange } = splitMafiaTeams(players, ratingFor(players));
    expect(blue).toHaveLength(3);
    expect(orange).toHaveLength(3);
  });
});
