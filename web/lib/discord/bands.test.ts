import { describe, expect, it } from "vitest";
import {
  computeBandChange,
  computeBandPercentiles,
  computeBandThresholdMmr,
  targetBandForPercentile,
  type BandCutoffConfig,
} from "./bands";

const config: BandCutoffConfig = {
  graceGames: 3,
  hysteresisMmr: 7,
  garnetCutoff: 40,
  emeraldCutoff: 70,
  sapphireCutoff: 90,
  graceInactivityDays: 0, // disabled by default so pre-existing games-based-grace tests are unaffected
};

// Arbitrary threshold MMRs for the computeBandChange tests below — these don't need to be
// internally consistent with `config`'s percentile cutoffs, since computeBandChange takes
// percentile and threshold MMR as independent inputs (percentile decides promotion/demotion
// direction via targetBandForPercentile; threshold MMR only gates the hysteresis buffer check).
const thresholds: Partial<Record<"Garnet" | "Emerald" | "Sapphire", number>> = {
  Garnet: 400,
  Emerald: 700,
  Sapphire: 1000,
};

describe("targetBandForPercentile", () => {
  it("assigns Iron below the Garnet cutoff", () => {
    expect(targetBandForPercentile(39.9, config)).toBe("Iron");
  });

  it("assigns Garnet at and above its cutoff, below Emerald's", () => {
    expect(targetBandForPercentile(40, config)).toBe("Garnet");
    expect(targetBandForPercentile(69.9, config)).toBe("Garnet");
  });

  it("assigns Emerald at and above its cutoff, below Sapphire's", () => {
    expect(targetBandForPercentile(70, config)).toBe("Emerald");
    expect(targetBandForPercentile(89.9, config)).toBe("Emerald");
  });

  it("assigns Sapphire at and above its cutoff", () => {
    expect(targetBandForPercentile(90, config)).toBe("Sapphire");
    expect(targetBandForPercentile(100, config)).toBe("Sapphire");
  });
});

describe("computeBandPercentiles", () => {
  // Mirrors the 9-player example that motivated the "mmr" mode: 100%, 77.7%, 64%, 41.5%, 25%,
  // 18.6%, 3%, 1.2%, 0% by (mmr - min) / range, vs. the evenly-spaced 0/12.5/25/.../100 that
  // "position" mode gives the same pool regardless of how the MMR gaps actually fall.
  const pool = [
    { id: "a", mmr: 1426, total_games_played: 8 },
    { id: "b", mmr: 1300, total_games_played: 3 },
    { id: "c", mmr: 1223, total_games_played: 5 },
    { id: "d", mmr: 1096, total_games_played: 5 },
    { id: "e", mmr: 1003, total_games_played: 4 },
    { id: "f", mmr: 967, total_games_played: 4 },
    { id: "g", mmr: 879, total_games_played: 8 },
    { id: "h", mmr: 869, total_games_played: 6 },
    { id: "i", mmr: 862, total_games_played: 9 },
  ];

  it("'position' mode spaces percentiles evenly by rank, ignoring MMR gaps", () => {
    const result = computeBandPercentiles(pool, "position");
    expect(result.get("i")).toBeCloseTo((0 / 9) * 100);
    expect(result.get("h")).toBeCloseTo((1 / 9) * 100);
    expect(result.get("a")).toBeCloseTo((8 / 9) * 100);
  });

  it("'mmr' mode spaces percentiles by where raw MMR falls in the pool's range", () => {
    const result = computeBandPercentiles(pool, "mmr");
    expect(result.get("a")).toBeCloseTo(100, 0);
    expect(result.get("b")).toBeCloseTo(77.7, 0);
    expect(result.get("c")).toBeCloseTo(64, 0);
    expect(result.get("d")).toBeCloseTo(41.5, 0);
    expect(result.get("e")).toBeCloseTo(25, 0);
    expect(result.get("f")).toBeCloseTo(18.6, 0);
    expect(result.get("g")).toBeCloseTo(3, 0);
    expect(result.get("h")).toBeCloseTo(1.2, 0);
    expect(result.get("i")).toBeCloseTo(0, 0);
  });

  it("'mmr' mode parks a fully-tied pool at the midpoint instead of dividing by zero", () => {
    const tied = [
      { id: "x", mmr: 500, total_games_played: 1 },
      { id: "y", mmr: 500, total_games_played: 1 },
    ];
    const result = computeBandPercentiles(tied, "mmr");
    expect(result.get("x")).toBe(50);
    expect(result.get("y")).toBe(50);
  });
});

