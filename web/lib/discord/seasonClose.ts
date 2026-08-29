import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getConfigNumber } from "./config";
import { resetAllPlacementsToUnranked } from "./bands";
import { getGuildId, addMemberRole, removeMemberRole } from "./rest";
import type { SeasonRow } from "@/lib/supabase/types";

type CloseSummary = {
  participants: number;
  top10: number;
  playersDecayed: number;
  playersReset: number;
  prismGranted: number;
  prismRevoked: number;
};

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
// Prism is a season-end achievement, granted/revoked ONLY here — the top `prism_top_n` players by
// MMR (any band, >= top10_min_games this season) hold it for the entire following season,
// stacked alongside their real band role, until the next season close re-evaluates it. See
// CLAUDE.md, "Bands / ranks". The `made_top10`/season_history write below shares the exact same
// ranking as the archival record of that season's standings.
//
// After decay, every currently-placed player is reset back to Unranked (bands.ts's
// resetAllPlacementsToUnranked — see CLAUDE.md, "Seasons") so a new season starts with everyone
// re-earning their band from scratch. This must run AFTER applyMmrDecay, since that function's
// own pool query filters on is_placed = true — reset first and decay would find nobody to decay.
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
    // No games played this season — nobody can qualify for a fresh Prism grant, but anyone
    // holding it from the season that just ended still needs to be cleared out.
    const { revoked: prismRevoked } = await syncPrismRoles(supabase, new Set(), new Map());
    const playersDecayed = await applyMmrDecay(supabase, decayFactor);
    const playersReset = await resetAllPlacementsToUnranked();
    return { participants: 0, top10: 0, playersDecayed, playersReset, prismGranted: 0, prismRevoked };
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

  const discordIdById = new Map(players.map((p) => [p.id, p.discord_id]));
  const { granted: prismGranted, revoked: prismRevoked } = await syncPrismRoles(supabase, top10Ids, discordIdById);

  const playersDecayed = await applyMmrDecay(supabase, decayFactor);
  const playersReset = await resetAllPlacementsToUnranked();

  return { participants: ranked.length, top10: top10Ids.size, playersDecayed, playersReset, prismGranted, prismRevoked };
}

// ---------------------------------------------------------------------------
// Grants Prism to every player in `top10Ids` who doesn't already hold it, and revokes it from
// every current holder who isn't in `top10Ids` this time — a plain additive/subtractive diff, not
// a swap. Best-effort per player (mirrors resetAllPlacementsToUnranked's pattern): one Discord
// failure sets role_sync_pending so bands.ts's retry pass can pick it up later, and never blocks
// the DB write or the rest of the diff. `discordIdById` only needs to cover `top10Ids` — current
// holders' discord_ids come from the is_prism=true query itself.
// ---------------------------------------------------------------------------
// Pure diff core of syncPrismRoles, pulled out so it can be unit-tested without a Supabase/Discord
// mock harness (this file's only I/O-free logic worth pinning directly): repeat top-N finishers
// are a no-op, everyone else in top10Ids is a grant, every current holder not in top10Ids is a
// revoke — including all of them when top10Ids is empty (the zero-participant season-close path).
export function diffPrismRoles(
  currentPrismIds: Set<string>,
  top10Ids: Set<string>,
): { toRevokeIds: Set<string>; toGrant: string[] } {
  const toRevokeIds = new Set([...currentPrismIds].filter((id) => !top10Ids.has(id)));
  const toGrant = [...top10Ids].filter((id) => !currentPrismIds.has(id));
  return { toRevokeIds, toGrant };
}

async function syncPrismRoles(
  supabase: SupabaseAdmin,
  top10Ids: Set<string>,
  discordIdById: Map<string, string>,
): Promise<{ granted: number; revoked: number }> {
  const { data: bandRoleRows } = await supabase.from("crl6mansqueuebot_band_roles").select("*");
  const roleIdByBand = new Map((bandRoleRows ?? []).map((r) => [r.band, r.role_id]));
  const prismRoleId = roleIdByBand.get("Prism");

  let guildId: string | null = null;
  if (prismRoleId) {
    try {
      guildId = await getGuildId();
    } catch (err) {
      console.error("Season close: failed to resolve guild id, skipping Prism role sync", err);
    }
  }

  const { data: currentPrismRows } = await supabase
    .from("crl6mansqueuebot_players")
    .select("id, discord_id")
    .eq("is_prism", true)
    .eq("is_test_data", false);
  const currentPrism = currentPrismRows ?? [];
  const { toRevokeIds, toGrant } = diffPrismRoles(
    new Set(currentPrism.map((p) => p.id)),
    top10Ids,
  );
  const toRevoke = currentPrism.filter((p) => toRevokeIds.has(p.id));

  for (const p of toRevoke) {
    await supabase.from("crl6mansqueuebot_players").update({ is_prism: false }).eq("id", p.id);
    if (guildId && prismRoleId) {
      try {
        await removeMemberRole(guildId, p.discord_id, prismRoleId);
      } catch (err) {
        console.error(`Season close: failed to remove Prism role for ${p.discord_id}`, err);
        await supabase.from("crl6mansqueuebot_players").update({ role_sync_pending: true }).eq("id", p.id);
      }
    }
  }

  for (const id of toGrant) {
    await supabase.from("crl6mansqueuebot_players").update({ is_prism: true }).eq("id", id);
    if (guildId && prismRoleId) {
      const discordId = discordIdById.get(id);
      if (discordId) {
        try {
          await addMemberRole(guildId, discordId, prismRoleId);
        } catch (err) {
          console.error(`Season close: failed to add Prism role for ${discordId}`, err);
          await supabase.from("crl6mansqueuebot_players").update({ role_sync_pending: true }).eq("id", id);
        }
      }
    }
  }

  return { granted: toGrant.length, revoked: toRevoke.length };
}

// ---------------------------------------------------------------------------
// Soft reset — every currently placed, non-test player (not just this season's participants,
// see CLAUDE.md, "Seasons"), applied after standings are already written.
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
      .eq("is_placed", true)
      .eq("is_test_data", false)
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
