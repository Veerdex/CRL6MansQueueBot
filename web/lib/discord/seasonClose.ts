import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getConfigNumber } from "./config";
import { resetAllPlacementsToUnranked } from "./bands";
import type { SeasonRow } from "@/lib/supabase/types";
import { seasonScoresByPlayerId } from "../mmr/allTimeRating";

type CloseSummary = { participants: number; top10: number; playersDecayed: number; playersReset: number };

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

// `page` MUST apply a total `.order(...)` on a unique key (a primary key, or a column set that is
// unique across the rows being read). PostgREST's `.range()` is a plain LIMIT/OFFSET over whatever
// order the planner happens to pick, and Postgres guarantees no stability across two separate
// statements — so an unordered paged read can hand back one row twice and drop another entirely
// once the result set outgrows PAGE_SIZE. That is not cosmetic here: a dropped player silently
// loses their season_history row, and with it their standings placing, band_at_close and all-time
// season_score, with nothing left to reconstruct it from once the decay below has run.
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
// season-close-only event. The `made_top10`/season_history write below is the archival snapshot
// of who was holding that live rank when the season ended — copied from `is_prism` rather than
// re-derived, so the archive can never disagree with the standing players actually saw.
//
// After decay, placement is reset across the whole non-test roster (bands.ts's
// resetAllPlacementsToUnranked — see CLAUDE.md, "Seasons") so a new season starts with everyone
// re-earning their band from scratch: placed players go back to Unranked, and unplaced players
// give up the partial placement run they had accumulated in the season just closed rather than
// carrying it forward into a compressed ladder. Only the Discord role swap and the reported
// count stay scoped to who was actually placed. The ordering is no longer load-bearing for the
// decay pool (which no longer filters on is_placed either), but it is still what lets the
// standings/is_prism snapshots above read pre-reset values, so it stays as-is.
// ---------------------------------------------------------------------------

