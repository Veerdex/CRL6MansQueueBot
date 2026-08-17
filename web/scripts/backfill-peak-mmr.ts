// Corrective backfill for players.peak_mmr. Migration 0031_peak_mmr.sql's original backfill
// (`peak_mmr = greatest(mmr, 0)`) only captured each player's CURRENT mmr at the moment that
// migration happened to run — not their true historical high — so anyone whose mmr had already
// come back down (a losing streak, season decay, an admin correction) by that point got a
// peak_mmr floored at whatever low/negative value they were sitting at right then, permanently
// understating their real peak. This script reconstructs the true peak by replaying full MMR
// history via the shared web/lib/mmr/peakMmrRecompute.ts module (which itself delegates to
// web/lib/mmr/reconstructMmrHistory.ts, unit-tested separately) — see those modules' header
// comments for exactly what is and isn't modeled. The same peakMmrRecompute.ts module is also
// called live from the /admin correct-report and /correct paths, which — unlike this script —
// are allowed to LOWER a stored peak that a since-corrected misreport had inflated.
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
import { recomputeTruePeakMmr, fetchAllPages } from "../lib/mmr/peakMmrRecompute";

function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient<Database>(url, serviceRoleKey, { auth: { persistSession: false } });
}

async function main() {
  const write = process.argv.includes("--write");
  const supabase = createAdminClient();

  const players = await fetchAllPages((from, to) =>
    supabase.from("crl6mansqueuebot_players").select("id, discord_id, mmr, peak_mmr, is_placed, is_test_data").order("id").range(from, to).then((r) => {
      if (r.error) throw r.error;
      return r.data ?? [];
    }),
  );
  const realPlayers = players.filter((p) => !p.is_test_data);

  console.log(`Loaded ${realPlayers.length} real players. Replaying full MMR history...`);

  const result = await recomputeTruePeakMmr(supabase);

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
