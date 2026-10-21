import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendDirectMessage, editOriginalResponse, getGuildId, getMemberRoles, addMemberRole, removeMemberRole, listAllGuildMembers, isUnknownMemberError, getRankEmoji, BRAND_COLOR } from "./rest";
import { getConfigNumber, getConfigValue, getFixedRankConfig, type FixedRankThresholds } from "./config";
import { hasAdminAccess, logAdminAction } from "./admin";
import { interactionUserId, type DiscordInteraction } from "./types";
import type { Band, BandRoleKey } from "@/lib/supabase/types";
import { getRankLabel } from "@/lib/leaderboard/rankIcon";

// Same fetchAllPages/chunk pattern as avatars.ts, nicknameSync.ts, and seasonClose.ts, duplicated
// rather than imported for the reason avatars.ts:7 records. PostgREST silently truncates an
// unbounded select at a project row cap (1000 rows), with no error and no marker on the response
// — reached here at ~167 reported matches in one season, where a short read would quietly
// undercount a player out of Prism qualification.
// Every paged read needs a *total* order on a unique key as well: .range() is LIMIT/OFFSET over
// whatever order the planner happened to pick, so without one a page boundary can repeat a row
// and drop another. series_players' primary key is (series_id, player_id).
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

const BAND_ORDER: Band[] = ["Iron", "Garnet", "Emerald", "Sapphire"];
const VALID_BAND_ROLE_KEYS: BandRoleKey[] = ["Iron", "Garnet", "Emerald", "Sapphire", "Unranked", "Prism"];

type RecomputeSummary = {
  placed: number;
  promoted: number;
  demoted: number;
  unchanged: number;
  prismGranted: number;
  prismRevoked: number;
  // Count of players left with role_sync_pending=true after this run — see
  // reconcileMemberRole and migration 0046_role_sync_pending.sql. Non-zero means at least one
  // Discord role add/remove failed (rate limit or otherwise) and will retry on the next
  // recompute; surfaced so /admin recompute-bands can flag it instead of it going unnoticed.
  roleSyncPending: number;
};
type ChangeAction = "placed" | "promoted" | "demoted";

// See migration 0046_role_sync_pending.sql. Reconciles a player's actual live Discord roles
// against the single role (a band, Prism, or Unranked) they should hold, instead of trusting our
// own band/is_prism columns to infer which role they currently wear and issuing a blind
// remove-old/add-new pair. Two production bugs this replaces:
//   1. A Prism holder's `band` column still reads their underlying band (Prism only overlays a
//      role swap on top of it, never touching the column) — so "remove roleIdByBand.get(oldBand)"
//      targeted a role the player never actually had equipped, and the real Prism role was never
//      touched by a normal band-change path.
//   2. Any transient Discord failure (rate limit, etc.) partway through a remove/add pair left
//      Discord holding some stale combination of roles with no way to detect or retry it, since
//      the DB's band/is_prism value had already committed to the new "target" state.
// Fetching live roles and diffing against the tracked role-ID set (every configured band/Unranked/
// Prism role) fixes both at once and is naturally idempotent — safe to re-run on a fresh retry
// pass no matter what partial state a prior failed attempt left behind. Never throws — it
// returns an outcome instead, so callers can set role_sync_pending for a later retry rather than
// wrongly assuming success.

// Outcome of one player's role reconcile. "absent" is deliberately distinct from "failed": a
// member route 404s permanently once that user has left the guild, and treating that as a failure
// would leave every ex-member flagged role_sync_pending forever — which both retries them on
// every future run and destroys the "non-zero means something actually broke" meaning of
// RecomputeSummary.roleSyncPending. Only "failed" is worth recording and retrying.
type RoleSyncResult = "synced" | "failed" | "absent";

// The single role a player should be wearing, derived purely from their committed row. Prism
// overlays the band role rather than replacing the `band` column, so it wins when set; a player
// with no band at all is Unranked, not role-less — that last clause is what a season reset needs
// and what the pre-fix retry pass got wrong (it passed `undefined`, meaning "strip every tracked
// role and add nothing", so a reset player who reached it ended up wearing no rank role at all).
export function desiredRoleIdFor(
  player: { band: string | null; is_prism: boolean },
  roleIdByBand: Map<string, string>,
): string | undefined {
  if (player.is_prism) return roleIdByBand.get("Prism");
  if (player.band) return roleIdByBand.get(player.band);
  return roleIdByBand.get("Unranked");
}

async function reconcileMemberRole(
  guildId: string,
  discordId: string,
  desiredRoleId: string | undefined,
  roleIdByBand: Map<string, string>,
  // Live role ids for this member when the caller already has them (the full-roster sweep below
  // reads the whole guild in one paginated request). Omit to fetch this member's roles directly.
  knownRoleIds?: string[],
): Promise<RoleSyncResult> {
  try {
    const trackedRoleIds = new Set(roleIdByBand.values());
    const currentRoleIds = knownRoleIds ?? (await getMemberRoles(guildId, discordId));
    const toRemove = currentRoleIds.filter((r) => trackedRoleIds.has(r) && r !== desiredRoleId);
    const needsAdd = desiredRoleId !== undefined && !currentRoleIds.includes(desiredRoleId);
    // Already correct — return without issuing a single write. This is what makes a full-roster
    // sweep affordable: on a normal day every player is already right, so the sweep costs one
    // guild-member list read and nothing else.
    if (toRemove.length === 0 && !needsAdd) return "synced";
    // Serial rather than Promise.all: role add/remove shares one per-guild rate-limit bucket, so
    // firing them together just converts into 429s and backoff.
    for (const roleId of toRemove) {
      await removeMemberRole(guildId, discordId, roleId);
    }
    if (needsAdd) await addMemberRole(guildId, discordId, desiredRoleId);
    return "synced";
  } catch (err) {
    if (isUnknownMemberError(err)) return "absent";
    console.error(`Band recompute: failed to reconcile Discord role for ${discordId}`, err);
    return "failed";
  }
}

type RoleSyncTarget = {
  id: string;
  discord_id: string;
  band: string | null;
  is_prism: boolean;
  role_sync_pending: boolean;
};