export async function closeSeason(closedSeason: Pick<SeasonRow, "id">): Promise<CloseSummary> {
  const supabase = createAdminClient();

  const decayFactor = await getConfigNumber("decay_factor", 0.25);

  // ---- Season standings: season_rank for every participant (>=1 reported game that season,
  // either queue — see CLAUDE.md, "Queueing"), and made_top10 for whoever ended the season
  // holding Prism — see the note above. The `made_top10` column name predates prism_top_n
  // becoming configurable — kept as-is (a stable identifier, not a literal claim of "10"). ----

  const seriesIds = (
    await fetchAllPages((from, to) =>
      supabase
        .from("crl6mansqueuebot_series")
        .select("id")
        .eq("season_id", closedSeason.id)
        .eq("status", "reported")
        .eq("is_test_data", false)
        .order("id")
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
        // (series_id, player_id) is this table's primary key — see 0001_init.sql.
        .order("series_id")
        .order("player_id")
        .range(from, to)
        .then(({ data }) => data ?? []),
    );
    for (const sp of seriesPlayers) {
      gamesPlayedByPlayerId.set(sp.player_id, (gamesPlayedByPlayerId.get(sp.player_id) ?? 0) + 1);
    }
  }

  const participantIds = [...gamesPlayedByPlayerId.keys()];
  if (participantIds.length === 0) {
    const playersDecayed = await applyMmrDecay(supabase, decayFactor);
    const playersReset = await resetAllPlacementsToUnranked();
    return { participants: 0, top10: 0, playersDecayed, playersReset };
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
            .order("id")
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

  // Who finished the season as Prism, read straight off the live `is_prism` column instead of
  // being recomputed from a second copy of the top-N rule. bands.ts owns that rule (placed +
  // Sapphire + >= top10_min_games, then the top `prism_top_n` by MMR) and refreshes the column on
  // every Rank Queue report and on the daily cron, so this captures exactly the standing the
  // community saw at close; the soft reset further down then clears `is_prism`, which is why the
  // flag has to be snapshotted here. Both consumers of made_top10 — the leaderboard's Prism alumni
  // avatar glow and the archived Top Players board — therefore always agree with what was actually
  // displayed. Re-deriving it here would drift from that whenever the two rules disagreed: this
  // pass had no Sapphire/placed qualification, so it backfilled unfilled Prism slots from lower
  // bands and could archive players who never held the rank.
  const top10Ids = new Set(ranked.filter((r) => r.player.is_prism).map((r) => r.player.id));

  // All-time rating points for this season's finish (web/lib/mmr/allTimeRating.ts). Scored over
  // the *placed* pool only and densely re-ranked inside it, which is why it can't just reuse
  // `season_rank` below: that rank covers every participant with a reported game, unplaced ones
  // included, so reusing it would both inflate N and leave gaps in r wherever an unplaced player
  // finished mid-table. Read here, before the soft reset clears is_placed, for the same reason the
  // is_prism snapshot above has to be. Unplaced participants still get a row, scoring 0.
  const seasonScores = seasonScoresByPlayerId(
    ranked.map((r) => ({ id: r.player.id, isPlaced: r.player.is_placed })),
  );

  const historyRows = ranked.map((r, index) => ({
    season_id: closedSeason.id,
    player_id: r.player.id,
    mmr_at_close: r.player.mmr,
    season_games_played: r.seasonGames,
    season_rank: index + 1,
    made_top10: top10Ids.has(r.player.id),
    // Read here for the same reason as is_prism and is_placed above: resetAllPlacementsToUnranked()
    // further down clears band for the whole roster, so a past-season board has no other source for
    // it. The underlying band only — Prism rides along in made_top10.
    band_at_close: r.player.is_placed ? r.player.band : null,
    season_score: seasonScores.get(r.player.id) ?? 0,
  }));
  // Throw rather than continue: everything below this point is destructive and irreversible
  // (applyMmrDecay, then resetAllPlacementsToUnranked), and these rows are the only record of the
  // standings it destroys. supabase-js resolves on a failed write instead of throwing, so without
  // this check a rejected upsert is completely silent — and PostgREST *rejects* a write naming a
  // column the table doesn't have (PGRST204) rather than dropping the field, which makes "the
  // migration adding season_score/band_at_close hasn't been applied to this database yet" a real,
  // reachable path to losing a whole season's standings. Aborting leaves the season row already
  // flipped is_active=false by the caller's atomic claim, but with MMR and placements untouched,
  // so the standings are still fully derivable from live data once the migration is applied.
  for (const rowsChunk of chunk(historyRows, ID_CHUNK)) {
    const { error } = await supabase.from("crl6mansqueuebot_season_history").upsert(rowsChunk);
    if (error) throw new Error(`Failed to archive season standings: ${error.message}`);
  }

  // Prism role sync used to happen here (strip/grant against last season's `is_prism` holders).
  // That's now handled live by bands.ts's recomputeBands() for the ordinary case (re-evaluated on
  // every report/daily cron). At season-reset time specifically, though, resetAllPlacementsToUnranked
  // (called below, via applyMmrDecay's sibling call) clears `is_prism` and the Prism role itself —
  // fixed this session, since a later recomputeBands() call can't reconsider a player it just reset
  // out of its own pool (is_placed/rank_games_played both get zeroed), so it could never actually
  // "clear out anyone who no longer qualifies" the way this comment used to (incorrectly) claim.

  const playersDecayed = await applyMmrDecay(supabase, decayFactor);
  const playersReset = await resetAllPlacementsToUnranked();

  return { participants: ranked.length, top10: top10Ids.size, playersDecayed, playersReset };
}

// ---------------------------------------------------------------------------
// Soft reset — every non-test player, placed or not (and not just this season's participants —
// see CLAUDE.md, "Seasons"), applied after standings are already written.
//
// The pool used to filter on is_placed = true, which left unplaced players carrying an
// un-decayed rating into a season where everyone else had been compressed. Because the two
// groups interleave across the whole ladder, that let an unplaced player start the new season
// *above* a placed player they had finished below — the decay formula's "never reorders players"
// guarantee only ever held within the pool, never across its boundary. Decaying everyone closes
// that gap and costs nothing for the never-played case: decayMmr(0, ...) is exactly 0.
//
// Widening the pool also widens what computeSafeMedian sees, so the compression constant now
// reflects the whole community rather than the placed subset.
//
// decayMmr/computeSafeMedian live in ../mmr/seasonDecay.ts (a plain, dependency-free module)
// rather than here, so web/scripts/backfill-mmr-before.ts — a tsx script that can't rely on
// Next.js's "react-server" resolution condition to no-op the "server-only" guard this file
// carries — can import them directly. Re-exported below so every existing import site/test that
// pulls them from "./seasonClose" keeps working unchanged.
// ---------------------------------------------------------------------------

export { decayMmr, computeSafeMedian } from "../mmr/seasonDecay";
import { decayMmr, computeSafeMedian } from "../mmr/seasonDecay";

async function applyMmrDecay(supabase: SupabaseAdmin, decayFactor: number): Promise<number> {
  const pool = await fetchAllPages((from, to) =>
    supabase
      .from("crl6mansqueuebot_players")
      .select("id, mmr")
      .eq("is_test_data", false)
      .order("id")
      .range(from, to)
      .then(({ data }) => data ?? []),
  );
  if (pool.length === 0) return 0;

  const median = computeSafeMedian(pool.map((p) => p.mmr));

  await Promise.all(
    pool.map((p) => supabase.from("crl6mansqueuebot_players").update({ mmr: decayMmr(p.mmr, median, decayFactor) }).eq("id", p.id)),
  );
  return pool.length;
}
