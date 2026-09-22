import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Band, PlayerRow, SeriesLength, VoteChoice } from "@/lib/supabase/types";

// renderFormationMessage derives the whole combined Match Found / vote / draft message from
// database state alone, so these tests drive it entirely through a fake client. Only the three
// things it can't compute locally are mocked out: streak decorations, rank emoji, and config.
vi.mock("./streaks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getStreakIds: async () => ({ onFireIds: new Set<string>(), coldIds: new Set<string>() }) };
});

vi.mock("./rest", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getRankEmoji: async (band: string | null) => `:${band ?? "unranked"}:`, discordFetch: async () => ({ id: "unused" }) };
});

// Live values, so the rendered MMR in these expectations matches what the server actually posts.
vi.mock("./config", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const values: Record<string, number> = { mmr_scale: 7.25, mmr_shift: 1000, vote_timeout_seconds: 120 };
  return { ...actual, getConfigNumber: async (key: string, fallback: number) => values[key] ?? fallback };
});

const { renderFormationMessage } = await import("./teamFormation");

function player(id: string, mmr: number, band: Band | null = "Sapphire"): PlayerRow {
  return {
    id,
    discord_id: `d-${id}`,
    display_name: id,
    mmr,
    peak_mmr: mmr,
    band,
    is_placed: band !== null,
    total_games_played: 10,
    rank_games_played: 10,
    band_games_played: 10,
    last_rank_game_at: null,
    is_prism: false,
    is_test_data: false,
    vote_default: null,
    avatar_url: null,
    created_at: "2026-01-01T00:00:00Z",
    role_sync_pending: false,
  };
}

const MEMBERS = [
  player("ace", 1200),
  player("blaze", 1150, "Garnet"),
  player("cinder", 1100),
  player("dusk", 1050, "Garnet"),
  player("ember", 1000, "Emerald"),
  player("flux", 950, null),
];

type Lobby = { player_id: string; team: "A" | "B" | null; is_captain: boolean };

type Scenario = {
  series: Record<string, unknown>;
  lobby?: Lobby[];
  lengthVotes?: SeriesLength[];
  formationVotes?: VoteChoice[];
};