describe("computeBandThresholdMmr", () => {
  // Same 9-player pool as computeBandPercentiles above, with the live server's actual band
  // cutoffs (20/50/80 — see memory: live_band_cutoff_override.md) rather than the 40/70/90 code
  // defaults, since those are the exact figures verified against the user before implementation.
  const pool = [
    { id: "a", mmr: 1426, total_games_played: 8 },
    { id: "b", mmr: 1300, total_games_played: 3 },
    { id: "c", mmr: 1223, total_games_played: 5 },
    { id: "d", mmr: 1096, total_games_played: 5 },
    { id: "e", mmr: 1003, total_games_played: 4 },
    { id: "f", mmr: 967, total_games_played: 4 },
    { id: "g", mmr: 879, total_games_played: 8 },
    { id: "h", mmr: 869, total_games_played: 6 },
    { id: "i", mmr: 862, total_games_played: 9 },
  ];

  it("'position' mode returns the MMR of the player exactly at the cutoff rank (floor rounding)", () => {
    expect(computeBandThresholdMmr(pool, 20, "position")).toBe(879); // g
    expect(computeBandThresholdMmr(pool, 50, "position")).toBe(1096); // d
    expect(computeBandThresholdMmr(pool, 80, "position")).toBe(1426); // a
  });

  it("'mmr' mode linearly interpolates within the pool's MMR range", () => {
    expect(computeBandThresholdMmr(pool, 20, "mmr")).toBeCloseTo(974.8);
    expect(computeBandThresholdMmr(pool, 50, "mmr")).toBeCloseTo(1144.0);
    expect(computeBandThresholdMmr(pool, 80, "mmr")).toBeCloseTo(1313.2);
  });

  it("falls back to the top player when the computed rank is out of range low", () => {
    expect(computeBandThresholdMmr(pool, 100, "position")).toBe(1426); // a, the top player
  });

  it("falls back to the bottom player when the computed rank is out of range high", () => {
    expect(computeBandThresholdMmr(pool, 0, "position")).toBe(862); // i, the bottom player
  });
});

describe("computeBandChange", () => {
  it("places a newly-crossed player into their percentile band regardless of prior band", () => {
    const player = { band: null, band_games_played: 0, is_placed: false, mmr: 800 };
    const change = computeBandChange(player, 75, true, config, thresholds, false);
    expect(change).toEqual({ action: "placed", targetBand: "Emerald" });
  });

  it("promotes immediately when percentile crosses into a higher band, no grace/hysteresis check", () => {
    const player = { band: "Iron" as const, band_games_played: 0, is_placed: true, mmr: 100 };
    const change = computeBandChange(player, 45, false, config, thresholds, false);
    expect(change).toEqual({ action: "promoted", targetBand: "Garnet" });
  });

  it("does nothing when the target band matches the current band", () => {
    const player = { band: "Garnet" as const, band_games_played: 10, is_placed: true, mmr: 500 };
    const change = computeBandChange(player, 50, false, config, thresholds, false);
    expect(change).toBeNull();
  });

  it("blocks demotion during the grace period even if percentile has cratered", () => {
    const player = { band: "Sapphire" as const, band_games_played: 2, is_placed: true, mmr: 5 };
    const change = computeBandChange(player, 10, false, config, thresholds, false);
    expect(change).toBeNull();
  });

  it("demotes once grace has expired and the player is beyond the hysteresis buffer", () => {
    // Sapphire's threshold MMR is 1000; hysteresis is 7, so anything below 993 demotes.
    const player = { band: "Sapphire" as const, band_games_played: 5, is_placed: true, mmr: 992 };
    const change = computeBandChange(player, 84, false, config, thresholds, false);
    expect(change).toEqual({ action: "demoted", targetBand: "Emerald" });
  });

  it("holds a player inside the hysteresis buffer even after grace expires", () => {
    const player = { band: "Sapphire" as const, band_games_played: 5, is_placed: true, mmr: 995 };
    const change = computeBandChange(player, 86, false, config, thresholds, false);
    expect(change).toBeNull();
  });

  it("holds exactly at the hysteresis boundary (not strictly below threshold - hysteresisMmr)", () => {
    const player = { band: "Sapphire" as const, band_games_played: 5, is_placed: true, mmr: 993 };
    const change = computeBandChange(player, 85, false, config, thresholds, false);
    expect(change).toBeNull();
  });

  it("force bypasses grace and demotes immediately even inside the grace period", () => {
    const player = { band: "Sapphire" as const, band_games_played: 0, is_placed: true, mmr: 2000 };
    const change = computeBandChange(player, 10, false, config, thresholds, false, { force: true });
    expect(change).toEqual({ action: "demoted", targetBand: "Iron" });
  });

  it("force bypasses hysteresis too, demoting even inside the buffer", () => {
    const player = { band: "Sapphire" as const, band_games_played: 0, is_placed: true, mmr: 995 };
    const change = computeBandChange(player, 86, false, config, thresholds, false, { force: true });
    expect(change).toEqual({ action: "demoted", targetBand: "Emerald" });
  });

  it("force does not affect promotions or same-band results", () => {
    const player = { band: "Garnet" as const, band_games_played: 0, is_placed: true, mmr: 500 };
    expect(computeBandChange(player, 75, false, config, thresholds, false, { force: true })).toEqual({
      action: "promoted",
      targetBand: "Emerald",
    });
    expect(computeBandChange(player, 50, false, config, thresholds, false, { force: true })).toBeNull();
  });
});

