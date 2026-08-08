import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getConfigNumber } from "./config";
import type { SeasonRow } from "@/lib/supabase/types";

type CloseSummary = { participants: number; top10: number; playersDecayed: number };

type SupabaseAdmin = ReturnType<typeof createAdminClient>;

// PostgREST caps unbounded selects at a project-configured max (commonly 1000) — a season with
// enough games/participants to exceed that would silently truncate results with no error,
// corrupting season_rank/made_top10. Every select below that can grow with community size is
// paged in PAGE_SIZE chunks rather than trusting a single unbounded fetch.
const PAGE_SIZE = 1000;
// Keeps `.in(...)` id-list URLs bounded regardless of how many rows the id list itself has.
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

// ---------------------------------------------------------------------------
// Season close — see CLAUDE.md, "Seasons". Called from seasons.ts's /newseason handler once
// the previous season has already been atomically claimed (is_active flipped false under a
// WHERE-is_active=true guard, so a double-fire can't run this twice — see processNewSeason).
//
// Order matters: season standings/history are computed and written from PRE-decay MMR (the
// actual end-of-season values players earned), and only afterward does the median-compression
// soft reset run. Test-data players (dev panel) are excluded throughout, same treatment as
// every other bot-side Discord/ranking operation (see bands.ts).
//
// Prism is no longer granted/stripped here — it's a live top-N overlay recomputed continuously
// by bands.ts's recomputeBands() (daily cron, every Rank Queue report, admin actions), not a
// season-close-only event. The `made_top10`/season_history write below is purely an archival
// record of that season's standings, decoupled from the actual `is_prism` role state.
// ---------------------------------------------------------------------------

export async function closeSeason(closedSeason: Pick<SeasonRow, "id">): Promise<CloseSummary> {
  const supabase = createAdminClient();

  const [decayFactor, top10MinGames, prismTopN] = await Promise.all([
    getConfigNumber("decay_factor", 0.25),
    getConfigNumber("top10_min_games", 8),
    getConfigNumber("prism_top_n", 1),
  ]);

  // ---- Season standings: season_rank for every participant (>=1 reported game that season,
  // either queue — see CLAUDE.md, "Queueing"), made_top10 for the top `prism_top_n` among those
  // with >= top10_min_games — archival only now, see the note above. The `made_top10` column
  // name predates prism_top_n becoming configurable — kept as-is (a stable identifier, not a
  // literal claim of "10"). ----

  const seriesIds = (
    await fetchAllPages((from, to) =>
      supabase
        .from("crl6mansqueuebot_series")
        .select("id")
        .eq("season_id", closedSeason.id)
        .eq("status", "reported")
        .eq("is_test_data", false)
        .range(from, to)
        .then(({ data }) => data ?? []),
    )
  ).map((s) => s.id);

  const gamesPlayedByPlayerId = new Map<string, number>();
  for (const idChunk of chunk(seriesIds, ID_CHUNK)) {
    const seriesPlayers = await fetchAllPages((from, to) =>
      supabase
        .from("crl6mansqueuebot_series_players")
        .select("player_id")
        .in("series_id", idChunk)
        .range(from, to)
        .then(({ data }) => data ?? []),
    );
    for (const sp of seriesPlayers) {
      gamesPlayedByPlayerId.set(sp.player_id, (gamesPlayedByPlayerId.get(sp.player_id) ?? 0) + 1);
    }
  }

  const participantIds = [...gamesPlayedByPlayerId.keys()];
  if (participantIds.length === 0) {
    return { participants: 0, top10: 0, playersDecayed: await applyMmrDecay(supabase, decayFactor) };
  }

  const players = (
    await Promise.all(
      chunk(participantIds, ID_CHUNK).map((idChunk) =>
        fetchAllPages((from, to) =>
          supabase
            .from("crl6mansqueuebot_players")
            .select("*")
            .in("id", idChunk)
            .eq("is_test_data", false)
            .range(from, to)
            .then(({ data }) => data ?? []),
        ),
      ),
    )
  ).flat();

  // Same tiebreak philosophy as the daily band recompute (bands.ts): higher MMR ranks first,
  // ties broken by more season games played (more established), then player id as a final
  // deterministic tiebreak — this is also the "most games played" tiebreak CLAUDE.md specifies
  // for the Prism top-cut (`prism_top_n`).
  const ranked = players
    .map((p) => ({ player: p, seasonGames: gamesPlayedByPlayerId.get(p.id) ?? 0 }))
    .sort((a, b) => b.player.mmr - a.player.mmr || b.seasonGames - a.seasonGames || a.player.id.localeCompare(b.player.id));

  const eligibleForTop10 = ranked.filter((r) => r.seasonGames >= top10MinGames);
  const top10Ids = new Set(eligibleForTop10.slice(0, prismTopN).map((r) => r.player.id));

  const historyRows = ranked.map((r, index) => ({
    season_id: closedSeason.id,
    player_id: r.player.id,
    mmr_at_close: r.player.mmr,
    season_games_played: r.seasonGames,
    season_rank: index + 1,
    made_top10: top10Ids.has(r.player.id),
  }));
  for (const rowsChunk of chunk(historyRows, ID_CHUNK)) {
    await supabase.from("crl6mansqueuebot_season_history").upsert(rowsChunk);
  }

  // Prism role sync used to happen here (strip/grant against last season's `is_prism` holders).
  // That's now handled live by bands.ts's recomputeBands() — /newseason calls it explicitly
  // right after opening the new season (see seasons.ts), which re-evaluates the top-N cut
  // against the fresh (all-zero) season-games counts and clears out anyone who no longer
  // qualifies, rather than waiting for their next report.

  const playersDecayed = await applyMmrDecay(supabase, decayFactor);

  return { participants: ranked.length, top10: top10Ids.size, playersDecayed };
}