// Bounded-concurrency map. Enough parallelism to clear a real backlog inside a serverless
// function's budget, low enough not to bury Discord's per-guild bucket in 429s.
const ROLE_SYNC_CONCURRENCY = 4;

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ---------------------------------------------------------------------------
// Role reconciliation for the roster, split out from the band math because the two have genuinely
// different scopes. Band and Prism assignment need `pool` — percentiles only mean anything across
// the placed cohort. The role a player should be *wearing*, by contrast, is a pure function of
// their committed row (desiredRoleIdFor above), and that is perfectly well defined for an
// unplaced player: Unranked.
//
// Conflating the two is what let a live bug persist. /newseason's resetAllPlacementsToUnranked()
// flips the whole roster to is_placed=false, so every reset player falls out of `pool` — and both
// recomputeBands()'s band loops *and* its role_sync_pending retry pass iterated `pool`. Any role
// swap the reset itself failed to land was therefore unreachable forever: reported live as
// players sitting Unranked for the new season while still wearing last season's Sapphire/Garnet/
// Emerald role in Discord.
//
// `sweepAll` widens the pass from "players still flagged pending" to "every player handed in",
// and is opt-in for a reason: recomputeBands() also runs on every reported match (report.ts), and
// a full-roster Discord pass has no business on that latency-sensitive path. Only the daily cron
// route and /admin recompute-bands ask for it. The pass is idempotent and re-runnable, so a run
// cut short by a function timeout simply does less and the next one picks up the rest.
// ---------------------------------------------------------------------------

async function syncPlayerRoles(
  supabase: ReturnType<typeof createAdminClient>,
  guildId: string,
  roleIdByBand: Map<string, string>,
  players: RoleSyncTarget[],
  // Players whose band/Prism change already got a fresh reconcile attempt earlier this run.
  handledIds: Set<string>,
  sweepAll: boolean,
): Promise<void> {
  const candidates = players.filter((p) => !handledIds.has(p.id) && (sweepAll || p.role_sync_pending));
  if (candidates.length === 0) return;

  // One paginated read carries every member's live `roles` array, so a full-roster sweep costs
  // ~1 read plus writes only for the members actually wrong — versus one GET per player if each
  // reconcile fetched its own. Same helper the daily avatar/nickname sweeps already use. The
  // targeted retry path stays on per-player reads: it is normally a handful of players, and
  // pulling the entire member list for them would cost more than it saves.
  let rolesByDiscordId: Map<string, string[]> | null = null;
  if (sweepAll) {
    try {
      const members = await listAllGuildMembers(guildId);
      // A short page is indistinguishable from the last page (listAllGuildMembers stops when a
      // batch comes back under the limit), the same silent-truncation shape this file warns about
      // for PostgREST at :11. It matters more here than there: every player missing from a
      // truncated list gets classified "absent" below, which clears their pending flag and skips
      // their role write entirely — a sweep that reports success and fixes nothing. Guild
      // membership is a superset of the roster minus whoever has actually left, so a list shorter
      // than the roster itself is not credible. Throwing falls through to the per-player path,
      // which is slower but reaches the same answer (a departed member 404s to "absent" on its
      // own), so a false positive here only costs time.
      if (members.length < players.length) {
        throw new Error(`guild member list looks truncated: ${members.length} members vs ${players.length} players`);
      }
      rolesByDiscordId = new Map(members.map((m) => [m.user.id, m.roles]));
    } catch (err) {
      console.error("Band recompute: guild member list failed, falling back to per-player role reads", err);
    }
  }

  await mapWithConcurrency(candidates, ROLE_SYNC_CONCURRENCY, async (player) => {
    const knownRoleIds = rolesByDiscordId?.get(player.discord_id);
    // We have the guild list but this player is absent from it = they have left the server. Same
    // handling as reconcileMemberRole's "absent": nothing to fix, nothing broken on our side.
    const result: RoleSyncResult =
      rolesByDiscordId && !knownRoleIds
        ? "absent"
        : await reconcileMemberRole(
            guildId,
            player.discord_id,
            desiredRoleIdFor(player, roleIdByBand),
            roleIdByBand,
            knownRoleIds,
          );

    const pending = result === "failed";
    if (pending === player.role_sync_pending) return;
    await supabase.from("crl6mansqueuebot_players").update({ role_sync_pending: pending }).eq("id", player.id);
    player.role_sync_pending = pending;
  });
}

export type BandCutoffConfig = {
  garnetCutoff: number;
  emeraldCutoff: number;
  sapphireCutoff: number;
};

// Pure decision logic — no Discord, no DB — extracted from the recompute loop below so the
// promotion/demotion rules (see CLAUDE.md, "Bands / ranks") can be unit tested directly.
export function targetBandForPercentile(pctile: number, config: BandCutoffConfig): Band {
  if (pctile >= config.sapphireCutoff) return "Sapphire";
  if (pctile >= config.emeraldCutoff) return "Emerald";
  if (pctile >= config.garnetCutoff) return "Garnet";
  return "Iron";
}

// Fixed-MMR alternative to targetBandForPercentile, used when /admin fixed-ranks toggle is on.
// Takes *display* MMR (mmr * mmr_scale + mmr_shift, rounded — the number players actually see),
// since the thresholds are configured in display terms. Prism isn't a BAND_ORDER tier, so it's
// handled separately by isFixedRankPrism; a Prism-threshold player's band is still Sapphire.
export function targetBandForFixedMmr(displayMmr: number, thresholds: FixedRankThresholds): Band {
  if (displayMmr >= thresholds.sapphire) return "Sapphire";
  if (displayMmr >= thresholds.emerald) return "Emerald";
  if (displayMmr >= thresholds.garnet) return "Garnet";
  return "Iron";
}

// Under fixed ranks Prism is just another threshold: no top-N cap and no top10_min_games season
// minimum — every placed player at or above it holds Prism.
export function isFixedRankPrism(displayMmr: number, thresholds: FixedRankThresholds): boolean {
  return displayMmr >= thresholds.prism;
}

export type BandCalcMode = "position" | "mmr";

