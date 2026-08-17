// Full-population replay that computes each player's TRUE lifetime peak_mmr from current data
// (current series mmr_delta values, current admin adjustments, current season_history) — shared
// by scripts/backfill-peak-mmr.ts (offline, only-ever-raises backfill) and the live
// /admin correct-report + /correct paths (adminTools.ts / correct.ts), which need to be able to
// LOWER a stored peak that turns out to have been set by a since-corrected misreport (see
// CLAUDE.md-adjacent discussion: peak_mmr is a lifetime high-water mark that nothing else ever
// lowers, including season decay — a correction is the one place that invariant can be provably
// wrong for a specific player).
//
// The full player population is required even when a caller only cares about a handful of
// players: reconstructMmrHistory's season-close decay step computes its median over every
// currently-placed, non-test player (see seasonClose.ts's applyMmrDecay), not just the ones a
// caller is asking about — scoping the query to fewer players would silently corrupt that median
// for anyone who has been through a season close.
//
// No "server-only" guard — this is a pure DB-read module that accepts an already-constructed
// Supabase client, the same shape scripts/backfill-peak-mmr.ts and web/lib/discord/*.ts routes
// both already use, so both a tsx script and a Discord route handler can call it directly.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import {
  reconstructMmrHistory,
  type SeriesBatchInput,
  type AdminAdjustInput,
  type SeasonInput,
  type SeasonHistoryCheckpoint,
  type DriftWarning,
} from "./reconstructMmrHistory";

const PAGE_SIZE = 1000;
const ID_CHUNK = 200;

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function fetchAllPages<T>(page: (from: number, to: number) => PromiseLike<T[]>): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const batch = await page(from, from + PAGE_SIZE - 1);
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
    from += PAGE_SIZE;
  }
}

// Parses logAdminAction's "MMR: <before> -> <after>" details format (adminTools.ts's ChangeEntry
// join) for adjust_mmr audit-log rows. Returns null for anything that doesn't match — a
// defensively-ignored row rather than a thrown error, since the audit log is free-text.
function parseAdjustMmrDetails(details: string | null): number | null {
  if (!details) return null;
  const match = details.match(/MMR:\s*(-?[\d.]+)\s*->\s*(-?[\d.]+)/);
  if (!match) return null;
  const after = Number(match[2]);
  return Number.isFinite(after) ? after : null;
}

async function getConfigNumber(supabase: SupabaseClient<Database>, key: string, fallback: number): Promise<number> {
  const { data } = await supabase.from("crl6mansqueuebot_config").select("value").eq("key", key).maybeSingle();
  if (!data) return fallback;
  const parsed = Number(data.value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface PeakMmrRecomputeResult {
  peakMmrByPlayer: Map<string, number>;
  driftWarnings: DriftWarning[];
}

export async function recomputeTruePeakMmr(supabase: SupabaseClient<Database>): Promise<PeakMmrRecomputeResult> {
  const [decayFactor, placementGamesRequired] = await Promise.all([
    getConfigNumber(supabase, "decay_factor", 0.25),
    getConfigNumber(supabase, "placement_games_required", 10),
  ]);

  const players = await fetchAllPages((from, to) =>
    supabase
      .from("crl6mansqueuebot_players")
      .select("id, discord_id, is_test_data")
      .order("id")
      .range(from, to)
      .then((r) => {
        if (r.error) throw r.error;
        return r.data ?? [];
      }),
  );
  const realPlayers = players.filter((p) => !p.is_test_data);
  const realPlayerIds = new Set(realPlayers.map((p) => p.id));
  const discordIdToPlayerId = new Map(realPlayers.map((p) => [p.discord_id, p.id]));

  const seasons = await fetchAllPages((from, to) =>
    supabase
      .from("crl6mansqueuebot_seasons")
      .select("id, season_number, is_active")
      .order("season_number")
      .range(from, to)
      .then((r) => {
        if (r.error) throw r.error;
        return r.data ?? [];
      }),
  );
  const seasonInputs: SeasonInput[] = seasons.filter((s) => !s.is_active).map((s) => ({ seasonId: s.id, seasonNumber: s.season_number }));

  const series = await fetchAllPages((from, to) =>
    supabase
      .from("crl6mansqueuebot_series")
      .select("id, season_id, queue_type, reported_at, created_at, is_test_data")
      .eq("status", "reported")
      .eq("is_test_data", false)
      .order("id")
      .range(from, to)
      .then((r) => {
        if (r.error) throw r.error;
        return r.data ?? [];
      }),
  );

  const seriesPlayers: { series_id: string; player_id: string; mmr_delta: number }[] = [];
  for (const idChunk of chunk(series.map((s) => s.id), ID_CHUNK)) {
    const rows = await fetchAllPages((from, to) =>
      supabase
        .from("crl6mansqueuebot_series_players")
        .select("series_id, player_id, mmr_delta")
        .in("series_id", idChunk)
        .range(from, to)
        .then((r) => {
          if (r.error) throw r.error;
          return r.data ?? [];
        }),
    );
    seriesPlayers.push(...rows);
  }

  const seriesPlayersBySeries = new Map<string, typeof seriesPlayers>();
  for (const row of seriesPlayers) {
    if (!realPlayerIds.has(row.player_id)) continue;
    const list = seriesPlayersBySeries.get(row.series_id);
    if (list) list.push(row);
    else seriesPlayersBySeries.set(row.series_id, [row]);
  }

  const seriesBatches: SeriesBatchInput[] = [];
  for (const s of series) {
    const roster = seriesPlayersBySeries.get(s.id);
    if (!roster || roster.length === 0) continue;
    seriesBatches.push({
      seriesId: s.id,
      seasonId: s.season_id,
      reportedAt: s.reported_at ?? s.created_at,
      isRank: s.queue_type === "rank",
      players: roster.map((r) => ({ playerId: r.player_id, mmrDelta: r.mmr_delta })),
    });
  }

  const auditRows = await fetchAllPages((from, to) =>
    supabase
      .from("crl6mansqueuebot_audit_log")
      .select("actor_discord_id, action, target, details, created_at")
      .eq("action", "adjust_mmr")
      .order("created_at")
      .range(from, to)
      .then((r) => {
        if (r.error) throw r.error;
        return r.data ?? [];
      }),
  );

  const adminAdjustments: AdminAdjustInput[] = [];
  for (const row of auditRows) {
    const playerId = row.target ? discordIdToPlayerId.get(row.target) : undefined;
    const newMmr = parseAdjustMmrDetails(row.details);
    if (!playerId || newMmr === null) continue;
    adminAdjustments.push({ playerId, at: row.created_at, newMmr });
  }

  const seasonHistoryRows = await fetchAllPages((from, to) =>
    supabase
      .from("crl6mansqueuebot_season_history")
      .select("season_id, player_id, mmr_at_close")
      .range(from, to)
      .then((r) => {
        if (r.error) throw r.error;
        return r.data ?? [];
      }),
  );
  const seasonHistoryCheckpoints: SeasonHistoryCheckpoint[] = seasonHistoryRows
    .filter((r) => realPlayerIds.has(r.player_id))
    .map((r) => ({ seasonId: r.season_id, playerId: r.player_id, mmrAtClose: r.mmr_at_close }));

  const result = reconstructMmrHistory({
    playerIds: Array.from(realPlayerIds),
    seriesBatches,
    adminAdjustments,
    seasons: seasonInputs,
    seasonHistoryCheckpoints,
    decayFactor,
    placementGamesRequired,
  });

  return { peakMmrByPlayer: result.peakMmrByPlayer, driftWarnings: result.driftWarnings };
}
