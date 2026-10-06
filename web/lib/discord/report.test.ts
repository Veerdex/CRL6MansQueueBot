import { describe, expect, it } from "vitest";
import { reportResultEmbed, winnerLoserOddsPct } from "./report";

// The pre-match win chance shown beside each side on the report summary (and on /correct's
// re-post of it).
describe("winnerLoserOddsPct", () => {
  it("reads P(A wins) straight off when Team A won", () => {
    expect(winnerLoserOddsPct(0.43, "A")).toEqual({ winner: 43, loser: 57 });
  });

  it("inverts it when Team B won — the headers are labelled by result, not by team", () => {
    expect(winnerLoserOddsPct(0.43, "B")).toEqual({ winner: 57, loser: 43 });
  });

  // One side is rounded and the other derived from it. Rounding both independently would let
  // 0.505 print as "51%" next to "50%", or 0.495 as "50%" next to "51%".
  it("always totals exactly 100, including at the rounding boundary", () => {
    for (const p of [0, 0.004, 0.495, 0.5, 0.505, 0.666, 0.995, 1]) {
      for (const winner of ["A", "B"] as const) {
        const odds = winnerLoserOddsPct(p, winner);
        expect(odds.winner + odds.loser).toBe(100);
      }
    }
    expect(winnerLoserOddsPct(0.505, "A")).toEqual({ winner: 51, loser: 49 });
    expect(winnerLoserOddsPct(0.495, "A")).toEqual({ winner: 50, loser: 50 });
  });
});

describe("reportResultEmbed", () => {
  const lines = { winners: ["w1", "w2", "w3"], losers: ["l1", "l2", "l3"] };

  it("puts each side's win chance in its header", () => {
    const embed = reportResultEmbed("A", "ABC12", lines.winners, lines.losers, false, null, { winner: 43, loser: 57 });
    expect(embed.description).toContain("**Winners (43%)**");
    expect(embed.description).toContain("**Losers (57%)**");
  });

  // Odds are omitted, not zeroed, when they can't be computed — an incomplete roster, or a
  // correction on a match predating the mmr_before snapshot.
  it("falls back to bare headers when there are no odds to show", () => {
    const embed = reportResultEmbed("A", "ABC12", lines.winners, lines.losers, false, null);
    expect(embed.description).toContain("**Winners**");
    expect(embed.description).toContain("**Losers**");
    expect(embed.description).not.toContain("%)**");
  });

  it("leaves the rest of the summary alone", () => {
    const embed = reportResultEmbed("B", "ABC12", lines.winners, lines.losers, false, "bo5", { winner: 50, loser: 50 });
    expect(embed.title).toBe("Match Reported — Team B Wins!");
    expect(embed.description).toContain("**Match #ABC12**");
    expect(embed.description).toContain("Best of 5");
    expect(embed.description).toContain("Run /correct");
    for (const line of [...lines.winners, ...lines.losers]) expect(embed.description).toContain(line);
  });
});
