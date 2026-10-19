import { describe, expect, it } from "vitest";
import {
  bestBalancedSplit,
  claimDraftTurn,
  deriveTurnCaptain,
  selectCaptainCandidates,
  resolveSeriesLengthTieBreak,
  resolveSeriesLengthWinner,
} from "./teamFormation";
import type { SeriesLength } from "@/lib/supabase/types";
import type { PlayerRow } from "@/lib/supabase/types";

function player(id: string, mmr: number, isPlaced = false): PlayerRow {
  return {
    id,
    discord_id: `discord-${id}`,
    display_name: id,
    mmr,
    peak_mmr: mmr,
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
    role_sync_pending: false,
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

// See CLAUDE.md, "Team formation" — captains are two of the lobby's top three by MMR, chosen at
// random, with placement status ignored entirely.
describe("selectCaptainCandidates", () => {
  it("picks 2 of the top 3 by MMR at random, never anyone below the top 3", () => {
    const members = [player("a", 900, true), player("b", 800), player("c", 700, true), player("d", 600, true), player("e", 10), player("f", 5)];
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const picked = selectCaptainCandidates(members);
      expect(picked).toHaveLength(2);
      expect(picked[0].id).not.toBe(picked[1].id);
      for (const p of picked) {
        expect(["a", "b", "c"]).toContain(p.id);
        seen.add(p.id);
      }
    }
    // Each of the top 3 is excluded with independent 1/3 probability per trial.
    expect(seen).toEqual(new Set(["a", "b", "c"]));
  });

  it("Unranked players are eligible even when ranked players are in the lobby", () => {
    const members = [player("u1", 9999), player("u2", 9998), player("u3", 9997), player("r1", 10, true), player("r2", 9, true), player("r3", 8, true)];
    for (let i = 0; i < 50; i++) {
      for (const p of selectCaptainCandidates(members)) expect(p.is_placed).toBe(false);
    }
  });

  it("works for an all-Unranked lobby", () => {
    const members = [player("u1", 900), player("u2", 800), player("u3", 700), player("u4", 10), player("u5", 5), player("u6", 1)];
    for (let i = 0; i < 50; i++) {
      for (const p of selectCaptainCandidates(members)) expect(["u1", "u2", "u3"]).toContain(p.id);
    }
  });

  it("does not reorder the caller's members array", () => {
    const members = [player("a", 1), player("b", 3), player("c", 2), player("d", 6), player("e", 5), player("f", 4)];
    const before = members.map((m) => m.id);
    selectCaptainCandidates(members);
    expect(members.map((m) => m.id)).toEqual(before);
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

describe("resolveSeriesLengthTieBreak", () => {
  const counts = (bo3: number, bo5: number, bo7: number): Record<SeriesLength, number> => ({ bo3, bo5, bo7 });

  it("picks the option with the most votes", () => {
    expect(resolveSeriesLengthTieBreak(counts(1, 2, 0))).toBe("bo5");
    expect(resolveSeriesLengthTieBreak(counts(2, 1, 0))).toBe("bo3");
  });

  // BO7 wins on its own 4-vote threshold or not at all, so it is not a candidate in the
  // fallback even when it is the outright plurality. This used to resolve to bo7.
  it("never picks bo7, even when bo7 leads", () => {
    expect(resolveSeriesLengthTieBreak(counts(0, 1, 2))).toBe("bo5");
    expect(resolveSeriesLengthTieBreak(counts(1, 0, 3))).toBe("bo3");
    expect(resolveSeriesLengthTieBreak(counts(0, 0, 5))).toBe("bo3");
  });

  it("a 0-0-0 tie (nobody voted) resolves to bo3", () => {
    expect(resolveSeriesLengthTieBreak(counts(0, 0, 0))).toBe("bo3");
  });

  it("an exact 2-2-2 tie resolves to bo3", () => {
    expect(resolveSeriesLengthTieBreak(counts(2, 2, 2))).toBe("bo3");
  });

  it("bo5 ahead of bo3 wins regardless of bo7's count", () => {
    expect(resolveSeriesLengthTieBreak(counts(0, 2, 2))).toBe("bo5");
  });

  it("a tie between bo3 and bo5 favors bo3", () => {
    expect(resolveSeriesLengthTieBreak(counts(2, 0, 2))).toBe("bo3");
    expect(resolveSeriesLengthTieBreak(counts(2, 2, 0))).toBe("bo3");
  });
});

describe("resolveSeriesLengthWinner", () => {
  const counts = (bo3: number, bo5: number, bo7: number): Record<SeriesLength, number> => ({ bo3, bo5, bo7 });

  it("returns null while the vote is still open", () => {
    expect(resolveSeriesLengthWinner(counts(0, 0, 0))).toBeNull();
    expect(resolveSeriesLengthWinner(counts(2, 2, 1))).toBeNull();
  });

  it("bo3 and bo5 win outright on 3", () => {
    expect(resolveSeriesLengthWinner(counts(3, 0, 0))).toBe("bo3");
    expect(resolveSeriesLengthWinner(counts(0, 3, 0))).toBe("bo5");
  });

  // The whole point of the change: 3 is no longer enough for the longest series.
  it("bo7 needs 4, not 3", () => {
    expect(resolveSeriesLengthWinner(counts(0, 0, 3))).toBeNull();
    expect(resolveSeriesLengthWinner(counts(0, 0, 4))).toBe("bo7");
  });

  it("a simultaneous 3-3 between bo3 and bo5 goes to the shorter series", () => {
    expect(resolveSeriesLengthWinner(counts(3, 3, 0))).toBe("bo3");
  });

  // Newly reachable: before bo7's bar moved to 4, a full lobby could only stall on 2-2-2.
  it("a full lobby that stalls with bo7 leading on 3 falls back to the best of bo3/bo5", () => {
    expect(resolveSeriesLengthWinner(counts(2, 1, 3))).toBe("bo3");
    expect(resolveSeriesLengthWinner(counts(1, 2, 3))).toBe("bo5");
  });

  it("an exact 2-2-2 split at 6 votes still resolves to bo3", () => {
    expect(resolveSeriesLengthWinner(counts(2, 2, 2))).toBe("bo3");
  });
});

// The draft's turn-level compare-and-swap. Exercised through a fake PostgREST builder that
// records the filters it was handed and answers with whatever rows the scenario says the
// conditional UPDATE would have matched — the only two outcomes that matter are "I still own
// this turn" and "someone (a captain, or the sweep) took it first".
function fakeTurnClient(matchedRows: { id: string }[]) {
  const calls: { update?: Record<string, unknown>; eq: [string, unknown][]; is: [string, unknown][] } = { eq: [], is: [] };
  const builder: Record<string, unknown> = {
    update(values: Record<string, unknown>) {
      calls.update = values;
      return builder;
    },
    eq(col: string, val: unknown) {
      calls.eq.push([col, val]);
      return builder;
    },
    is(col: string, val: unknown) {
      calls.is.push([col, val]);
      return builder;
    },
    select: async () => ({ data: matchedRows }),
  };
  return { client: { from: () => builder }, calls };
}

describe("claimDraftTurn", () => {
  const STAMP = "2026-10-05T12:00:00.000Z";

  it("wins the turn when vote_started_at still holds the stamp it read, and re-stamps it", async () => {
    const { client, calls } = fakeTurnClient([{ id: "series-1" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await claimDraftTurn(client as any, "series-1", STAMP)).toBe(true);
    expect(calls.eq).toEqual([
      ["id", "series-1"],
      ["vote_started_at", STAMP],
    ]);
    // The re-stamp is what invalidates every other holder of this turn's token.
    const written = calls.update?.vote_started_at as string;
    expect(Date.parse(written)).toBeGreaterThan(Date.parse(STAMP));
  });

  it("loses the turn when the conditional update matches nothing", async () => {
    const { client } = fakeTurnClient([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await claimDraftTurn(client as any, "series-1", STAMP)).toBe(false);
  });

  it("filters with .is rather than .eq for a null stamp, which PostgREST can't match on .eq", async () => {
    const { client, calls } = fakeTurnClient([{ id: "series-1" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await claimDraftTurn(client as any, "series-1", null)).toBe(true);
    expect(calls.eq).toEqual([["id", "series-1"]]);
    expect(calls.is).toEqual([["vote_started_at", null]]);
  });
});