// /admin band-calc-mode mode:<position|mmr> — see CLAUDE.md, "Bands / ranks". Two ways to turn
// the placed pool's MMR ordering into a percentile for targetBandForPercentile above:
//   - "position" (default, original behavior): purely rank-order — the lowest-MMR player in the
//     pool sits at 0th percentile, the highest at (n-1)/n*100, evenly spaced regardless of how
//     close or far apart players' actual MMR values are. A pack of players separated by single
//     points spreads across percentiles exactly as if they were separated by hundreds.
//   - "mmr": percentile instead reflects where a player's raw MMR falls within the pool's actual
//     MMR range — (mmr - min) / (max - min) * 100 — so a tight cluster of similar MMRs stays
//     clustered in percentile too, and a standout player's real lead shows up directly instead of
//     being flattened to "one rank above the next player." Requested after a live 9-player
//     leaderboard showed bands that didn't track actual MMR gaps under "position" mode.
// Pure and exported so this can be unit tested the same way targetBandForPercentile/
// computeBandChange are, without needing a DB pool.
export function computeBandPercentiles(
  pool: { id: string; mmr: number; total_games_played: number }[],
  mode: BandCalcMode,
): Map<string, number> {
  // Tied MMR is broken by total_games_played (more games at the same rating = more established,
  // ranks slightly higher), then player id as a final deterministic tiebreak — same ordering
  // regardless of mode, since "mmr" mode still needs a stable sort for the min/max/tiebreak.
  const sorted = pool
    .slice()
    .sort((a, b) => a.mmr - b.mmr || a.total_games_played - b.total_games_played || a.id.localeCompare(b.id));
  const n = sorted.length;

  if (mode === "mmr") {
    const min = sorted[0].mmr;
    const max = sorted[n - 1].mmr;
    const range = max - min;
    // Every player tied on MMR (range 0) has no real spread to measure — park them all at the
    // midpoint rather than dividing by zero or arbitrarily favoring one end.
    return new Map(sorted.map((p) => [p.id, range === 0 ? 50 : ((p.mmr - min) / range) * 100]));
  }

  // 0-indexed (lowest-MMR player = 0th percentile, not 1/n) so the ladder is symmetric around
  // its cutoffs — (i+1)/n previously shifted every rung up by one step, which made the bottom
  // cutoff harder to clear than the mirrored top cutoff at the same pool size (see CLAUDE.md,
  // "Band percentile cutoffs").
  return new Map(sorted.map((p, i) => [p.id, (i / n) * 100]));
}

// Converts a cutoff percentile into a concrete threshold MMR value, for /ranks' live cutoff
// display below. Mirrors computeBandPercentiles's
// two band_calc_mode formulas, inverted to solve for "the MMR value at this cutoff" instead of
// "the percentile of this MMR value":
//   - "mmr": linear interpolation within the pool's MMR range — min + cutoffPercent/100 * (max - min).
//   - "position": the MMR of the player who sits exactly at the cutoff rank. Expressed here as a
//     rank-from-top (floor(n * (1 - cutoffPercent/100))) rather than computeBandPercentiles's
//     ascending index, but the two are provably equivalent: solving (i/n)*100 >= cutoffPercent for
//     the smallest ascending index gives i_min = ceil(cutoff*n/100), and floor(n-x) = n-ceil(x), so
//     "floor rank-from-top, then convert to ascending index" lands on the exact same player. Floor
//     (rather than round-half-up) was chosen specifically so this stays consistent with that
//     already-shipped ascending-index rule instead of introducing a second rounding convention.
//     Out-of-range ranks (extreme cutoffs or a tiny pool) fall back to the top or bottom player.
export function computeBandThresholdMmr(
  pool: { id: string; mmr: number; total_games_played: number }[],
  cutoffPercent: number,
  mode: BandCalcMode,
): number {
  const sorted = pool
    .slice()
    .sort((a, b) => a.mmr - b.mmr || a.total_games_played - b.total_games_played || a.id.localeCompare(b.id));
  const n = sorted.length;
  const min = sorted[0].mmr;
  const max = sorted[n - 1].mmr;

  if (mode === "mmr") {
    return min + (cutoffPercent / 100) * (max - min);
  }

  let rankFromTop = Math.floor(n * (1 - cutoffPercent / 100));
  if (rankFromTop < 1) rankFromTop = 1; // fall back to the top player
  if (rankFromTop > n) rankFromTop = n; // fall back to the bottom player
  const ascendingIndex = n - rankFromTop;
  return sorted[ascendingIndex].mmr;
}

// Demotions are symmetric with promotions: a player moves to whatever band their current
// standing says (targetBandForPercentile or targetBandForFixedMmr), in either direction. The old
// grace-period/hysteresis demotion buffers (grace_games, grace_inactivity_days, hysteresis_mmr)
// were removed — see CLAUDE.md, "Bands / ranks".
export function computeBandChange(
  player: { band: Band | null },
  targetBand: Band,
  isNewlyPlaced: boolean,
): { action: ChangeAction; targetBand: Band } | null {
  if (isNewlyPlaced) {
    return { action: "placed", targetBand };
  }

  const currentIndex = BAND_ORDER.indexOf(player.band as Band);
  const targetIndex = BAND_ORDER.indexOf(targetBand);

  if (targetIndex > currentIndex) return { action: "promoted", targetBand };
  if (targetIndex < currentIndex) return { action: "demoted", targetBand };
  return null;
}

// ---------------------------------------------------------------------------
// Band recompute — see CLAUDE.md, "Bands / ranks". Percentile-ranks every currently-placed
// player (plus anyone crossing the placement threshold this run) by MMR, assigns bands off
// admin-configured cumulative cutoffs, and syncs Discord roles + DMs for anyone whose band actually changed. Once the
// band loop finishes, a second pass evaluates the live Prism top-N overlay (see the block right
// before this function's `return summary` for the full explanation).
//
// Every caller (the pg_cron-triggered daily route, report.ts after each Rank Queue settlement,
// and /admin unreport/correct-report/recompute-bands) evaluates and writes the FULL currently-
// placed pool, not just whichever players triggered this particular call. This was a deliberate
// fix: an earlier version scoped writes to `onlyPlayerIds` (the 6 players in the triggering
// series), which meant a player's band was only ever re-examined on their own next report — in a
// small/growing pool, an early placer's band gets computed against a tiny pool at the moment
// they cross placement_games_required (the very first player to place is trivially 100th
// percentile), and nothing ever re-evaluated them even as the true pool (and their true percentile) shifts under
// them. Re-evaluating everyone on every recompute means a player can now be corrected by *anyone
// else's* game changing the distribution, not just their own.
// ---------------------------------------------------------------------------

