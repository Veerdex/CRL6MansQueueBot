// Corrective backfill for players.peak_mmr. Migration 0031_peak_mmr.sql's original backfill
// (`peak_mmr = greatest(mmr, 0)`) only captured each player's CURRENT mmr at the moment that
// migration happened to run — not their true historical high — so anyone whose mmr had already
// come back down (a losing streak, season decay, an admin correction) by that point got a
// peak_mmr floored at whatever low/negative value they were sitting at right then, permanently
// understating their real peak. This script reconstructs the true peak by replaying full MMR
// history the same way web/scripts/backfill-mmr-before.ts does, via the shared
// web/lib/mmr/reconstructMmrHistory.ts module (unit-tested separately) — see that module's
// header comment for exactly what is and isn't modeled.
//
// Usage (from web/):
//   npm run backfill-peak-mmr            -- dry run: prints a summary, writes nothing
//   npm run backfill-peak-mmr -- --write -- actually writes the computed peak_mmr values
//
// Only ever RAISES peak_mmr (`Math.max(existing, reconstructed, 0)`) for currently-placed,
// non-test players — never lowers it, and never touches an unplaced player's peak_mmr (which is
// correctly 0 while unranked — see CLAUDE.md's "Peak MMR" section).
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
    supabase.from("crl6mansqueuebot_players").select("id, discord_id, mmr, peak_mmr, is_placed, is_test_data").order("id").range(from, to).then((r) => {
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

  const rowsToWrite: { id: string; discord_id: string; current: number; reconstructed: number; next: number }[] = [];
  for (const p of realPlayers) {
    if (!p.is_placed) continue; // peak isn't tracked while unranked — leave at whatever it is (should be 0)
    const reconstructed = result.peakMmrByPlayer.get(p.id) ?? 0;
    const next = Math.max(p.peak_mmr, reconstructed, p.mmr, 0);
    if (next > p.peak_mmr) {
      rowsToWrite.push({ id: p.id, discord_id: p.discord_id, current: p.peak_mmr, reconstructed, next });
    }
  }

  console.log(`\n${rowsToWrite.length} placed player(s) have a stored peak_mmr below their reconstructed/current true peak:`);
  for (const row of rowsToWrite.slice(0, 20)) {
    console.log(`  player=${row.id} discord_id=${row.discord_id} stored=${row.current.toFixed(2)} -> ${row.next.toFixed(2)}`);
  }
  if (rowsToWrite.length > 20) console.log(`  ...and ${rowsToWrite.length - 20} more.`);

  if (!write) {
    console.log("\nDry run only — no writes performed. Re-run with --write to persist these values.");
    return;
  }

  console.log("\nWriting...");
  let written = 0;
  for (const row of rowsToWrite) {
    const { error } = await supabase.from("crl6mansqueuebot_players").update({ peak_mmr: row.next }).eq("id", row.id);
    if (error) {
      console.error(`Failed to write player_id=${row.id}:`, error.message);
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
