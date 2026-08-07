import { describe, expect, it } from "vitest";
import { computeBandChange, targetBandForPercentile, type BandCutoffConfig } from "./bands";

const config: BandCutoffConfig = {
  graceGames: 3,
  hysteresisPct: 5,
  garnetCutoff: 40,
  emeraldCutoff: 70,
  sapphireCutoff: 90,
  graceInactivityDays: 0, // disabled by default so pre-existing games-based-grace tests are unaffected
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

describe("computeBandChange", () => {
  it("places a newly-crossed player into their percentile band regardless of prior band", () => {
    const player = { band: null, band_games_played: 0, is_placed: false };
    const change = computeBandChange(player, 75, true, config);
    expect(change).toEqual({ action: "placed", targetBand: "Emerald" });
  });

  it("promotes immediately when percentile crosses into a higher band, no grace/hysteresis check", () => {
    const player = { band: "Iron" as const, band_games_played: 0, is_placed: true };
    const change = computeBandChange(player, 45, false, config);
    expect(change).toEqual({ action: "promoted", targetBand: "Garnet" });
  });

  it("does nothing when the target band matches the current band", () => {
    const player = { band: "Garnet" as const, band_games_played: 10, is_placed: true };
    const change = computeBandChange(player, 50, false, config);
    expect(change).toBeNull();
  });

  it("blocks demotion during the grace period even if percentile has cratered", () => {
    const player = { band: "Sapphire" as const, band_games_played: 2, is_placed: true };
    const change = computeBandChange(player, 10, false, config);
    expect(change).toBeNull();
  });

  it("demotes once grace has expired and the player is beyond the hysteresis buffer", () => {
    // Sapphire's promotion-in threshold is 90; hysteresis is 5, so anything below 85 demotes.
    const player = { band: "Sapphire" as const, band_games_played: 5, is_placed: true };
    const change = computeBandChange(player, 84, false, config);
    expect(change).toEqual({ action: "demoted", targetBand: "Emerald" });
  });

  it("holds a player inside the hysteresis buffer even after grace expires", () => {
    const player = { band: "Sapphire" as const, band_games_played: 5, is_placed: true };
    const change = computeBandChange(player, 86, false, config);
    expect(change).toBeNull();
  });

  it("holds exactly at the hysteresis boundary (not strictly below threshold - hysteresisPct)", () => {
    const player = { band: "Sapphire" as const, band_games_played: 5, is_placed: true };
    const change = computeBandChange(player, 85, false, config);
    expect(change).toBeNull();
  });

  it("force bypasses grace and demotes immediately even inside the grace period", () => {
    const player = { band: "Sapphire" as const, band_games_played: 0, is_placed: true };
    const change = computeBandChange(player, 10, false, config, { force: true });
    expect(change).toEqual({ action: "demoted", targetBand: "Iron" });
  });

  it("force bypasses hysteresis too, demoting even inside the buffer", () => {
    const player = { band: "Sapphire" as const, band_games_played: 0, is_placed: true };
    const change = computeBandChange(player, 86, false, config, { force: true });
    expect(change).toEqual({ action: "demoted", targetBand: "Emerald" });
  });

  it("force does not affect promotions or same-band results", () => {
    const player = { band: "Garnet" as const, band_games_played: 0, is_placed: true };
    expect(computeBandChange(player, 75, false, config, { force: true })).toEqual({ action: "promoted", targetBand: "Emerald" });
    expect(computeBandChange(player, 50, false, config, { force: true })).toBeNull();
  });
});

describe("computeBandChange — grace-inactivity bypass", () => {
  const inactivityConfig: BandCutoffConfig = { ...config, graceInactivityDays: 7 };
  const now = new Date("2026-08-07T00:00:00.000Z");
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

  it("still blocks demotion within the grace period for an actively-playing player", () => {
    const player = { band: "Sapphire" as const, band_games_played: 0, is_placed: true, last_rank_game_at: daysAgo(1) };
    const change = computeBandChange(player, 10, false, inactivityConfig, { now });
    expect(change).toBeNull();
  });

  it("bypasses grace once inactivity crosses the threshold, still subject to hysteresis", () => {
    // Sapphire's promotion-in threshold is 90; hysteresis is 5, so anything below 85 demotes.
    const player = { band: "Sapphire" as const, band_games_played: 0, is_placed: true, last_rank_game_at: daysAgo(11) };
    const change = computeBandChange(player, 10, false, inactivityConfig, { now });
    expect(change).toEqual({ action: "demoted", targetBand: "Iron" });
  });

  it("inactivity bypass alone doesn't skip hysteresis — still holds inside the buffer", () => {
    const player = { band: "Sapphire" as const, band_games_played: 0, is_placed: true, last_rank_game_at: daysAgo(11) };
    const change = computeBandChange(player, 86, false, inactivityConfig, { now });
    expect(change).toBeNull();
  });

  it("triggers at exactly the threshold boundary (inclusive)", () => {
    const player = { band: "Sapphire" as const, band_games_played: 0, is_placed: true, last_rank_game_at: daysAgo(7) };
    const change = computeBandChange(player, 10, false, inactivityConfig, { now });
    expect(change).toEqual({ action: "demoted", targetBand: "Iron" });
  });

  it("is a no-op when disabled (graceInactivityDays <= 0), even for a very stale player", () => {
    const player = { band: "Sapphire" as const, band_games_played: 0, is_placed: true, last_rank_game_at: daysAgo(365) };
    const change = computeBandChange(player, 10, false, config, { now });
    expect(change).toBeNull();
  });

  it("does not trigger when last_rank_game_at is unknown (null)", () => {
    const player = { band: "Sapphire" as const, band_games_played: 0, is_placed: true, last_rank_game_at: null };
    const change = computeBandChange(player, 10, false, inactivityConfig, { now });
    expect(change).toBeNull();
  });
});