export async function recomputeBands(options?: { syncAllRoles?: boolean }): Promise<RecomputeSummary> {
  const supabase = createAdminClient();

  const [
    placementGamesRequired,
    garnetCutoff,
    emeraldCutoff,
    sapphireCutoff,
    prismTopN,
    top10MinGames,
    bandCalcModeRaw,
    fixedRanks,
    mmrScale,
    mmrShift,
  ] = await Promise.all([
    getConfigNumber("placement_games_required", 10),
    getConfigNumber("band_cutoff_garnet_pctile", 40),
    getConfigNumber("band_cutoff_emerald_pctile", 70),
    getConfigNumber("band_cutoff_sapphire_pctile", 90),
    getConfigNumber("prism_top_n", 1),
    getConfigNumber("top10_min_games", 8),
    getConfigValue("band_calc_mode"),
    getFixedRankConfig(),
    getConfigNumber("mmr_scale", 1),
    getConfigNumber("mmr_shift", 0),
  ]);
  const displayMmr = (mmr: number) => Math.round(mmr * mmrScale + mmrShift);
  const bandCalcMode: BandCalcMode = bandCalcModeRaw === "mmr" ? "mmr" : "position";
  const cutoffConfig: BandCutoffConfig = { garnetCutoff, emeraldCutoff, sapphireCutoff };

  const summary: RecomputeSummary = { placed: 0, promoted: 0, demoted: 0, unchanged: 0, prismGranted: 0, prismRevoked: 0, roleSyncPending: 0 };

  // Test-data players (dev panel) are synthetic and carry fake discord_ids that aren't real
  // guild members — role grant/revoke would just 404, and mixing them into the percentile pool
  // would distort real cutoffs. Exclude them entirely, same treatment as any other bot-side
  // Discord operation.
  const { data: players } = await supabase.from("crl6mansqueuebot_players").select("*").eq("is_test_data", false);
  const allPlayers = players ?? [];

  const alreadyPlaced = allPlayers.filter((p) => p.is_placed);
  // Gated on rank_games_played, not total_games_played — placement assigns a real band off the
  // player's MMR, so only Rank Queue games should count toward earning one. This doesn't
  // reintroduce the old chicken-and-egg bootstrap problem since Rank Queue is open to unplaced
  // players from game one.
  const newlyPlaced = allPlayers.filter((p) => !p.is_placed && p.rank_games_played >= placementGamesRequired);
  const pool = [...alreadyPlaced, ...newlyPlaced];

  const { data: bandRoleRows } = await supabase.from("crl6mansqueuebot_band_roles").select("*");
  const roleIdByBand = new Map((bandRoleRows ?? []).map((r) => [r.band, r.role_id]));

  let guildId: string | null = null;
  if (roleIdByBand.size > 0) {
    try {
      guildId = await getGuildId();
    } catch (err) {
      console.error("Band recompute: failed to resolve guild id, skipping role sync this run", err);
    }
  }

  // Tracks every player whose band/is_prism actually changed this run, across both loops below —
  // the role reconcile pass skips them since they already got a fresh reconcile attempt just now.
  const handledIds = new Set<string>();

  // No placed players and nobody crossing placement this run — computeBandPercentiles and
  // computeBandThresholdMmr both index sorted[0] and would throw on an empty pool, so there is
  // genuinely no band math to do. Roles still need reconciling though, and this is exactly the
  // state /newseason leaves behind (every player unplaced), which is the case the sweep exists
  // for — so bail out of the band work only, never out of the role pass.
  if (pool.length === 0) {
    if (guildId) await syncPlayerRoles(supabase, guildId, roleIdByBand, allPlayers, handledIds, options?.syncAllRoles === true);
    summary.roleSyncPending = allPlayers.filter((p) => p.role_sync_pending).length;
    return summary;
  }

  // Percentiles only matter in the default percentile mode; fixed ranks read each player's own MMR.
  const percentileById = fixedRanks ? null : computeBandPercentiles(pool, bandCalcMode);
  const newlyPlacedIds = new Set(newlyPlaced.map((p) => p.id));

  for (const player of pool) {
    const standingBand = fixedRanks
      ? targetBandForFixedMmr(displayMmr(player.mmr), fixedRanks)
      : targetBandForPercentile(percentileById!.get(player.id)!, cutoffConfig);
    const change = computeBandChange(player, standingBand, newlyPlacedIds.has(player.id));

    if (!change) {
      summary.unchanged += 1;
      continue;
    }

    const { action, targetBand } = change;

    // Peak MMR isn't tracked while unranked (see report.ts/adminTools.ts's write sites, which
    // skip the bump for an unplaced player) — so the moment a player actually places, seed it
    // from their current MMR rather than leaving it at whatever it was before (typically 0),
    // which would otherwise show a Peak below their real current MMR.
    const placementPeakUpdate: { peak_mmr?: number } = action === "placed" ? { peak_mmr: Math.max(player.peak_mmr, player.mmr) } : {};

    await supabase
      .from("crl6mansqueuebot_players")
      .update({ band: targetBand, is_placed: true, band_games_played: 0, ...placementPeakUpdate })
      .eq("id", player.id);
    handledIds.add(player.id);

    if (guildId) {
      // Desired role here is always the plain band role, never Prism, even for a player who
      // currently holds is_prism — a real band change means they've just left (or never held)
      // Sapphire, Prism's only source band, so the Prism pass right below will independently
      // compute willBePrism=false for them off this same mutated pool and reconcile them off
      // Prism on its own pass. reconcileMemberRole strips any other tracked role they hold
      // (their old band, Unranked, or a stale Prism role) as part of the same call, so the old
      // separate "remove Unranked on placement" branch is subsumed by this too.
      const desiredRoleId = roleIdByBand.get(targetBand);
      const result = await reconcileMemberRole(guildId, player.discord_id, desiredRoleId, roleIdByBand);
      // "absent" (this player has left the guild) is not a failure — see RoleSyncResult.
      const pending = result === "failed";
      await supabase.from("crl6mansqueuebot_players").update({ role_sync_pending: pending }).eq("id", player.id);
      player.role_sync_pending = pending;
    }

    // Mutate the local pool object so the Prism pass below sees this player's just-written
    // band/placement rather than the pre-recompute snapshot fetched at the top of this function.
    player.band = targetBand;
    player.is_placed = true;
    if (action === "placed") player.peak_mmr = placementPeakUpdate.peak_mmr!;

    summary[action] += 1;
  }

  // ---------------------------------------------------------------------------
  // Prism — a live top-N overlay, not a 5th BAND_ORDER tier (in percentile mode; under fixed
  // ranks it's a plain MMR threshold, see the fixedRanks branch below). Folding it into BAND_ORDER would
  // route it through computeBandChange's percentile cutoffs (which have no threshold for a tier
  // above Sapphire) — Prism instead gets its own strict top-N check, re-run every time this function runs (daily cron, every
  // Rank Queue report, admin unreport/correct-report/recompute-bands). A player holds Prism when
  // they're placed, sitting in the Sapphire band, have played at least `top10_min_games` Rank
  // Queue games *this season*, and rank inside the top `prism_top_n` by MMR of everyone else who
  // meets those same three requirements (see the qualify-then-cut note on the selection block
  // below). Falling out of the top N immediately un-sets is_prism; the player's `band` column already
  // holds their real underlying band (almost always Sapphire), so "go back to Sapphire" falls
  // out for free with no separate revert step. See CLAUDE.md, "Bands / ranks".
  // ---------------------------------------------------------------------------

  // Fixed ranks: Prism is an ordinary threshold (isFixedRankPrism) — no top-N cut, no season
  // game minimum, so none of the season-games bookkeeping below is needed.
  let newPrismIds: Set<string>;
  if (fixedRanks) {
    newPrismIds = new Set(pool.filter((p) => p.is_placed && isFixedRankPrism(displayMmr(p.mmr), fixedRanks)).map((p) => p.id));
  } else {
    const { data: activeSeasonRow } = await supabase
      .from("crl6mansqueuebot_seasons")
      .select("id")
      .eq("is_active", true)
      .maybeSingle();

    // Paged, because this is a count and a short read is indistinguishable from a low game count:
    // PostgREST silently truncates an unbounded select at a project row cap (1000 rows), which this
    // roster read reaches at ~167 reported matches in a single season. Undercounting here does not
    // just look wrong, it silently disqualifies players from Prism. .range() is LIMIT/OFFSET over
    // the planner's order, so each page needs a total order — series_players' PK is
    // (series_id, player_id). Same fetchAllPages/chunk pattern as avatars.ts (see its note at :7 on
    // why this small helper is duplicated per file rather than shared).
    const seasonGamesById = new Map<string, number>();
    if (activeSeasonRow) {
      const seasonSeries = await fetchAllPages((from, to) =>
        supabase
          .from("crl6mansqueuebot_series")
          .select("id")
          .eq("season_id", activeSeasonRow.id)
          .eq("status", "reported")
          .eq("queue_type", "rank")
          .eq("is_test_data", false)
          .order("id")
          .range(from, to)
          .then((r) => {
            if (r.error) throw r.error;
            return r.data ?? [];
          }),
      );
      const seriesIds = seasonSeries.map((s) => s.id);
      if (seriesIds.length > 0) {
        const seasonRosterChunks = await Promise.all(
          chunk(seriesIds, ID_CHUNK).map((idChunk) =>
            fetchAllPages((from, to) =>
              supabase
                .from("crl6mansqueuebot_series_players")
                .select("series_id, player_id")
                .in("series_id", idChunk)
                .order("series_id")
                .order("player_id")
                .range(from, to)
                .then((r) => {
                  if (r.error) throw r.error;
                  return r.data ?? [];
                }),
            ),
          ),
        );
        for (const sp of seasonRosterChunks.flat()) {
          seasonGamesById.set(sp.player_id, (seasonGamesById.get(sp.player_id) ?? 0) + 1);
        }
      }
    }

    // Three requirements, all applied as *qualification* before the cut is taken — a player either
    // qualifies for Prism or they don't, and the top `prism_top_n` qualifiers hold it: (1) placed,
    // (2) already Sapphire band — the real band assignment above already ran this cycle, so
    // `player.band` reflects it; this keeps a small community's Emerald/Garnet players out of Prism
    // contention even if their raw MMR would otherwise land them in the top-N bracket, and (3) at
    // least top10_min_games Rank Queue games *this season*.
    //
    // Note the ordering: qualification is a filter applied *before* .slice(prismTopN), not after it.
    // An earlier revision took the top N Sapphire players by MMR and only then dropped the ones
    // short on games, which left those slots empty — the community could see 2 Prism holders when
    // prism_top_n was 5. Filtering first means the N slots fill from the qualified pool whenever
    // enough players qualify, and a qualified lower-MMR player is never held out by an unqualified
    // higher-MMR one. Fewer than N holders now only happens when fewer than N players qualify at all.
    //
    // Same tiebreak philosophy as the band percentile sort above: higher MMR first, ties broken by
    // more (season) games played, then player id as a final deterministic tiebreak.
    const prismQualified = pool
      .filter(
        (p) => p.is_placed && p.band === "Sapphire" && (seasonGamesById.get(p.id) ?? 0) >= top10MinGames,
      )
      .slice()
      .sort(
        (a, b) =>
          b.mmr - a.mmr ||
          (seasonGamesById.get(b.id) ?? 0) - (seasonGamesById.get(a.id) ?? 0) ||
          a.id.localeCompare(b.id),
      );
    newPrismIds = new Set(prismQualified.slice(0, prismTopN).map((p) => p.id));
  }

  for (const player of pool) {
    const willBePrism = newPrismIds.has(player.id);
    if (player.is_prism === willBePrism) continue;
    handledIds.add(player.id);

    await supabase.from("crl6mansqueuebot_players").update({ is_prism: willBePrism }).eq("id", player.id);
    player.is_prism = willBePrism;

    if (guildId) {
      const desiredRoleId = desiredRoleIdFor({ band: player.band, is_prism: willBePrism }, roleIdByBand);
      const result = await reconcileMemberRole(guildId, player.discord_id, desiredRoleId, roleIdByBand);
      const pending = result === "failed";
      await supabase.from("crl6mansqueuebot_players").update({ role_sync_pending: pending }).eq("id", player.id);
      player.role_sync_pending = pending;
    }

    if (willBePrism) summary.prismGranted += 1;
    else summary.prismRevoked += 1;
  }

  // Role reconcile pass — see syncPlayerRoles. Two jobs in one: it retries anyone still flagged
  // role_sync_pending from a PRIOR run whose band/is_prism did not change again this run (so
  // neither loop above touched them), and, when the caller asked for a full sweep, it checks
  // every non-test player against their live Discord roles.
  //
  // It runs over allPlayers, not pool. That is the fix for the live stale-role bug: an unplaced
  // player is in nobody's pool, so the pool-scoped version of this pass could never clear a
  // pending flag for one, and never noticed a reset player still wearing last season's band role.
  if (guildId) {
    await syncPlayerRoles(supabase, guildId, roleIdByBand, allPlayers, handledIds, options?.syncAllRoles === true);
  }

  summary.roleSyncPending = allPlayers.filter((p) => p.role_sync_pending).length;

  return summary;
}