describe("computeBandChange — surpassed-by-a-lower-band-player bypass", () => {
  // Live production example (see CLAUDE.md, "Bands / ranks"): Luna sat at Garnet/847 MMR while
  // Arya (882) and HeyItsNate (862) — both higher raw MMR — were correctly banded Iron, an
  // ordering violation caused by grace/hysteresis blocking her demotion indefinitely while other
  // players' independent improvement climbed past her rather than her own MMR falling.
  it("bypasses grace, demoting immediately even inside the grace period", () => {
    const player = { band: "Sapphire" as const, band_games_played: 0, is_placed: true, mmr: 2000 };
    const change = computeBandChange(player, 10, false, config, thresholds, true);
    expect(change).toEqual({ action: "demoted", targetBand: "Iron" });
  });

  it("bypasses hysteresis too, demoting even inside the buffer", () => {
    const player = { band: "Sapphire" as const, band_games_played: 5, is_placed: true, mmr: 995 };
    const change = computeBandChange(player, 86, false, config, thresholds, true);
    expect(change).toEqual({ action: "demoted", targetBand: "Emerald" });
  });

  it("does not affect promotions or same-band results", () => {
    const player = { band: "Garnet" as const, band_games_played: 0, is_placed: true, mmr: 500 };
    expect(computeBandChange(player, 75, false, config, thresholds, true)).toEqual({
      action: "promoted",
      targetBand: "Emerald",
    });
    expect(computeBandChange(player, 50, false, config, thresholds, true)).toBeNull();
  });
});

describe("computeBandChange — grace-inactivity bypass", () => {
  const inactivityConfig: BandCutoffConfig = { ...config, graceInactivityDays: 7 };
  const now = new Date("2026-08-07T00:00:00.000Z");
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

  it("still blocks demotion within the grace period for an actively-playing player", () => {
    const player = { band: "Sapphire" as const, band_games_played: 0, is_placed: true, last_rank_game_at: daysAgo(1), mmr: 500 };
    const change = computeBandChange(player, 10, false, inactivityConfig, thresholds, false, { now });
    expect(change).toBeNull();
  });

  it("bypasses grace once inactivity crosses the threshold, still subject to hysteresis", () => {
    // Sapphire's threshold MMR is 1000; hysteresis is 7, so anything below 993 demotes.
    const player = { band: "Sapphire" as const, band_games_played: 0, is_placed: true, last_rank_game_at: daysAgo(11), mmr: 500 };
    const change = computeBandChange(player, 10, false, inactivityConfig, thresholds, false, { now });
    expect(change).toEqual({ action: "demoted", targetBand: "Iron" });
  });

  it("inactivity bypass alone doesn't skip hysteresis — still holds inside the buffer", () => {
    const player = { band: "Sapphire" as const, band_games_played: 0, is_placed: true, last_rank_game_at: daysAgo(11), mmr: 995 };
    const change = computeBandChange(player, 86, false, inactivityConfig, thresholds, false, { now });
    expect(change).toBeNull();
  });

  it("triggers at exactly the threshold boundary (inclusive)", () => {
    const player = { band: "Sapphire" as const, band_games_played: 0, is_placed: true, last_rank_game_at: daysAgo(7), mmr: 500 };
    const change = computeBandChange(player, 10, false, inactivityConfig, thresholds, false, { now });
    expect(change).toEqual({ action: "demoted", targetBand: "Iron" });
  });

  it("is a no-op when disabled (graceInactivityDays <= 0), even for a very stale player", () => {
    const player = { band: "Sapphire" as const, band_games_played: 0, is_placed: true, last_rank_game_at: daysAgo(365), mmr: 10 };
    const change = computeBandChange(player, 10, false, config, thresholds, false, { now });
    expect(change).toBeNull();
  });

  it("does not trigger when last_rank_game_at is unknown (null)", () => {
    const player = { band: "Sapphire" as const, band_games_played: 0, is_placed: true, last_rank_game_at: null, mmr: 10 };
    const change = computeBandChange(player, 10, false, inactivityConfig, thresholds, false, { now });
    expect(change).toBeNull();
  });
});
