// One-shot corrective rescore of crl6mansqueuebot_season_history.season_score for seasons that
// were closed under the ORIGINAL all-time rating curve, which evaluated itself over the placed
// pool directly (N = placed count) and therefore paid only the top half of the standing. The curve
// in web/lib/mmr/allTimeRating.ts now evaluates over a doubled field (N = 2 * placed count), which
// puts real last place exactly on the old halfway point: every placed player earns, from 100 for
// first down to exactly 1 for last. Season 1 closed before that change and still has the old,
// half-paying numbers stored, so its rows have to be recomputed to stay comparable with every
// season closed from here on (a career all-time rating is just the sum of these rows).
//
// Usage (from web/):
//   npm run backfill-season-score            -- dry run: prints every changed row, writes nothing
//   npm run backfill-season-score -- --write -- actually writes the recomputed season_score values
//
// How the placed pool is recovered: seasonClose.ts writes band_at_close non-null if and only if
// the player was placed at close, so `band_at_close != null`, ordered by season_rank and densely
// re-ranked, reproduces exactly the r and N the original close fed the curve. That is not merely
// assumed — the script recomputes each row's OLD score from the reconstructed pool and refuses to
// write anything for a season whose stored scores don't match it. If a future close ever breaks
// the band_at_close/is_placed correspondence, this aborts instead of writing garbage.
//
// Idempotent: a season already scored on the current curve reports no changes and writes nothing.
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../lib/supabase/types";
import { allTimeSeasonScore } from "../lib/mmr/allTimeRating";
import { fetchAllPages } from "../lib/mmr/peakMmrRecompute";

// The pre-change curve, frozen here on purpose. It is what produced the stored numbers, so it is
// history, not shared logic: it must NOT track future edits to allTimeRating.ts, or the
// verification below would stop being able to tell an old season from a corrupted one. That is why
// every constant below is written out literally rather than imported, q included.
function legacySeasonScore(rank: number, placedCount: number): number {
  if (placedCount <= 2) return 0;
  if (!Number.isFinite(rank) || rank < 1 || rank > placedCount) return 0;
  const half = placedCount / 2 - 1;
  const b = (rank - 1) / half;
  if (b > 1) return 0;
  const k = 16.1045061696 * Math.pow(38 / (placedCount - 2), 0.25);
  const a = (100 * Math.log(100)) / (k * half);
  const score = Math.pow(100, 1 - b / (a + (1 - a) * b));
  return score < 1 ? 0 : score;
}

// season_score is a float4 column, so a stored value carries ~7 significant digits. Compare
// relatively, with an absolute floor for the scores that legitimately sit at 0.
function matches(stored: number, expected: number): boolean {
  return Math.abs(stored - expected) <= Math.max(1e-4, Math.abs(expected) * 1e-5);
}

// supabase-js builds a RealtimeClient eagerly inside createClient() and throws outright on Node
// < 22, which has no global WebSocket ("Node.js 20 detected without native WebSocket support").
// Nothing in this script touches realtime, so a stub that refuses to be constructed is enough to
// get past the check without pulling in `ws`. (scripts/backfill-peak-mmr.ts has the same gap.)
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class {
    constructor() {
      throw new Error("Realtime is not available in scripts");
    }
  };
}

function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient<Database>(url, serviceRoleKey, { auth: { persistSession: false } });
}

type HistoryRow = {
  season_id: string;
  player_id: string;
  season_rank: number;
  band_at_close: string | null;
  season_score: number;
};