// ---------------------------------------------------------------------------
// Grants the informational "Unranked" role the instant a player first ever queues (called from
// queue.ts's getOrCreatePlayer, only on the player row's initial insert — not on every /q). This
// runs well before placement_games_required is met; recomputeBands() above removes this same role
// and swaps in the player's real band the moment they actually place, so "Unranked" behaves as a
// genuine transitional state (queued-but-unbanded) rather than a permanent badge. Best-effort and
// silent no-op if the "Unranked" key isn't mapped to a role yet (/setbandrole) or the guild id
// can't be resolved — a missing role sync here shouldn't block a player from joining a queue.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// /newseason's "everyone starts over" reset (see CLAUDE.md, "Seasons") — called from
// seasonClose.ts's closeSeason(), AFTER the MMR soft-reset decay has already run. The decay
// pass (applyMmrDecay) no longer filters its pool on `is_placed` — it decays every non-test
// player — so this ordering is no longer required by the decay itself, but it stays because the
// standings/is_prism/band_at_close snapshots earlier in closeSeason() all read pre-reset values.
//
// Every currently-placed, non-test player is sent back through placement from scratch, per two
// explicit user decisions (see CLAUDE.md):
// Applied to every non-test player, placed or not — an unplaced player's in-progress placement
// run is season-scoped in every way that matters, so it resets with everything else (see the
// comment on the widened update in the body). Only the Discord role swap and the returned count
// stay scoped to players who were actually placed.
//
//   - rank_games_played resets to 0. This is the same lifetime counter that also gates
//     provisional/elevated K-factor eligibility (provisional_games), so resetting it to force
//     re-placement also re-elevates provisional K for a player's first placement_games_required
//     games of the new season — a deliberate, confirmed tradeoff rather than adding a second,
//     season-scoped placement counter.
//   - band_games_played and last_rank_game_at also reset (to 0 / null). Neither gates any band
//     logic any more (they fed the removed demotion grace check); they're kept as plain stats.
// band/is_placed are cleared. peak_mmr and total_games_played are deliberately left untouched:
// peak_mmr is a lifetime high-water mark that's never lowered by anything else either (including
// season decay itself), and total_games_played is a lifetime counter with no placement meaning.
//
// Discord role sync swaps each affected player's current band role for Unranked, the mirror
// image of the swap recomputeBands() already does the moment a player first places.
//
// **Prism holders, fixed this session**: `is_prism` is also cleared and the *Prism* role (not the
// band role) is what actually gets removed for a currently-Prism player — a bug caught via a live
// report of players keeping their Prism status/role indefinitely after a season reset. The old
// code only ever removed `roleIdByBand.get(p.band)` (the player's underlying band column, almost
// always still "Sapphire" for a Prism holder, since Prism never touches that column — it only
// overlays a role swap on top of it). For a Prism player that's a no-op: their *actual* Discord
// role is Prism, not Sapphire, so nothing was ever actually removed, and `is_prism` stayed `true`
// in the DB. Worse, this was self-perpetuating: the same reset also zeroes `rank_games_played` and
// flips `is_placed` to `false`, which drops that player out of `recomputeBands()`'s pool entirely
// (`pool` only includes already-`is_placed` players or newly-crossing-`placement_games_required`
// ones — a reset player satisfies neither) — so the very next `recomputeBands()` call `/newseason`
// already makes right after opening the new season, previously assumed (per a since-corrected
// comment in `seasonClose.ts`) to "clear out anyone who no longer qualifies," could never actually
// reconsider them. The stale Prism role/flag would only ever get cleaned up if that specific player
// happened to re-place in the new season without re-qualifying for Prism. Fixed by handling Prism
// directly in this same pass instead of relying on a later recompute that structurally can't see
// these players anymore.
// ---------------------------------------------------------------------------