// ---------------------------------------------------------------------------
// Soft reset — every currently placed, non-test player (not just this season's participants,
// see CLAUDE.md, "Seasons"), applied after standings are already written.
//
// Two-piece formula, continuous at mmr = 0 (both pieces equal 0 there, so no jump):
//   mmr >= 0: new = (mmr * median) / (median + decay_factor * mmr)
//     A hyperbolic (Michaelis-Menten style) decay toward 0, scaled by the pool median. Always
//     strictly decreasing for mmr > 0 and asymptotically safe — it can never cross below 0 for
//     a non-negative input, unlike a plain linear `old - (old - median) * decay_factor`, which
//     would push below-median players' MMR *up*. Every positive-MMR player loses something,
//     with players near the median losing proportionally more than players already near 0.
//   mmr < 0: new = mmr / 3
//     Negative MMR (no floor during normal play — see CLAUDE.md, "MMR / Elo") recovers toward
//     0 at a fixed 3x-closer rate each season, independent of the median.
// Both pieces are strictly increasing in `mmr` and agree at the boundary, so the combined
// function is strictly increasing across the whole domain — it never reorders players by MMR,
// so no band recompute is needed here; the next daily cron tick handles band drift exactly as
// it would on any other day (see bands.ts).
// ---------------------------------------------------------------------------

function decayMmr(mmr: number, median: number, decayFactor: number): number {
  if (mmr < 0) return mmr / 3;
  if (mmr === 0) return 0;
  return (mmr * median) / (median + decayFactor * mmr);
}

async function applyMmrDecay(supabase: SupabaseAdmin, decayFactor: number): Promise<number> {
  const pool = await fetchAllPages((from, to) =>
    supabase
      .from("crl6mansqueuebot_players")
      .select("id, mmr")
      .eq("is_placed", true)
      .eq("is_test_data", false)
      .range(from, to)
      .then(({ data }) => data ?? []),
  );
  if (pool.length === 0) return 0;

  const sortedMmr = pool.map((p) => p.mmr).sort((a, b) => a - b);
  const mid = Math.floor(sortedMmr.length / 2);
  const median = sortedMmr.length % 2 === 0 ? (sortedMmr[mid - 1] + sortedMmr[mid]) / 2 : sortedMmr[mid];

  await Promise.all(
    pool.map((p) => supabase.from("crl6mansqueuebot_players").update({ mmr: decayMmr(p.mmr, median, decayFactor) }).eq("id", p.id)),
  );
  return pool.length;
}
