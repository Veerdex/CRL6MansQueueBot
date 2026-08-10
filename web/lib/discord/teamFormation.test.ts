import { describe, expect, it } from "vitest";
import { bestBalancedSplit, deriveTurnCaptain, selectCaptainCandidates } from "./teamFormation";
import type { PlayerRow } from "@/lib/supabase/types";

function player(id: string, mmr: number, isPlaced = false): PlayerRow {
  return {
    id,
    discord_id: `discord-${id}`,
    display_name: id,
    mmr,
    band: null,
    is_placed: isPlaced,
    total_games_played: 0,
    rank_games_played: 0,
    band_games_played: 0,
    last_rank_game_at: null,
    is_prism: false,
    is_test_data: false,
    vote_default: null,
    avatar_url: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

// Independent reference implementation (all C(6,3)/2 = 10 unique splits) to check
// bestBalancedSplit's chosen diff is actually the minimum, without assuming which split wins.
function minPossibleDiff(members: PlayerRow[]): number {
  let min = Infinity;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      for (let k = j + 1; k < members.length; k++) {
        const teamA = [members[i], members[j], members[k]];
        const teamAIds = new Set(teamA.map((p) => p.id));
        const teamB = members.filter((m) => !teamAIds.has(m.id));
        const avgA = teamA.reduce((sum, p) => sum + p.mmr, 0) / 3;
        const avgB = teamB.reduce((sum, p) => sum + p.mmr, 0) / 3;
        min = Math.min(min, Math.abs(avgA - avgB));
      }
    }
  }
  return min;
}

describe("bestBalancedSplit", () => {
  it("picks a split whose MMR-average gap matches the true minimum over all 10 unique splits", () => {
    const members = [player("hi1", 900), player("hi2", 850), player("hi3", 800), player("lo1", 100), player("lo2", 50), player("lo3", 0)];
    const { teamA, teamB } = bestBalancedSplit(members);
    const avg = (team: PlayerRow[]) => team.reduce((sum, p) => sum + p.mmr, 0) / 3;
    expect(Math.abs(avg(teamA) - avg(teamB))).toBeCloseTo(minPossibleDiff(members), 10);
  });

  it("produces a zero MMR gap when a perfectly balanced split exists", () => {
    // Three matched pairs (0, 50, 100) — taking one from each pair always sums to 150 a side.
    const members = [player("a", 0), player("b", 0), player("c", 50), player("d", 50), player("e", 100), player("f", 100)];
    const { teamA, teamB } = bestBalancedSplit(members);
    const avg = (team: PlayerRow[]) => team.reduce((sum, p) => sum + p.mmr, 0) / 3;
    expect(Math.abs(avg(teamA) - avg(teamB))).toBeCloseTo(0, 10);
  });

  it("always returns exactly 3-and-3 with all six original members accounted for", () => {
    const members = [player("a", 500), player("b", 10), player("c", 300), player("d", 20), player("e", 250), player("f", 40)];
    const { teamA, teamB } = bestBalancedSplit(members);
    expect(teamA).toHaveLength(3);
    expect(teamB).toHaveLength(3);
    const allIds = [...teamA, ...teamB].map((p) => p.id).sort();
    expect(allIds).toEqual(members.map((p) => p.id).sort());
  });
});

// See CLAUDE.md, "Team formation (on pop)" — ranked (is_placed) players are preferred over
// unranked ones when choosing captains, with unranked players only ever filling in for a slot
// ranked players couldn't fill.
describe("selectCaptainCandidates", () => {
  it("with 2 ranked players, both become captains outright (no randomness)", () => {
    const ranked1 = player("r1", 900, true);
    const ranked2 = player("r2", 100, true);
    const members = [ranked1, ranked2, player("u1", 950), player("u2", 800), player("u3", 10), player("u4", 5)];
    for (let i = 0; i < 25; i++) {
      const picked = selectCaptainCandidates(members);
      expect(new Set(picked.map((p) => p.id))).toEqual(new Set(["r1", "r2"]));
    }
  });

  it("with 3 ranked players, picks 2 of the top 3 ranked by MMR at random, never an unranked player", () => {
    const ranked = [player("r1", 900, true), player("r2", 800, true), player("r3", 700, true)];
    const members = [...ranked, player("u1", 1000), player("u2", 999), player("u3", 998)];
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const picked = selectCaptainCandidates(members);
      expect(picked).toHaveLength(2);
      for (const p of picked) {
        expect(p.is_placed).toBe(true);
        seen.add(p.id);
      }
    }
    // Over enough trials, every one of the 3 ranked players should show up as a captain at least
    // once (each is excluded with independent 1/3 probability per trial).
    expect(seen).toEqual(new Set(["r1", "r2", "r3"]));
  });

  it("with 3+ ranked players, ignores unranked players entirely even if they have higher MMR", () => {
    const ranked = [player("r1", 10, true), player("r2", 9, true), player("r3", 8, true), player("r4", 7, true)];
    const members = [...ranked, player("u1", 9999), player("u2", 9998)];
    const picked = selectCaptainCandidates(members);
    for (const p of picked) expect(p.is_placed).toBe(true);
    // Top 3 ranked by MMR are r1/r2/r3 — r4 should never be picked.
    for (let i = 0; i < 50; i++) {
      const result = selectCaptainCandidates(members);
      expect(result.some((p) => p.id === "r4")).toBe(false);
    }
  });

  it("with exactly 1 ranked player, that player plus a random pick from the top 2 unranked by MMR", () => {
    const ranked1 = player("r1", 500, true);
    const members = [ranked1, player("u1", 900), player("u2", 850), player("u3", 10), player("u4", 5), player("u5", 1)];
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const picked = selectCaptainCandidates(members);
      expect(picked.some((p) => p.id === "r1")).toBe(true);
      const other = picked.find((p) => p.id !== "r1")!;
      expect(["u1", "u2"]).toContain(other.id);
      seen.add(other.id);
    }
    expect(seen).toEqual(new Set(["u1", "u2"]));
  });

  it("with 0 ranked players, picks 2 of the top 3 unranked by MMR at random", () => {
    const members = [player("u1", 900), player("u2", 800), player("u3", 700), player("u4", 10), player("u5", 5), player("u6", 1)];
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const picked = selectCaptainCandidates(members);
      for (const p of picked) {
        expect(["u1", "u2", "u3"]).toContain(p.id);
        seen.add(p.id);
      }
    }
    expect(seen).toEqual(new Set(["u1", "u2", "u3"]));
  });
});

describe("deriveTurnCaptain", () => {
  it("gives captain A the first pick", () => {
    expect(deriveTurnCaptain(0)).toBe("A");
  });

  it("gives captain B the next two picks", () => {
    expect(deriveTurnCaptain(1)).toBe("B");
    expect(deriveTurnCaptain(2)).toBe("B");
  });

  it("returns null once 3 picks are made, signalling auto-assignment of the last player", () => {
    expect(deriveTurnCaptain(3)).toBeNull();
  });
});
