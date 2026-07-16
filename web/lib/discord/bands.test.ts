import { describe, expect, it } from "vitest";
import { computeBandChange, targetBandForPercentile, type BandCutoffConfig } from "./bands";

const config: BandCutoffConfig = {
  graceGames: 3,
  hysteresisPct: 5,
  garnetCutoff: 40,
  emeraldCutoff: 70,
  sapphireCutoff: 90,
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
});
