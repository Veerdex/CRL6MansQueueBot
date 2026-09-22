import { describe, expect, it } from "vitest";
import { MAFIA_OBJECTIVES, assignObjectives, mafiaGuessComponents, mafiaGuessLine, resolveMafiaCount } from "./mafia";
import type { MafiaPlayerRow } from "@/lib/supabase/types";

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

function player(id: string, guess: string[] | null = null): MafiaPlayerRow {
  return {
    game_id: "g",
    discord_id: id,
    display_name: `name-${id}`,
    interaction_token: "t",
    joined_at: "",
    is_mafia: false,
    objective: null,
    guess,
  };
}

describe("mafiaGuessLine", () => {
  it("marks each pick right or wrong", () => {
    expect(mafiaGuessLine(player("a", ["b", "c"]), new Set(["b"]))).toBe("<@a> → <@b> ✅, <@c> ❌");
  });

  it("scores No Mafia against whether anyone drew mafia", () => {
    expect(mafiaGuessLine(player("a", []), new Set())).toBe("<@a> → No Mafia ✅");
    expect(mafiaGuessLine(player("a", []), new Set(["b"]))).toBe("<@a> → No Mafia ❌");
  });

  it("shows a player who never guessed", () => {
    expect(mafiaGuessLine(player("a"), new Set(["b"]))).toBe("<@a> → _no guess_");
  });
});

describe("mafiaGuessComponents", () => {
  const players = ["a", "b", "c", "d", "e", "f"].map((id) => player(id));
  type Select = { options: { value: string }[]; max_values: number };
  const selectOf = (rows: unknown[]) => (rows[0] as { components: Select[] }).components[0];

  it("lists everyone but the voter, allowing any number of picks", () => {
    const select = selectOf(mafiaGuessComponents("g", players, "a", 2));
    expect(select.options.map((o) => o.value)).toEqual(["b", "c", "d", "e", "f"]);
    expect(select.max_values).toBe(5);
  });

  it("only offers No Mafia in a 0-or-1 lobby", () => {
    expect(mafiaGuessComponents("g", players, "a", 0)).toHaveLength(2);
    expect(mafiaGuessComponents("g", players, "a", 1)).toHaveLength(1);
  });
});
