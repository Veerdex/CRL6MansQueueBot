// Best-effort backfill of series_players.mmr_before for series reported BEFORE migration
// 0032_series_players_mmr_before.sql existed (that migration explicitly left the column
// unbackfilled, since no historical pre-match MMR was persisted anywhere before it — see its own
// header comment and CLAUDE.md's "Match History" section). This script reconstructs those values
// by replaying every reported series + admin MMR adjustment + season-close decay in chronological
// order, via the pure web/lib/mmr/reconstructMmrHistory.ts module (unit-tested separately).
//
// This is a BEST-EFFORT reconstruction, not a provably exact one — see reconstructMmrHistory.ts's
// header comment for exactly what is and isn't modeled (in short: /admin unreport self-cancels by
// being excluded from the status='reported' query below; /admin correct-report's effect is
// already baked into the current mmr_delta this script reads, just anchored to the original
// report time rather than the later correction time; season-close timing uses each series'
// season_id rather than the date-only seasons.end_date, which would be too imprecise to order
// against same-day reports).
//
// Usage (from web/):
//   npm run backfill-mmr-before            -- dry run: prints a summary, writes nothing
//   npm run backfill-mmr-before -- --write -- actually writes the computed mmr_before values
//
// Only ever fills series_players rows where mmr_before is currently NULL — never overwrites a
// real snapshot already written by report.ts post-migration-0032.
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../lib/supabase/types";
import { reconstructMmrHistory, type SeriesBatchInput, type AdminAdjustInput, type SeasonInput, type SeasonHistoryCheckpoint } from "../lib/mmr/reconstructMmrHistory";

const PAGE_SIZE = 1000;
const ID_CHUNK = 200;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function fetchAllPages<T>(page: (from: number, to: number) => PromiseLike<T[]>): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const batch = await page(from, from + PAGE_SIZE - 1);
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
    from += PAGE_SIZE;
  }
}

function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient<Database>(url, serviceRoleKey, { auth: { persistSession: false } });
}

