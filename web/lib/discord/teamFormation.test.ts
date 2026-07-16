import { describe, expect, it } from "vitest";
import { bestBalancedSplit, deriveTurnCaptain } from "./teamFormation";
import type { PlayerRow } from "@/lib/supabase/types";

function player(id: string, mmr: number): PlayerRow {
  return {
    id,
    discord_id: `discord-${id}`,
    display_name: id,
    mmr,
    band: null,
    is_placed: false,
    total_games_played: 0,
    rank_games_played: 0,
    band_games_played: 0,
    is_prism: false,
    is_test_data: false,
    vote_default: null,
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
