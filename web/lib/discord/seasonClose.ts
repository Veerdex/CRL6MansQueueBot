import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getConfigNumber } from "./config";
import { sendDirectMessage, getGuildId, addMemberRole, removeMemberRole } from "./rest";
import type { SeasonRow } from "@/lib/supabase/types";

type CloseSummary = { participants: number; top10: number; playersDecayed: number };

type SupabaseAdmin = ReturnType<typeof createAdminClient>;

// PostgREST caps unbounded selects at a project-configured max (commonly 1000) — a season with
// enough games/participants to exceed that would silently truncate results with no error,
// corrupting season_rank/Top10/Prism. Every select below that can grow with community size is
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
// ---------------------------------------------------------------------------

export async function closeSeason(closedSeason: Pick<SeasonRow, "id">): Promise<CloseSummary> {
  const supabase = createAdminClient();

  const [decayFactor, top10MinGames] = await Promise.all([
    getConfigNumber("decay_factor", 0.25),
    getConfigNumber("top10_min_games", 8),
  ]);

  // ---- 1. Season standings: season_rank for every participant (>=1 reported game that
  // season, either queue — see CLAUDE.md, "Queueing"), made_top10 for the top 10 among those
  // with >= top10_min_games. ----

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
  // for the #10 Top 10 cutoff.
  const ranked = players
    .map((p) => ({ player: p, seasonGames: gamesPlayedByPlayerId.get(p.id) ?? 0 }))
    .sort((a, b) => b.player.mmr - a.player.mmr || b.seasonGames - a.seasonGames || a.player.id.localeCompare(b.player.id));

  const eligibleForTop10 = ranked.filter((r) => r.seasonGames >= top10MinGames);
  const top10Ids = new Set(eligibleForTop10.slice(0, 10).map((r) => r.player.id));

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

  // ---- 2. Prism role sync — strip from last season's holders who didn't repeat, grant to
  // this season's new Top 10. Reuses band_roles/'Prism' for storage (migration 0010) rather
  // than a dedicated table; recomputeBands() (bands.ts) never touches this key. ----

  const { data: previousHolders } = await supabase
    .from("crl6mansqueuebot_players")
    .select("id, discord_id")
    .eq("is_prism", true)
    .eq("is_test_data", false);
  const previousHolderIds = new Set((previousHolders ?? []).map((p) => p.id));

  const newTop10 = ranked.filter((r) => top10Ids.has(r.player.id)).map((r) => r.player);
  const toStrip = (previousHolders ?? []).filter((p) => !top10Ids.has(p.id));
  const toGrant = newTop10.filter((p) => !previousHolderIds.has(p.id));

  const { data: prismRoleRow } = await supabase
    .from("crl6mansqueuebot_band_roles")
    .select("role_id")
    .eq("band", "Prism")
    .maybeSingle();
  const prismRoleId = prismRoleRow?.role_id ?? null;

  let guildId: string | null = null;
  if (prismRoleId) {
    try {
      guildId = await getGuildId();
    } catch (err) {
      console.error("Season close: failed to resolve guild id, skipping Prism role sync this run", err);
    }
  }

  await Promise.all(
    toStrip.map(async (p) => {
      await supabase.from("crl6mansqueuebot_players").update({ is_prism: false }).eq("id", p.id);
      if (guildId && prismRoleId) {
        try {
          await removeMemberRole(guildId, p.discord_id, prismRoleId);
        } catch (err) {
          console.error(`Season close: failed to strip Prism role from ${p.discord_id}`, err);
        }
      }
      await sendDirectMessage(p.discord_id, "The season has ended — your **Prism** (Top 10) role has been removed as standings reset for the new season.");
    }),
  );

  await Promise.all(
    toGrant.map(async (p) => {
      await supabase.from("crl6mansqueuebot_players").update({ is_prism: true }).eq("id", p.id);
      if (guildId && prismRoleId) {
        try {
          await addMemberRole(guildId, p.discord_id, prismRoleId);
        } catch (err) {
          console.error(`Season close: failed to grant Prism role to ${p.discord_id}`, err);
        }
      }
      await sendDirectMessage(p.discord_id, "You finished in the **Top 10** last season! You've been awarded the **Prism** role.");
    }),
  );

  const playersDecayed = await applyMmrDecay(supabase, decayFactor);

  return { participants: ranked.length, top10: top10Ids.size, playersDecayed };
}

// ---------------------------------------------------------------------------
// Median-compression soft reset — every currently placed, non-test player (not just this
// season's participants, see CLAUDE.md, "Seasons"), applied after standings are already
// written. `new = old - (old - median) * decay_factor` is strictly increasing in `old` for
// any 0 < decay_factor < 1, so it never reorders players by MMR — no band recompute is needed
// here as a result; the next daily cron tick handles band drift exactly as it would on any
// other day (see bands.ts).
// ---------------------------------------------------------------------------

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
    pool.map((p) => supabase.from("crl6mansqueuebot_players").update({ mmr: p.mmr - (p.mmr - median) * decayFactor }).eq("id", p.id)),
  );
  return pool.length;
}