async function getConfigNumber(supabase: ReturnType<typeof createAdminClient>, key: string, fallback: number): Promise<number> {
  const { data } = await supabase.from("crl6mansqueuebot_config").select("value").eq("key", key).maybeSingle();
  if (!data) return fallback;
  const parsed = Number(data.value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Parses logAdminAction's "MMR: <before> -> <after>" details format (admin.ts's ChangeEntry
// join) for adjust_mmr audit-log rows. Returns null for anything that doesn't match — a
// defensively-ignored row rather than a thrown error, since the audit log is free-text and this
// is a best-effort reconstruction.
function parseAdjustMmrDetails(details: string | null): number | null {
  if (!details) return null;
  const match = details.match(/MMR:\s*(-?[\d.]+)\s*->\s*(-?[\d.]+)/);
  if (!match) return null;
  const after = Number(match[2]);
  return Number.isFinite(after) ? after : null;
}

async function main() {
  const write = process.argv.includes("--write");
  const supabase = createAdminClient();

  const [decayFactor, placementGamesRequired] = await Promise.all([
    getConfigNumber(supabase, "decay_factor", 0.25),
    getConfigNumber(supabase, "placement_games_required", 10),
  ]);

  const players = await fetchAllPages((from, to) =>
    supabase.from("crl6mansqueuebot_players").select("id, discord_id, mmr, is_test_data").order("id").range(from, to).then((r) => {
      if (r.error) throw r.error;
      return r.data ?? [];
    }),
  );
  const realPlayers = players.filter((p) => !p.is_test_data);
  const realPlayerIds = new Set(realPlayers.map((p) => p.id));
  const discordIdToPlayerId = new Map(realPlayers.map((p) => [p.discord_id, p.id]));

  const seasons = await fetchAllPages((from, to) =>
    supabase.from("crl6mansqueuebot_seasons").select("id, season_number, is_active").order("season_number").range(from, to).then((r) => {
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

  const seriesPlayers: { series_id: string; player_id: string; mmr_delta: number; mmr_before: number | null }[] = [];
  for (const idChunk of chunk(series.map((s) => s.id), ID_CHUNK)) {
    const rows = await fetchAllPages((from, to) =>
      supabase
        .from("crl6mansqueuebot_series_players")
        .select("series_id, player_id, mmr_delta, mmr_before")
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
  let unparseableAdjustments = 0;
  for (const row of auditRows) {
    const playerId = row.target ? discordIdToPlayerId.get(row.target) : undefined;
    const newMmr = parseAdjustMmrDetails(row.details);
    if (!playerId || newMmr === null) {
      unparseableAdjustments++;
      continue;
    }
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

  console.log(`Loaded ${realPlayers.length} real players, ${seriesBatches.length} reported series, ${adminAdjustments.length} admin adjustments (${unparseableAdjustments} unparseable/skipped), ${seasonInputs.length} closed seasons, ${seasonHistoryCheckpoints.length} season_history checkpoints.`);
  console.log(`Config: decay_factor=${decayFactor}, placement_games_required=${placementGamesRequired}`);

  const result = reconstructMmrHistory({
    playerIds: Array.from(realPlayerIds),
    seriesBatches,
    adminAdjustments,
    seasons: seasonInputs,
    seasonHistoryCheckpoints,
    decayFactor,
    placementGamesRequired,
  });

  if (result.driftWarnings.length > 0) {
    console.log(`\n${result.driftWarnings.length} drift warning(s) (simulation snapped to season_history's recorded ground truth):`);
    for (const w of result.driftWarnings) {
      console.log(`  season=${w.seasonId} player=${w.playerId} simulated=${w.simulatedPreDecayMmr.toFixed(2)} recorded=${w.recordedMmrAtClose.toFixed(2)} drift=${w.drift.toFixed(2)}`);
    }
  }

  let finalMismatches = 0;
  for (const p of realPlayers) {
    const simulated = result.finalMmrByPlayer.get(p.id);
    if (simulated === undefined) continue;
    if (Math.abs(simulated - p.mmr) > 0.5) {
      finalMismatches++;
      console.log(`  final-mmr mismatch: player=${p.id} discord_id=${p.discord_id} simulated=${simulated.toFixed(2)} current=${p.mmr.toFixed(2)}`);
    }
  }
  console.log(`\n${finalMismatches} player(s) diverge from their current live MMR by more than 0.5 (expected for anyone affected by an unmodeled event, e.g. /admin correct-report or /admin unreport near a boundary).`);

  const rowsToWrite: { series_id: string; player_id: string; mmr_before: number }[] = [];
  for (const s of series) {
    const roster = seriesPlayersBySeries.get(s.id);
    if (!roster) continue;
    const snapshot = result.mmrBeforeBySeries.get(s.id);
    if (!snapshot) continue;
    for (const row of roster) {
      if (row.mmr_before !== null) continue; // never overwrite a real post-migration snapshot
      const mmrBefore = snapshot.get(row.player_id);
      if (mmrBefore === undefined) continue;
      rowsToWrite.push({ series_id: row.series_id, player_id: row.player_id, mmr_before: mmrBefore });
    }
  }

  console.log(`\n${rowsToWrite.length} series_players row(s) have mmr_before=NULL and would be backfilled.`);

  if (!write) {
    console.log("\nDry run only — no writes performed. Re-run with --write to persist these values.");
    console.log("Sample of computed rows:", rowsToWrite.slice(0, 5));
    return;
  }

  console.log("\nWriting...");
  let written = 0;
  for (const row of rowsToWrite) {
    const { error } = await supabase
      .from("crl6mansqueuebot_series_players")
      .update({ mmr_before: row.mmr_before })
      .eq("series_id", row.series_id)
      .eq("player_id", row.player_id)
      .is("mmr_before", null);
    if (error) {
      console.error(`Failed to write series_id=${row.series_id} player_id=${row.player_id}:`, error.message);
      continue;
    }
    written++;
  }
  console.log(`Done. Wrote ${written}/${rowsToWrite.length} rows.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