async function main() {
  const write = process.argv.includes("--write");
  const supabase = createAdminClient();

  // Paged, and totally ordered on the (season_id, player_id) primary key: .range() is LIMIT/OFFSET
  // over an unspecified planner order, so an unordered paged read can drop and duplicate rows.
  const rows = (await fetchAllPages((from, to) =>
    supabase
      .from("crl6mansqueuebot_season_history")
      .select("season_id, player_id, season_rank, band_at_close, season_score")
      .order("season_id")
      .order("player_id")
      .range(from, to)
      .then((r) => {
        if (r.error) throw r.error;
        return r.data ?? [];
      }),
  )) as HistoryRow[];

  const { data: seasons, error: seasonsError } = await supabase
    .from("crl6mansqueuebot_seasons")
    .select("id, season_number")
    .order("season_number");
  if (seasonsError) throw seasonsError;
  const seasonName = new Map((seasons ?? []).map((s) => [s.id, `Season ${s.season_number}`]));

  const bySeason = new Map<string, HistoryRow[]>();
  for (const row of rows) {
    const list = bySeason.get(row.season_id);
    if (list) list.push(row);
    else bySeason.set(row.season_id, [row]);
  }

  console.log(
    `Loaded ${rows.length} season_history row(s) across ${bySeason.size} closed season(s).`,
  );

  const updates: { season_id: string; player_id: string; from: number; to: number }[] = [];
  const problems: string[] = [];

  for (const [seasonId, seasonRows] of bySeason) {
    const label = `${seasonName.get(seasonId) ?? "?"} (${seasonId.slice(0, 8)})`;
    const ordered = [...seasonRows].sort((a, b) => a.season_rank - b.season_rank);
    const placed = ordered.filter((r) => r.band_at_close !== null);
    const unplaced = ordered.filter((r) => r.band_at_close === null);

    // Verify before touching anything: every row must already hold either the legacy score for its
    // reconstructed placement or the current one (a season closed after the change, or a rerun).
    const legacyOk = placed.every((r, i) =>
      matches(r.season_score, legacySeasonScore(i + 1, placed.length)),
    );
    const currentOk = placed.every((r, i) =>
      matches(r.season_score, allTimeSeasonScore(i + 1, placed.length)),
    );
    const unplacedOk = unplaced.every((r) => r.season_score === 0);

    console.log(
      `\n${label}: ${ordered.length} row(s), ${placed.length} placed, ${unplaced.length} unplaced` +
        ` — stored scores match ${currentOk ? "the CURRENT curve" : legacyOk ? "the LEGACY curve" : "NEITHER curve"}`,
    );

    if (!unplacedOk) {
      problems.push(`${label}: an unplaced participant has a non-zero season_score`);
      continue;
    }
    if (!legacyOk && !currentOk) {
      problems.push(
        `${label}: stored scores match neither the legacy nor the current curve over the ` +
          `band_at_close-derived pool of ${placed.length} — refusing to rescore it`,
      );
      for (const [i, r] of placed.slice(0, 5).entries()) {
        console.log(
          `    r=${i + 1} player=${r.player_id} stored=${r.season_score.toFixed(4)} ` +
            `legacy=${legacySeasonScore(i + 1, placed.length).toFixed(4)} ` +
            `current=${allTimeSeasonScore(i + 1, placed.length).toFixed(4)}`,
        );
      }
      continue;
    }

    let oldPool = 0;
    let newPool = 0;
    let oldPaid = 0;
    placed.forEach((r, i) => {
      const next = allTimeSeasonScore(i + 1, placed.length);
      oldPool += r.season_score;
      newPool += next;
      if (r.season_score > 0) oldPaid++;
      if (!matches(r.season_score, next)) {
        updates.push({
          season_id: seasonId,
          player_id: r.player_id,
          from: r.season_score,
          to: next,
        });
      }
    });
    console.log(
      `    pool ${oldPool.toFixed(2)} -> ${newPool.toFixed(2)}, players paid ${oldPaid} -> ${placed.length}`,
    );
  }

  if (problems.length > 0) {
    console.error(`\nAborting — ${problems.length} season(s) failed verification:`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }

  if (updates.length === 0) {
    console.log("\nEvery season already scores on the current curve. Nothing to do.");
    return;
  }

  console.log(`\n${updates.length} row(s) to rescore:`);
  for (const u of updates.slice(0, 60)) {
    console.log(
      `  season=${u.season_id.slice(0, 8)} player=${u.player_id} ${u.from.toFixed(4)} -> ${u.to.toFixed(4)}`,
    );
  }
  if (updates.length > 60) console.log(`  ...and ${updates.length - 60} more.`);

  if (!write) {
    console.log("\nDry run only — no writes performed. Re-run with --write to persist these values.");
    return;
  }

  console.log("\nWriting...");
  let written = 0;
  for (const u of updates) {
    const { error } = await supabase
      .from("crl6mansqueuebot_season_history")
      .update({ season_score: u.to })
      .eq("season_id", u.season_id)
      .eq("player_id", u.player_id);
    if (error) {
      console.error(`Failed to write season=${u.season_id} player=${u.player_id}:`, error.message);
      continue;
    }
    written++;
  }
  console.log(`Done. Wrote ${written}/${updates.length} rows.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