export async function resetAllPlacementsToUnranked(): Promise<number> {
  const supabase = createAdminClient();

  // Previously-placed players only. This list exists for the Discord role swap further down (an
  // already-Unranked player has no band/Prism role to trade in) and for the returned count, which
  // is what /newseason reports as "N player(s) reset to Unranked". The column reset itself is
  // deliberately wider — see the update immediately below.
  const { data: placed } = await supabase
    .from("crl6mansqueuebot_players")
    .select("id, discord_id, band, is_prism, role_sync_pending")
    .eq("is_placed", true)
    .eq("is_test_data", false);
  const players = placed ?? [];

  // The whole non-test roster, not just the placed subset. An unplaced player is carrying a
  // partial placement run (rank_games_played somewhere in 1..placement_games_required-1) earned
  // entirely inside the season being closed, against MMR that applyMmrDecay has just compressed.
  // Leaving that intact let them finish placing in the new season off one or two games while
  // every player reset above them had to re-earn the full requirement — the same cross-boundary
  // inconsistency that made seasonClose.ts widen its decay pool past is_placed, in the same
  // place, for the same reason. Zeroing everyone keeps placement meaning one thing for the whole
  // roster. For an already-unplaced player the placement columns here are already false/null, so
  // this only clears their counters; for a player who has never queued it is a no-op outright.
  const { error: resetError } = await supabase
    .from("crl6mansqueuebot_players")
    .update({
      is_placed: false,
      band: null,
      is_prism: false,
      rank_games_played: 0,
      band_games_played: 0,
      last_rank_game_at: null,
    })
    .eq("is_test_data", false);
  // Checked for the same reason the season_history upsert is (seasonClose.ts): supabase-js
  // resolves rather than throws on a rejected write, so an unchecked call here fails silently and
  // leaves the season half-closed — MMR decayed by applyMmrDecay, placements never cleared — while
  // the count returned below still reports a reset that did not happen. This is the last
  // destructive step of closeSeason(), so throwing costs nothing already done and surfaces the
  // failure instead of burying it.
  if (resetError) throw new Error(`Failed to reset placements: ${resetError.message}`);

  // After the reset, not before: the counter reset above has to run even in a season where
  // nobody ever placed.
  if (players.length === 0) return 0;

  const { data: bandRoleRows } = await supabase.from("crl6mansqueuebot_band_roles").select("*");
  const roleIdByBand = new Map((bandRoleRows ?? []).map((r) => [r.band, r.role_id]));

  if (roleIdByBand.size > 0) {
    let guildId: string | null = null;
    try {
      guildId = await getGuildId();
    } catch (err) {
      console.error("Season placement reset: failed to resolve guild id, skipping role sync", err);
    }

    if (guildId) {
      // Handed to the same reconcile pass recomputeBands() uses, with each player presented in
      // their POST-reset state (band null, is_prism false) — desiredRoleIdFor then resolves them
      // all to Unranked, and reconcileMemberRole strips whichever tracked role they are actually
      // wearing, Prism included. The rows were selected before the update above, so this mapping
      // is what makes them describe the state we just committed rather than the one we replaced.
      //
      // This replaces a blind removeMemberRole/addMemberRole pair fired for the whole roster
      // through one unbounded Promise.all, whose failures were swallowed with nothing but a
      // console.error. A rate limit or a function timeout part-way through therefore left an
      // arbitrary subset of players still wearing last season's role, with no record that
      // anything had failed — and since the reset has just flipped everyone to is_placed=false,
      // the pool-scoped recompute that ran moments later could never revisit them. That is the
      // live bug this whole path was rewritten for. Now every miss is recorded as
      // role_sync_pending, so the recompute /newseason runs right after retries it within
      // minutes instead of the role sticking until someone notices.
      await syncPlayerRoles(
        supabase,
        guildId,
        roleIdByBand,
        players.map((p) => ({ ...p, band: null, is_prism: false })),
        new Set<string>(),
        true,
      );
    }
  }

  return players.length;
}

