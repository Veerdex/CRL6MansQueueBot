import { describe, it, expect } from "vitest";
import { reconstructMmrHistory } from "./reconstructMmrHistory";
import { decayMmr, computeSafeMedian } from "./seasonDecay";

describe("reconstructMmrHistory", () => {
  it("replays a simple chronological delta sequence and captures pre-event mmrBefore", () => {
    const result = reconstructMmrHistory({
      playerIds: ["p1"],
      seriesBatches: [
        { seriesId: "s1", seasonId: "season1", reportedAt: "2026-01-01T00:00:00Z", isRank: true, players: [{ playerId: "p1", mmrDelta: 20 }] },
        { seriesId: "s2", seasonId: "season1", reportedAt: "2026-01-02T00:00:00Z", isRank: true, players: [{ playerId: "p1", mmrDelta: -5 }] },
      ],
      adminAdjustments: [],
      seasons: [],
      seasonHistoryCheckpoints: [],
      decayFactor: 0.25,
      placementGamesRequired: 10,
    });

    expect(result.mmrBeforeBySeries.get("s1")?.get("p1")).toBe(0);
    expect(result.mmrBeforeBySeries.get("s2")?.get("p1")).toBe(20);
    expect(result.finalMmrByPlayer.get("p1")).toBe(15);
  });

  it("orders events by real timestamp regardless of input array order", () => {
    const result = reconstructMmrHistory({
      playerIds: ["p1"],
      seriesBatches: [
        { seriesId: "later", seasonId: "season1", reportedAt: "2026-01-05T00:00:00Z", isRank: true, players: [{ playerId: "p1", mmrDelta: 100 }] },
        { seriesId: "earlier", seasonId: "season1", reportedAt: "2026-01-01T00:00:00Z", isRank: true, players: [{ playerId: "p1", mmrDelta: 10 }] },
      ],
      adminAdjustments: [],
      seasons: [],
      seasonHistoryCheckpoints: [],
      decayFactor: 0.25,
      placementGamesRequired: 10,
    });

    expect(result.mmrBeforeBySeries.get("earlier")?.get("p1")).toBe(0);
    expect(result.mmrBeforeBySeries.get("later")?.get("p1")).toBe(10);
  });

  it("records a mmrBefore snapshot for universal-queue series with a zero delta and no rank-games increment", () => {
    const result = reconstructMmrHistory({
      playerIds: ["p1"],
      seriesBatches: [
        { seriesId: "u1", seasonId: "season1", reportedAt: "2026-01-01T00:00:00Z", isRank: false, players: [{ playerId: "p1", mmrDelta: 0 }] },
      ],
      adminAdjustments: [],
      // A season boundary right after the universal series confirms it never counted toward
      // placement (rank games stayed 0), so the decay pool excludes p1 even though a series
      // happened.
      seasons: [{ seasonId: "season1", seasonNumber: 1 }],
      seasonHistoryCheckpoints: [],
      decayFactor: 0.25,
      placementGamesRequired: 1,
    });

    expect(result.mmrBeforeBySeries.get("u1")?.get("p1")).toBe(0);
    expect(result.finalMmrByPlayer.get("p1")).toBe(0);
  });

  it("batches all players in one series off the same pre-event snapshot", () => {
    const result = reconstructMmrHistory({
      playerIds: ["p1", "p2"],
      seriesBatches: [
        {
          seriesId: "s1",
          seasonId: "season1",
          reportedAt: "2026-01-01T00:00:00Z",
          isRank: true,
          players: [
            { playerId: "p1", mmrDelta: 10 },
            { playerId: "p2", mmrDelta: -10 },
          ],
        },
        {
          seriesId: "s2",
          seasonId: "season1",
          reportedAt: "2026-01-02T00:00:00Z",
          isRank: true,
          players: [
            { playerId: "p1", mmrDelta: 5 },
            { playerId: "p2", mmrDelta: 5 },
          ],
        },
      ],
      adminAdjustments: [],
      seasons: [],
      seasonHistoryCheckpoints: [],
      decayFactor: 0.25,
      placementGamesRequired: 10,
    });

    // Both players' s2 snapshot must reflect s1's applied deltas, not each other's s2 delta.
    expect(result.mmrBeforeBySeries.get("s2")?.get("p1")).toBe(10);
    expect(result.mmrBeforeBySeries.get("s2")?.get("p2")).toBe(-10);
    expect(result.finalMmrByPlayer.get("p1")).toBe(15);
    expect(result.finalMmrByPlayer.get("p2")).toBe(-5);
  });

  it("applies an admin adjust-mmr event as an absolute override at its timeline position", () => {
    const result = reconstructMmrHistory({
      playerIds: ["p1"],
      seriesBatches: [
        { seriesId: "s1", seasonId: "season1", reportedAt: "2026-01-01T00:00:00Z", isRank: true, players: [{ playerId: "p1", mmrDelta: 20 }] },
        { seriesId: "s2", seasonId: "season1", reportedAt: "2026-01-03T00:00:00Z", isRank: true, players: [{ playerId: "p1", mmrDelta: 5 }] },
      ],
      adminAdjustments: [{ playerId: "p1", at: "2026-01-02T00:00:00Z", newMmr: 500 }],
      seasons: [],
      seasonHistoryCheckpoints: [],
      decayFactor: 0.25,
      placementGamesRequired: 10,
    });

    expect(result.mmrBeforeBySeries.get("s1")?.get("p1")).toBe(0);
    // s2 must see the admin override (500), not the raw post-s1 value (20).
    expect(result.mmrBeforeBySeries.get("s2")?.get("p1")).toBe(500);
    expect(result.finalMmrByPlayer.get("p1")).toBe(505);
  });

  it("applies real season-close decay only to players meeting placementGamesRequired, matching decayMmr/computeSafeMedian directly", () => {
    // p1: 10 rank games (placed), ends at mmr 100. p2: 1 rank game (not placed under a
    // requirement of 5), ends at mmr 200 — must be excluded from both the median and the decay.
    const seriesBatches = Array.from({ length: 10 }, (_, i) => ({
      seriesId: `p1-s${i}`,
      seasonId: "season1",
      reportedAt: `2026-01-01T00:${String(i).padStart(2, "0")}:00Z`,
      isRank: true,
      players: [{ playerId: "p1", mmrDelta: 10 }],
    }));
    seriesBatches.push({
      seriesId: "p2-s0",
      seasonId: "season1",
      reportedAt: "2026-01-01T00:00:30Z",
      isRank: true,
      players: [{ playerId: "p2", mmrDelta: 200 }],
    });

    const result = reconstructMmrHistory({
      playerIds: ["p1", "p2"],
      seriesBatches,
      adminAdjustments: [],
      seasons: [{ seasonId: "season1", seasonNumber: 1 }],
      seasonHistoryCheckpoints: [],
      decayFactor: 0.25,
      placementGamesRequired: 5,
    });

    const expectedP1 = decayMmr(100, computeSafeMedian([100]), 0.25);
    expect(result.finalMmrByPlayer.get("p1")).toBeCloseTo(expectedP1, 10);
    // p2 never crossed placementGamesRequired, so decay must not touch them.
    expect(result.finalMmrByPlayer.get("p2")).toBe(200);
  });

  it("reconstructs decay for a season with zero reported series, anchored after the prior season's decay point", () => {
    const result = reconstructMmrHistory({
      playerIds: ["p1"],
      seriesBatches: Array.from({ length: 5 }, (_, i) => ({
        seriesId: `s${i}`,
        seasonId: "season1",
        reportedAt: `2026-01-01T00:0${i}:00Z`,
        isRank: true,
        players: [{ playerId: "p1", mmrDelta: 20 }],
      })),
      adminAdjustments: [],
      // season2 has no series at all (player sat out that whole season) but must still decay.
      seasons: [
        { seasonId: "season1", seasonNumber: 1 },
        { seasonId: "season2", seasonNumber: 2 },
      ],
      seasonHistoryCheckpoints: [],
      decayFactor: 0.25,
      placementGamesRequired: 5,
    });

    const afterSeason1 = decayMmr(100, computeSafeMedian([100]), 0.25);
    const afterSeason2 = decayMmr(afterSeason1, computeSafeMedian([afterSeason1]), 0.25);
    expect(result.finalMmrByPlayer.get("p1")).toBeCloseTo(afterSeason2, 10);
  });

  it("snaps to a season_history checkpoint at season close and records a drift warning when it disagrees with the simulation", () => {
    const result = reconstructMmrHistory({
      playerIds: ["p1"],
      seriesBatches: Array.from({ length: 5 }, (_, i) => ({
        seriesId: `s${i}`,
        seasonId: "season1",
        reportedAt: `2026-01-01T00:0${i}:00Z`,
        isRank: true,
        players: [{ playerId: "p1", mmrDelta: 20 }],
      })),
      adminAdjustments: [],
      seasons: [{ seasonId: "season1", seasonNumber: 1 }],
      // Simulation lands p1 at 100 pre-decay; the recorded ground truth says 150 (e.g. from an
      // unmodeled mid-season correction) — the checkpoint should win, and a drift warning fires.
      seasonHistoryCheckpoints: [{ seasonId: "season1", playerId: "p1", mmrAtClose: 150 }],
      decayFactor: 0.25,
      placementGamesRequired: 5,
    });

    expect(result.driftWarnings).toHaveLength(1);
    expect(result.driftWarnings[0]).toMatchObject({ seasonId: "season1", playerId: "p1", simulatedPreDecayMmr: 100, recordedMmrAtClose: 150, drift: 50 });

    const expected = decayMmr(150, computeSafeMedian([150]), 0.25);
    expect(result.finalMmrByPlayer.get("p1")).toBeCloseTo(expected, 10);
  });

  it("does not record a drift warning when the simulation already matches the recorded checkpoint", () => {
    const result = reconstructMmrHistory({
      playerIds: ["p1"],
      seriesBatches: [{ seriesId: "s1", seasonId: "season1", reportedAt: "2026-01-01T00:00:00Z", isRank: true, players: [{ playerId: "p1", mmrDelta: 100 }] }],
      adminAdjustments: [],
      seasons: [{ seasonId: "season1", seasonNumber: 1 }],
      seasonHistoryCheckpoints: [{ seasonId: "season1", playerId: "p1", mmrAtClose: 100 }],
      decayFactor: 0.25,
      placementGamesRequired: 1,
    });

    expect(result.driftWarnings).toHaveLength(0);
  });

  it("leaves untouched players (never in any series) at 0 and excludes them from the decay median", () => {
    const result = reconstructMmrHistory({
      playerIds: ["p1", "neverPlayed"],
      seriesBatches: Array.from({ length: 5 }, (_, i) => ({
        seriesId: `s${i}`,
        seasonId: "season1",
        reportedAt: `2026-01-01T00:0${i}:00Z`,
        isRank: true,
        players: [{ playerId: "p1", mmrDelta: 20 }],
      })),
      adminAdjustments: [],
      seasons: [{ seasonId: "season1", seasonNumber: 1 }],
      seasonHistoryCheckpoints: [],
      decayFactor: 0.25,
      placementGamesRequired: 5,
    });

    expect(result.finalMmrByPlayer.get("neverPlayed")).toBe(0);
    // Confirms neverPlayed (0 rank games, below placementGamesRequired) was excluded from the
    // median/decay pool — if it had been included, p1's decay result would differ from the
    // single-player-pool expectation.
    const expected = decayMmr(100, computeSafeMedian([100]), 0.25);
    expect(result.finalMmrByPlayer.get("p1")).toBeCloseTo(expected, 10);
  });

  it("reconstructs every player's own first-ever match to raw MMR 0 (displaying as the live server's 1000 baseline), regardless of when they enter a shared multi-player timeline with no season boundary yet", () => {
    // Mirrors the live server's actual current state at the time this test was written: no
    // season has closed yet (seasons: [], so no decay events fire at all), and the live display
    // transform is mmr_scale=7.25 / mmr_shift=1000 (same real config pair CLAUDE.md's
    // "Negative-median pole bug" section already documents from production). Every player starts
    // at raw MMR 0 by construction (see reconstructMmrHistory's initial `mmr` map) — so
    // 0 * 7.25 + 1000 = 1000 is the expected "starting MMR" a fresh player should display as,
    // independent of how many games the rest of the pool has already played by the time this
    // player's own first series happens.
    const MMR_SCALE = 7.25;
    const MMR_SHIFT = 1000;
    const toDisplay = (mmr: number) => mmr * MMR_SCALE + MMR_SHIFT;

    // Veerdex plays every series from the start; kyurem and Melody only enter partway through the
    // timeline, once other players already have accumulated deltas — their own first series must
    // still reconstruct to 0, not be contaminated by the pool's activity.
    const result = reconstructMmrHistory({
      playerIds: ["Veerdex", "kyurem", "Melody"],
      seriesBatches: [
        { seriesId: "m1", seasonId: "season1", reportedAt: "2026-08-06T00:00:00Z", isRank: true, players: [{ playerId: "Veerdex", mmrDelta: 32 }] },
        { seriesId: "m2", seasonId: "season1", reportedAt: "2026-08-06T01:00:00Z", isRank: true, players: [{ playerId: "Veerdex", mmrDelta: -18 }] },
        { seriesId: "m3", seasonId: "season1", reportedAt: "2026-08-07T00:00:00Z", isRank: true, players: [{ playerId: "Veerdex", mmrDelta: 25 }, { playerId: "kyurem", mmrDelta: 40 }] },
        { seriesId: "m4", seasonId: "season1", reportedAt: "2026-08-08T00:00:00Z", isRank: true, players: [{ playerId: "kyurem", mmrDelta: -10 }, { playerId: "Melody", mmrDelta: 60 }] },
      ],
      adminAdjustments: [],
      seasons: [],
      seasonHistoryCheckpoints: [],
      decayFactor: 0.25,
      placementGamesRequired: 10,
    });

    expect(toDisplay(result.mmrBeforeBySeries.get("m1")!.get("Veerdex")!)).toBe(1000);
    expect(toDisplay(result.mmrBeforeBySeries.get("m3")!.get("kyurem")!)).toBe(1000);
    expect(toDisplay(result.mmrBeforeBySeries.get("m4")!.get("Melody")!)).toBe(1000);
    // Sanity check the other end too: Veerdex's second match sees the first match's applied
    // delta, not another fresh 1000 baseline.
    expect(toDisplay(result.mmrBeforeBySeries.get("m2")!.get("Veerdex")!)).toBe(toDisplay(32));
  });
});