// Minimal chainable stand-in for the PostgREST builder, answering only the four query shapes
// renderFormationMessage issues. Anything else throws rather than silently returning empty.
function fakeClient(s: Scenario) {
  const lobby = s.lobby ?? MEMBERS.map((m) => ({ player_id: m.id, team: null, is_captain: false }));
  return {
    from(table: string) {
      const rows = (() => {
        switch (table) {
          case "crl6mansqueuebot_series":
            return [s.series];
          case "crl6mansqueuebot_series_lobby":
            return lobby.map((r) => ({ ...r, series_id: "series-1" }));
          case "crl6mansqueuebot_players":
            return MEMBERS;
          case "crl6mansqueuebot_series_length_votes":
            return (s.lengthVotes ?? []).map((choice) => ({ choice }));
          case "crl6mansqueuebot_series_votes":
            return (s.formationVotes ?? []).map((choice) => ({ choice }));
          default:
            throw new Error(`unexpected table ${table}`);
        }
      })();
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        maybeSingle: async () => ({ data: rows[0] ?? null }),
        single: async () => ({ data: rows[0] ?? null }),
        then: (resolve: (v: { data: unknown[] }) => unknown) => Promise.resolve({ data: rows }).then(resolve),
      };
      return builder;
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const render = (s: Scenario, draftStatus?: string) => renderFormationMessage(fakeClient(s) as any, "series-1", draftStatus);

const BASE = { id: "series-1", bonus_day_multiplier: 1, series_length: null, series_length_vote_active: false, vote_result: null };
const fieldNames = (r: { embeds: unknown[] }) => ((r.embeds[0] as { fields: { name: string }[] }).fields ?? []).map((f) => f.name);
const embed = (r: { embeds: unknown[] }) =>
  r.embeds[0] as { description: string; color: number; fields: { name: string; value: string; inline?: boolean }[]; footer?: { text: string } };

describe("renderFormationMessage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("always carries the Match Found roster and pings every member in content", async () => {
    const result = await render({ series: BASE });
    expect(embed(result).description).toContain("### Match Found!");
    for (const m of MEMBERS) {
      expect(embed(result).description).toContain(`<@${m.discord_id}>`);
      expect(result.content).toContain(`<@${m.discord_id}>`);
    }
    // Display MMR is the underlying value through the configured scale/shift, per player.
    expect(embed(result).description).toContain(`${Math.round(1200 * 7.25 + 1000)} MMR`);
  });

  it("phase 1: draws the series-length tally with its buttons while the vote is active", async () => {
    const result = await render({ series: { ...BASE, series_length_vote_active: true }, lengthVotes: ["bo5", "bo5", "bo7"] });
    expect(fieldNames(result)).toEqual(["60%", "100%", "140%"]);
    expect(embed(result).fields[1].value).toContain("2 / 3");
    expect(embed(result).fields[2].value).toContain("1 / 3");
    expect(embed(result).footer?.text).toBe("You have 2 minutes to vote on series length.");
    expect(result.components).toHaveLength(1);
  });

  it("phase 2: replaces the tally with the resolved length and shows the formation vote", async () => {
    const result = await render({ series: { ...BASE, series_length: "bo5" }, formationVotes: ["captains", "balanced"] });
    expect(fieldNames(result)).toEqual(["Series Length", "Balanced Teams", "Captains"]);
    expect(embed(result).fields[0].value).toBe("**Best of 5** · 100% MMR");
    expect(embed(result).fields[1].value).toBe("1 / 3");
    expect(embed(result).fields[2].value).toBe("1 / 3");
    expect(embed(result).footer?.text).toBe("You have 2 minutes to vote on team formation.");
    expect(result.components).toHaveLength(1);
  });

  it("omits the Series Length field entirely when the length vote is disabled", async () => {
    const result = await render({ series: BASE });
    expect(fieldNames(result)).toEqual(["Balanced Teams", "Captains"]);
  });

  it("phase 3: shows the two captains in place of the vote, with no buttons left", async () => {
    const lobby: Lobby[] = MEMBERS.map((m, i) => ({ player_id: m.id, team: i === 0 ? "A" : i === 2 ? "B" : null, is_captain: i === 0 || i === 2 }));
    const result = await render({ series: { ...BASE, series_length: "bo7", vote_result: "captains" }, lobby }, "<@d-ace> you're picking - check your DMs!");
    expect(fieldNames(result)).toEqual(["Series Length", "Captain A", "Captain B", "Status"]);
    expect(embed(result).fields[1].value).toBe("<@d-ace>");
    expect(embed(result).fields[2].value).toBe("<@d-cinder>");
    expect(embed(result).fields[3].value).toContain("check your DMs");
    expect(result.components).toEqual([]);
    expect(embed(result).footer).toBeUndefined();
  });

  it("phase 3: drops the Status row when no draft status is passed", async () => {
    const lobby: Lobby[] = MEMBERS.map((m, i) => ({ player_id: m.id, team: i === 0 ? "A" : i === 2 ? "B" : null, is_captain: i === 0 || i === 2 }));
    const result = await render({ series: { ...BASE, vote_result: "captains" }, lobby });
    expect(fieldNames(result)).toEqual(["Captain A", "Captain B"]);
  });

  // Only reachable if beginCaptainsDraft dies between claiming vote_result and writing the
  // captain rows — the message still has to render something rather than throw.
  it("phase 3: falls back to a plain Captains label when no captain rows exist yet", async () => {
    const result = await render({ series: { ...BASE, vote_result: "captains" } });
    expect(fieldNames(result)).toEqual(["Team Formation"]);
    expect(embed(result).fields[0].value).toBe("**Captains**");
  });

  it("phase 3b: labels a balanced resolution", async () => {
    const result = await render({ series: { ...BASE, series_length: "bo3", vote_result: "balanced" } });
    expect(fieldNames(result)).toEqual(["Series Length", "Team Formation"]);
    expect(embed(result).fields[0].value).toBe("**Best of 3** · 60% MMR");
    expect(embed(result).fields[1].value).toBe("**Balanced**");
    expect(result.components).toEqual([]);
  });

  it("switches to the supercharged color on a bonus-day series", async () => {
    const plain = await render({ series: BASE });
    const bonus = await render({ series: { ...BASE, bonus_day_multiplier: 1.5 } });
    expect(bonus.embeds[0]).not.toEqual(plain.embeds[0]);
    expect(embed(bonus).color).not.toBe(embed(plain).color);
  });
});