export async function grantUnrankedRoleToNewPlayer(discordId: string): Promise<void> {
  const supabase = createAdminClient();
  const { data: roleRow } = await supabase
    .from("crl6mansqueuebot_band_roles")
    .select("role_id")
    .eq("band", "Unranked")
    .maybeSingle();
  if (!roleRow) return;

  try {
    const guildId = await getGuildId();
    await addMemberRole(guildId, discordId, roleRow.role_id);
  } catch (err) {
    console.error(`Failed to grant Unranked role to new player ${discordId}`, err);
  }
}

// ---------------------------------------------------------------------------
// /setbandrole band:<Iron|Garnet|Emerald|Sapphire|Unranked|Prism> role:<@role> — admin-gated, maps
// a band (or the 'Unranked' informational role for newly queued/not-yet-placed players, or the
// live top-N 'Prism' tier, config prism_top_n) to a Discord role. recomputeBands() above syncs
// all six keys: Iron/Garnet/Emerald/Sapphire/Unranked from the percentile loop, Prism from its
// own live top-N pass right after. Mirrors /setqueuechannel's channel-mapping pattern.
// ---------------------------------------------------------------------------

export function handleSetBandRoleCommand(interaction: DiscordInteraction) {
  const bandOption = interaction.data?.options?.find((o) => o.name === "band")?.value;
  const roleOption = interaction.data?.options?.find((o) => o.name === "role")?.value;
  after(() => processSetBandRole(interaction, bandOption, roleOption));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processSetBandRole(
  interaction: DiscordInteraction,
  bandRaw: string | number | boolean | undefined,
  roleRaw: string | number | boolean | undefined,
) {
  if (!(await hasAdminAccess(interaction))) {
    await editOriginalResponse(interaction.token, { content: "You don't have admin access." });
    return;
  }
  if (typeof bandRaw !== "string" || !VALID_BAND_ROLE_KEYS.includes(bandRaw as BandRoleKey) || typeof roleRaw !== "string") {
    await editOriginalResponse(interaction.token, { content: "Invalid band or role." });
    return;
  }
  const supabase = createAdminClient();
  const { data: existing } = await supabase
    .from("crl6mansqueuebot_band_roles")
    .select("role_id")
    .eq("band", bandRaw as BandRoleKey)
    .maybeSingle();
  await supabase.from("crl6mansqueuebot_band_roles").upsert({ band: bandRaw as BandRoleKey, role_id: roleRaw });

  const actorId = interactionUserId(interaction);
  if (actorId) {
    await logAdminAction(actorId, "set_band_role", bandRaw, undefined, [
      { field: `${bandRaw} role`, before: existing?.role_id ? `<@&${existing.role_id}>` : null, after: `<@&${roleRaw}>` },
    ]);
  }
  await editOriginalResponse(interaction.token, { content: `${bandRaw} is now mapped to <@&${roleRaw}>.` });
}

// ---------------------------------------------------------------------------
// /ranks — public, no args, no admin gate, works from anywhere (not channel-inferred). Posts one
// line per band showing how many players currently hold it, its emoji, its name, and its live
// cutoff MMR — a Discord-native version of the Info page's Bands section. Unlike that page's
// per-band "floor of current holders" display, this shows the actual computed cutoff MMR
// (computeBandThresholdMmr) since the user
// asked specifically for "cutoffs," matching this codebase's own terminology
// (band_cutoff_garnet_pctile etc.). Iron has no configured cutoff percentile (it's the bottom of
// the ladder), so its line uses computeBandThresholdMmr(pool, 0, mode) — this resolves to the
// pool's lowest MMR, a sensible floor value that keeps the format uniform across all four bands.
// Prism gets a fifth line for the same reason the Info page includes it: it's a live top-N cut
// among Sapphire players, and "the cutoffs for each rank" naturally includes it even though it
// isn't one of the four BAND_ORDER percentile bands.
// ---------------------------------------------------------------------------

export function handleRanksCommand(interaction: DiscordInteraction) {
  after(() => processRanksCommand(interaction));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
}

async function processRanksCommand(interaction: DiscordInteraction) {
  const supabase = createAdminClient();

  const [garnetCutoff, emeraldCutoff, sapphireCutoff, mmrScale, mmrShift, bandCalcModeRaw, fixedRanks] = await Promise.all([
    getConfigNumber("band_cutoff_garnet_pctile", 40),
    getConfigNumber("band_cutoff_emerald_pctile", 70),
    getConfigNumber("band_cutoff_sapphire_pctile", 90),
    getConfigNumber("mmr_scale", 1),
    getConfigNumber("mmr_shift", 0),
    getConfigValue("band_calc_mode"),
    getFixedRankConfig(),
  ]);
  const bandCalcMode: BandCalcMode = bandCalcModeRaw === "mmr" ? "mmr" : "position";

  const { data: players } = await supabase
    .from("crl6mansqueuebot_players")
    .select("id, mmr, band, total_games_played, is_prism")
    .eq("is_placed", true)
    .eq("is_test_data", false);
  const pool = players ?? [];

  if (pool.length === 0) {
    await editOriginalResponse(interaction.token, { content: "No players are currently placed yet." });
    return;
  }

  const display = (mmr: number) => Math.round(mmr * mmrScale + mmrShift);

  // Fixed ranks: the cutoffs are the configured thresholds themselves (already display MMR), not
  // anything derived from the pool.
  if (fixedRanks) {
    const prismCount = pool.filter((p) => p.is_prism).length;
    const fixedLabel: Record<Band, string> = {
      Iron: `Under ${fixedRanks.garnet} MMR`,
      Garnet: `${fixedRanks.garnet}+ MMR`,
      Emerald: `${fixedRanks.emerald}+ MMR`,
      Sapphire: `${fixedRanks.sapphire}+ MMR`,
    };
    const lines: string[] = [];
    for (const band of BAND_ORDER) {
      const count = pool.filter((p) => p.band === band).length - (band === "Sapphire" ? prismCount : 0);
      const emoji = await getRankEmoji(band);
      lines.push(`${count} ${emoji} **${getRankLabel(band)}** — ${fixedLabel[band]}`);
    }
    const prismEmoji = await getRankEmoji("Prism");
    lines.push(`${prismCount} ${prismEmoji} **Prism** — ${fixedRanks.prism}+ MMR`);
    await editOriginalResponse(interaction.token, {
      embeds: [
        {
          color: BRAND_COLOR,
          title: "Rank Cutoffs",
          description: lines.join("\n"),
          footer: { text: "Fixed MMR thresholds — reach the number, hold the rank." },
        },
      ],
    });
    return;
  }

  const thresholdMmrByBand: Record<Band, number> = {
    Iron: computeBandThresholdMmr(pool, 0, bandCalcMode),
    Garnet: computeBandThresholdMmr(pool, garnetCutoff, bandCalcMode),
    Emerald: computeBandThresholdMmr(pool, emeraldCutoff, bandCalcMode),
    Sapphire: computeBandThresholdMmr(pool, sapphireCutoff, bandCalcMode),
  };

  // Computed up front (not after the loop, where this used to live) so the Sapphire line below
  // can subtract it — a Prism holder's underlying `band` column stays "Sapphire" (Prism is a
  // live overlay on top of it, not a separate band value — see CLAUDE.md, "Bands / ranks"), so
  // without this a Prism player was counted on *both* the Sapphire line and the Prism line.
  const prismCount = pool.filter((p) => p.is_prism).length;

  const lines: string[] = [];
  for (const band of BAND_ORDER) {
    const count = pool.filter((p) => p.band === band).length - (band === "Sapphire" ? prismCount : 0);
    const emoji = await getRankEmoji(band);
    lines.push(`${count} ${emoji} **${getRankLabel(band)}** — ${display(thresholdMmrByBand[band])} MMR`);
  }

  // Revised a later session — supersedes a rank-based "top-N-among-Sapphire-by-MMR" cut, which
  // could report a healthier-looking cutoff than reality: that ranking ignored the
  // top10_min_games eligibility filter recomputeBands()'s live Prism pass actually applies, so a
  // higher-MMR Sapphire player who simply hadn't played enough games yet could occupy a
  // theoretical "top N" slot the real Prism roster didn't reflect. The cutoff now comes straight
  // from who currently, actually holds is_prism — the worst (lowest-MMR) current Prism player's
  // MMR — which can only ever match reality, no eligibility bookkeeping duplicated here.
  const prismMmrs = pool.filter((p) => p.is_prism).map((p) => p.mmr);
  const prismCutoffMmr = prismMmrs.length > 0 ? Math.min(...prismMmrs) : undefined;
  const prismEmoji = await getRankEmoji("Prism");
  lines.push(
    `${prismCount} ${prismEmoji} **Prism** — ${prismCutoffMmr === undefined ? "N/A" : `${display(prismCutoffMmr)} MMR`}`,
  );

  await editOriginalResponse(interaction.token, {
    embeds: [
      {
        color: BRAND_COLOR,
        title: "Rank Cutoffs",
        description: lines.join("\n"),
        footer: { text: "Live standings — cutoffs shift as players climb, drop, and place." },
      },
    ],
  });
}
