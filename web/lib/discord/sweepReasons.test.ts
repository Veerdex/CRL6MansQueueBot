import { describe, expect, it } from "vitest";
import { parseSweepRequest, sweepRuns } from "./sweepReasons";

describe("parseSweepRequest", () => {
  it("runs the whole sweep for a manual call with no reasons", () => {
    expect(parseSweepRequest(null)).toEqual({ kind: "all" });
    expect(parseSweepRequest({})).toEqual({ kind: "all" });
    expect(parseSweepRequest({ tier: "minute" })).toEqual({ kind: "all" });
  });

  it("keeps only the reasons it knows", () => {
    const req = parseSweepRequest({ reasons: ["sub_expiry", "not_a_reason", "season_reset"] });
    expect(req.kind).toBe("reasons");
    expect(sweepRuns(req, "sub_expiry")).toBe(true);
    expect(sweepRuns(req, "season_reset")).toBe(true);
    expect(sweepRuns(req, "series_expiry")).toBe(false);
  });

  it("falls back to the whole sweep when no reason is recognised", () => {
    expect(parseSweepRequest({ reasons: ["from_the_future"] })).toEqual({ kind: "all" });
    expect(parseSweepRequest({ reasons: [] })).toEqual({ kind: "all" });
  });
});

describe("sweepRuns", () => {
  it("matches when any of the given reasons was requested", () => {
    const req = parseSweepRequest({ reasons: ["draft_pick"] });
    expect(sweepRuns(req, "series_length_vote", "vote_silence", "draft_pick")).toBe(true);
    expect(sweepRuns(req, "orphan_channels", "match_role_release")).toBe(false);
  });

  it("runs everything for a whole-sweep request", () => {
    expect(sweepRuns({ kind: "all" }, "queue_inactivity")).toBe(true);
  });
});
