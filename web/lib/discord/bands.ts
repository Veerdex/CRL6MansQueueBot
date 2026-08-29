import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendDirectMessage, editOriginalResponse, getGuildId, getMemberRoles, addMemberRole, removeMemberRole, getRankEmoji, BRAND_COLOR } from "./rest";
import { getConfigNumber, getConfigValue } from "./config";
import { hasAdminAccess, logAdminAction } from "./admin";
import { interactionUserId, type DiscordInteraction } from "./types";
import type { Band, BandRoleKey } from "@/lib/supabase/types";
import { getRankLabel } from "@/lib/leaderboard/rankIcon";

const BAND_ORDER: Band[] = ["Iron", "Garnet", "Emerald", "Sapphire"];
const VALID_BAND_ROLE_KEYS: BandRoleKey[] = ["Iron", "Garnet", "Emerald", "Sapphire", "Unranked", "Prism"];

type RecomputeSummary = {
  placed: number;
  promoted: number;
  demoted: number;
  unchanged: number;
  // Count of players left with role_sync_pending=true after this run — see
  // reconcileMemberRole and migration 0046_role_sync_pending.sql. Non-zero means at least one
  // Discord role add/remove failed (rate limit or otherwise) and will retry on the next
  // recompute; surfaced so /admin recompute-bands can flag it instead of it going unnoticed.
  roleSyncPending: number;
};
type ChangeAction = "placed" | "promoted" | "demoted";

// See migration 0046_role_sync_pending.sql. Reconciles a player's actual live Discord roles
// against the single band/Unranked role they should hold, instead of trusting our own `band`
// column to infer which role they currently wear and issuing a blind remove-old/add-new pair. Any
// transient Discord failure (rate limit, etc.) partway through a remove/add pair would otherwise
// leave Discord holding some stale combination of roles with no way to detect or retry it, since
// the DB's band value had already committed to the new "target" state. Fetching live roles and
// diffing against the caller-supplied tracked role-ID set fixes this and is naturally idempotent —
// safe to re-run on a fresh retry pass no matter what partial state a prior failed attempt left
// behind. Returns false (never throws) so callers can set role_sync_pending for a later retry
// instead of wrongly assuming success.
//
// `trackedRoleIds` is explicitly passed in (rather than derived here) and must NEVER include the
// Prism role id — Prism is granted/revoked independently at season close (see seasonClose.ts) and
// held *alongside* a player's band role, not swapped with it. If this function treated Prism as a
// tracked role, an ordinary promotion/demotion would strip a player's earned Prism role as a
// stray untracked role the moment their band next changed.
async function reconcileMemberRole(
  guildId: string,
  discordId: string,
  desiredRoleId: string | undefined,
  trackedRoleIds: Set<string>,
): Promise<boolean> {
  try {
    const currentRoleIds = await getMemberRoles(guildId, discordId);
    const toRemove = currentRoleIds.filter((r) => trackedRoleIds.has(r) && r !== desiredRoleId);
    await Promise.all(toRemove.map((roleId) => removeMemberRole(guildId, discordId, roleId)));
    if (desiredRoleId && !currentRoleIds.includes(desiredRoleId)) {
      await addMemberRole(guildId, discordId, desiredRoleId);
    }
    return true;
  } catch (err) {
    console.error(`Band recompute: failed to reconcile Discord role for ${discordId}`, err);
    return false;
  }
}

export type BandCutoffConfig = {
  graceGames: number;
  // Fixed MMR-point buffer for the demotion hysteresis check — replaces the old percentile-based
  // hysteresisPct. See computeBandThresholdMmr and the hysteresis check inside computeBandChange
  // below for how this is applied.
  hysteresisMmr: number;
  garnetCutoff: number;
  emeraldCutoff: number;
  sapphireCutoff: number;
  // Days since a player's last Rank Queue game after which grace is treated as expired even if
  // band_games_played hasn't reached graceGames yet — see computeBandChange's inactivity check
  // below. <= 0 disables the check entirely (grace then only expires by games played, as before).
  graceInactivityDays: number;
};

// Pure decision logic — no Discord, no DB — extracted from the recompute loop below so the
// promotion/grace/hysteresis rules (see CLAUDE.md, "Bands / ranks") can be unit tested directly.
export function targetBandForPercentile(pctile: number, config: BandCutoffConfig): Band {
  if (pctile >= config.sapphireCutoff) return "Sapphire";
  if (pctile >= config.emeraldCutoff) return "Emerald";
  if (pctile >= config.garnetCutoff) return "Garnet";
  return "Iron";
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

// Converts a cutoff percentile into a concrete threshold MMR value, for the fixed-MMR-buffer
// demotion hysteresis check in computeBandChange below (see CLAUDE.md, "Bands / ranks" — this
// replaced the earlier percentile-based hysteresisPct buffer). Mirrors computeBandPercentiles's
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

export function computeBandChange(
  player: { band: Band | null; band_games_played: number; is_placed: boolean; last_rank_game_at?: string | null; mmr: number },
  pctile: number,
  isNewlyPlaced: boolean,
  config: BandCutoffConfig,
  // Threshold MMR per band (Garnet/Emerald/Sapphire), from computeBandThresholdMmr — the value the
  // fixed hysteresisMmr buffer below is subtracted from.
  thresholdMmrByBand: Partial<Record<Band, number>>,
  // True if some other player in the pool has strictly higher MMR than this player while
  // currently holding a strictly lower band (a stale-band ordering violation — see CLAUDE.md,
  // "Bands / ranks", the "surpassed" bypass). Grace/hysteresis exist to absorb noise in a
  // player's *own* MMR (e.g. one bad loss right after a promotion), not to indefinitely protect
  // a static player while other players' independent improvement climbs past them — once someone
  // with less band-rank than this player outranks them on raw MMR, that's a real, already-visible
  // ordering bug (Iron showing a higher MMR floor than Garnet), so it bypasses grace/hysteresis
  // the same way an admin `force:true` would, rather than waiting on this player's own next
  // Rank Queue game or inactivity timer.
  hasBeenSurpassed: boolean,
  // `force`: bypasses grace + hysteresis entirely, demoting straight to whatever the true
  // current percentile says. Used only by the admin one-time reseat (see /admin recompute-bands
  // force:true) to correct players whose band got locked in against a tiny early-placement pool
  // and would otherwise never accumulate enough band_games_played to pass grace on their own —
  // not used by the normal daily/live recompute path.
  // `now`: injectable for tests; defaults to the real current time.
  options?: { force?: boolean; now?: Date },
): { action: ChangeAction; targetBand: Band } | null {
  const targetBand = targetBandForPercentile(pctile, config);

  if (isNewlyPlaced) {
    return { action: "placed", targetBand };
  }

  const currentBand = player.band as Band;
  const currentIndex = BAND_ORDER.indexOf(currentBand);
  const targetIndex = BAND_ORDER.indexOf(targetBand);

  if (targetIndex > currentIndex) {
    return { action: "promoted", targetBand };
  }

  if (targetIndex < currentIndex && (options?.force || hasBeenSurpassed)) {
    return { action: "demoted", targetBand };
  }

  if (targetIndex < currentIndex) {
    const gracePassedByGames = player.band_games_played >= config.graceGames;
    // A player who reaches a band and then stops playing entirely never accumulates more
    // band_games_played, so games-based grace alone would protect them forever regardless of
    // how far the pool moves under them. Treat grace as expired once they've gone
    // graceInactivityDays without a Rank Queue game, even if band_games_played is still under
    // graceGames — this only unlocks the hysteresis check below, it doesn't force a demotion by
    // itself, and it never fires for an actively-playing player (each game refreshes
    // last_rank_game_at in report.ts).
    const gracePassedByInactivity =
      config.graceInactivityDays > 0 &&
      player.last_rank_game_at != null &&
      (options?.now ?? new Date()).getTime() - new Date(player.last_rank_game_at).getTime() >=
        config.graceInactivityDays * 24 * 60 * 60 * 1000;

    if (gracePassedByGames || gracePassedByInactivity) {
      // Grace checked first (above), then hysteresis: only demote if the player's raw MMR has
      // fallen more than hysteresisMmr points below the promotion-in threshold MMR for their
      // *current* band, not just below the raw target-band cutoff. Fixed MMR points, not a
      // percentile — deliberately doesn't scale with mmr_scale (display-only, see config.ts's
      // getDisplayMMR) so this always means the same real MMR gap regardless of display settings.
      const thresholdMmr = thresholdMmrByBand[currentBand];
      if (thresholdMmr !== undefined && player.mmr < thresholdMmr - config.hysteresisMmr) {
        return { action: "demoted", targetBand };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Band recompute — see CLAUDE.md, "Bands / ranks". Percentile-ranks every currently-placed
// player (plus anyone crossing the placement threshold this run) by MMR, assigns bands off
// admin-configured cumulative cutoffs, applies the grace-period + hysteresis demotion
// safeguards, and syncs Discord roles + DMs for anyone whose band actually changed. Once the
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
// percentile), and if they don't personally rack up grace_games more Rank Queue games soon after,
// nothing ever re-evaluates them even as the true pool (and their true percentile) shifts under
// them. Re-evaluating everyone on every recompute means a player can now be corrected by *anyone
// else's* game changing the distribution, not just their own — grace/hysteresis still gate
// whether a correction is actually a demotion, per-player, exactly as before.
// ---------------------------------------------------------------------------

export async function recomputeBands(options?: { force?: boolean }): Promise<RecomputeSummary> {
  const supabase = createAdminClient();

  const [
    placementGamesRequired,
    graceGames,
    hysteresisMmr,
    garnetCutoff,
    emeraldCutoff,
    sapphireCutoff,
    graceInactivityDays,
    bandCalcModeRaw,
  ] = await Promise.all([
    getConfigNumber("placement_games_required", 10),
    getConfigNumber("grace_games", 3),
    getConfigNumber("hysteresis_mmr", 7),
    getConfigNumber("band_cutoff_garnet_pctile", 40),
    getConfigNumber("band_cutoff_emerald_pctile", 70),
    getConfigNumber("band_cutoff_sapphire_pctile", 90),
    getConfigNumber("grace_inactivity_days", 7),
    getConfigValue("band_calc_mode"),
  ]);
  const bandCalcMode: BandCalcMode = bandCalcModeRaw === "mmr" ? "mmr" : "position";
  const cutoffConfig: BandCutoffConfig = { graceGames, hysteresisMmr, garnetCutoff, emeraldCutoff, sapphireCutoff, graceInactivityDays };

  const summary: RecomputeSummary = { placed: 0, promoted: 0, demoted: 0, unchanged: 0, roleSyncPending: 0 };

  // Test-data players (dev panel) are synthetic and carry fake discord_ids that aren't real
  // guild members — role grant/revoke would just 404, and mixing them into the percentile pool
  // would distort real cutoffs. Exclude them entirely, same treatment as any other bot-side
  // Discord operation.
  const { data: players } = await supabase.from("crl6mansqueuebot_players").select("*").eq("is_test_data", false);
  const allPlayers = players ?? [];

  const alreadyPlaced = allPlayers.filter((p) => p.is_placed);
  // Gated on rank_games_played, not total_games_played — placement assigns a real band off the
  // player's MMR, and Universal Queue games never move MMR (see CLAUDE.md, "Queueing"), so only
  // Rank Queue games should count toward earning one. This doesn't reintroduce the old
  // chicken-and-egg bootstrap problem since Rank Queue is open to unplaced players from game one.
  const newlyPlaced = allPlayers.filter((p) => !p.is_placed && p.rank_games_played >= placementGamesRequired);
  const pool = [...alreadyPlaced, ...newlyPlaced];
  if (pool.length === 0) return summary;

  const percentileById = computeBandPercentiles(pool, bandCalcMode);
  // Computed once per run, off the pre-loop pool snapshot — see computeBandThresholdMmr, and the
  // fixed hysteresisMmr buffer check inside computeBandChange that consumes this.
  const thresholdMmrByBand: Partial<Record<Band, number>> = {
    Garnet: computeBandThresholdMmr(pool, garnetCutoff, bandCalcMode),
    Emerald: computeBandThresholdMmr(pool, emeraldCutoff, bandCalcMode),
    Sapphire: computeBandThresholdMmr(pool, sapphireCutoff, bandCalcMode),
  };
  const newlyPlacedIds = new Set(newlyPlaced.map((p) => p.id));

  // "Surpassed" detection — see computeBandChange's hasBeenSurpassed param. Computed once, off a
  // pre-loop snapshot of each player's currently-committed band (before this pass writes any new
  // ones), so the result doesn't depend on iteration order or a player's own band getting updated
  // mid-loop. A player counts as surpassed if some other already-placed player in the pool has
  // strictly higher MMR while currently holding a strictly lower band — that combination is only
  // possible when a band assignment has gone stale (grace/hysteresis blocked a demotion for too
  // long while the pool moved), and is exactly the "the other players just surpassed him" case a
  // live production example (Iron's MMR floor sitting above Garnet's) surfaced.
  const bandIndexById = new Map(pool.map((p) => [p.id, p.band ? BAND_ORDER.indexOf(p.band as Band) : -1]));
  const surpassedIds = new Set<string>();
  for (const p of pool) {
    const pIndex = bandIndexById.get(p.id)!;
    if (pIndex < 0) continue; // not yet placed — no current band to be surpassed out of
    const surpassed = pool.some((q) => {
      if (q.id === p.id || q.mmr <= p.mmr) return false;
      const qIndex = bandIndexById.get(q.id)!;
      return qIndex >= 0 && qIndex < pIndex;
    });
    if (surpassed) surpassedIds.add(p.id);
  }

  const { data: bandRoleRows } = await supabase.from("crl6mansqueuebot_band_roles").select("*");
  const roleIdByBand = new Map((bandRoleRows ?? []).map((r) => [r.band, r.role_id]));
  // Never includes Prism — see reconcileMemberRole's doc comment. Prism is an independent,
  // additive role granted/revoked only at season close (seasonClose.ts), not something an
  // ordinary band promotion/demotion should ever strip.
  const trackedBandRoleIds = new Set(
    (["Iron", "Garnet", "Emerald", "Sapphire", "Unranked"] as const)
      .map((b) => roleIdByBand.get(b))
      .filter((id): id is string => !!id),
  );

  let guildId: string | null = null;
  if (roleIdByBand.size > 0) {
    try {
      guildId = await getGuildId();
    } catch (err) {
      console.error("Band recompute: failed to resolve guild id, skipping role sync this run", err);
    }
  }

  // Tracks every player whose band actually changed this run — the final retry pass skips them
  // since they already got a fresh reconcile attempt just now.
  const handledIds = new Set<string>();

  for (const player of pool) {
    const pctile = percentileById.get(player.id)!;
    const change = computeBandChange(
      player,
      pctile,
      newlyPlacedIds.has(player.id),
      cutoffConfig,
      thresholdMmrByBand,
      surpassedIds.has(player.id),
      { force: options?.force },
    );

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
      // Desired role here is always the plain band role — reconcileMemberRole (scoped to
      // trackedBandRoleIds, which excludes Prism) strips any other tracked role they hold (their
      // old band or Unranked) as part of the same call, so the old separate "remove Unranked on
      // placement" branch is subsumed by this too. A player's independently-held Prism role (see
      // seasonClose.ts) is left completely untouched by this.
      const desiredRoleId = roleIdByBand.get(targetBand);
      const roleSynced = await reconcileMemberRole(guildId, player.discord_id, desiredRoleId, trackedBandRoleIds);
      await supabase.from("crl6mansqueuebot_players").update({ role_sync_pending: !roleSynced }).eq("id", player.id);
      player.role_sync_pending = !roleSynced;
    }

    player.band = targetBand;
    player.is_placed = true;
    if (action === "placed") player.peak_mmr = placementPeakUpdate.peak_mmr!;

    summary[action] += 1;
  }

  if (guildId) {
    await reconcilePendingRoleSync(supabase, guildId, roleIdByBand, trackedBandRoleIds, handledIds);
  }

  const { count: pendingCount } = await supabase
    .from("crl6mansqueuebot_players")
    .select("id", { count: "exact", head: true })
    .eq("is_test_data", false)
    .eq("role_sync_pending", true);
  summary.roleSyncPending = pendingCount ?? 0;

  return summary;
}

// ---------------------------------------------------------------------------
// Retry pass for anyone left with role_sync_pending=true from a PRIOR run (a Discord sync that
// failed — rate limit or otherwise). Queries ALL non-test-data pending players, not just the
// placed `pool` passed through recomputeBands — a player who is currently Unranked (e.g. freshly
// reset by /newseason) can still be a Prism holder awaiting a retried role grant, and wouldn't
// appear in that pool at all. For each pending player this independently retries: (a) their band
// role, via the same reconcileMemberRole used by the main loop, only if they're currently placed;
// (b) their Prism role, via direct add/remove (Prism is additive, never routed through
// reconcileMemberRole's swap semantics). role_sync_pending only clears once every applicable
// check for that player succeeds.
// ---------------------------------------------------------------------------
async function reconcilePendingRoleSync(
  supabase: ReturnType<typeof createAdminClient>,
  guildId: string,
  roleIdByBand: Map<string, string>,
  trackedBandRoleIds: Set<string>,
  skipIds: Set<string>,
): Promise<void> {
  const { data: pendingPlayers } = await supabase
    .from("crl6mansqueuebot_players")
    .select("id, discord_id, band, is_placed, is_prism")
    .eq("is_test_data", false)
    .eq("role_sync_pending", true);

  for (const player of pendingPlayers ?? []) {
    if (skipIds.has(player.id)) continue;

    let ok = true;
    if (player.is_placed) {
      const desiredRoleId = player.band ? roleIdByBand.get(player.band as Band) : undefined;
      ok = (await reconcileMemberRole(guildId, player.discord_id, desiredRoleId, trackedBandRoleIds)) && ok;
    }

    const prismRoleId = roleIdByBand.get("Prism");
    if (prismRoleId) {
      try {
        const currentRoleIds = await getMemberRoles(guildId, player.discord_id);
        const hasPrismRole = currentRoleIds.includes(prismRoleId);
        if (player.is_prism && !hasPrismRole) {
          await addMemberRole(guildId, player.discord_id, prismRoleId);
        } else if (!player.is_prism && hasPrismRole) {
          await removeMemberRole(guildId, player.discord_id, prismRoleId);
        }
      } catch (err) {
        console.error(`Band recompute: failed to retry Prism role sync for ${player.discord_id}`, err);
        ok = false;
      }
    }

    if (ok) {
      await supabase.from("crl6mansqueuebot_players").update({ role_sync_pending: false }).eq("id", player.id);
    }
  }
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
// seasonClose.ts's closeSeason(), AFTER the MMR soft-reset decay has already run. That decay
// pass (applyMmrDecay) queries its pool with `is_placed = true`, so this reset must not flip
// is_placed until decay has already read/written against it, or the decay pool would come back
// empty.
//
// Every currently-placed, non-test player is sent back through placement from scratch, per two
// explicit user decisions (see CLAUDE.md):
//   - rank_games_played resets to 0. This is the same lifetime counter that also gates
//     provisional/elevated K-factor eligibility (provisional_games), so resetting it to force
//     re-placement also re-elevates provisional K for a player's first placement_games_required
//     games of the new season — a deliberate, confirmed tradeoff rather than adding a second,
//     season-scoped placement counter.
//   - band_games_played and last_rank_game_at also reset (to 0 / null) — both only ever gate the
//     demotion grace/hysteresis checks for an already-placed player, so a stale value from last
//     season (e.g. "hasn't played in 5 days") has no meaning once someone's back to Unranked.
// band/is_placed are cleared. peak_mmr and total_games_played are deliberately left untouched:
// peak_mmr is a lifetime high-water mark that's never lowered by anything else either (including
// season decay itself), and total_games_played is a lifetime counter with no placement meaning.
//
// Discord role sync swaps each affected player's current band role for Unranked, the mirror
// image of the swap recomputeBands() already does the moment a player first places.
//
// Prism is untouched by this reset entirely — it's now a season-end achievement granted/revoked
// only by seasonClose.ts's own Prism step, held for the whole following season regardless of how
// a player's band/placement moves in the meantime. See CLAUDE.md, "Bands / ranks".
// ---------------------------------------------------------------------------

export async function resetAllPlacementsToUnranked(): Promise<number> {
  const supabase = createAdminClient();

  const { data: placed } = await supabase
    .from("crl6mansqueuebot_players")
    .select("id, discord_id, band")
    .eq("is_placed", true)
    .eq("is_test_data", false);
  const players = placed ?? [];
  if (players.length === 0) return 0;

  await supabase
    .from("crl6mansqueuebot_players")
    .update({
      is_placed: false,
      band: null,
      rank_games_played: 0,
      band_games_played: 0,
      last_rank_game_at: null,
    })
    .in(
      "id",
      players.map((p) => p.id),
    );

  const { data: bandRoleRows } = await supabase.from("crl6mansqueuebot_band_roles").select("*");
  const roleIdByBand = new Map((bandRoleRows ?? []).map((r) => [r.band, r.role_id]));
  const unrankedRoleId = roleIdByBand.get("Unranked");

  if (roleIdByBand.size > 0) {
    let guildId: string | null = null;
    try {
      guildId = await getGuildId();
    } catch (err) {
      console.error("Season placement reset: failed to resolve guild id, skipping role sync", err);
    }

    if (guildId) {
      const resolvedGuildId = guildId;
      await Promise.all(
        players.map(async (p) => {
          try {
            const oldRoleId = p.band ? roleIdByBand.get(p.band as Band) : undefined;
            if (oldRoleId) await removeMemberRole(resolvedGuildId, p.discord_id, oldRoleId);
            if (unrankedRoleId) await addMemberRole(resolvedGuildId, p.discord_id, unrankedRoleId);
          } catch (err) {
            console.error(`Season placement reset: failed to sync Discord role for ${p.discord_id}`, err);
          }
        }),
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
// season-end 'Prism' achievement role, config prism_top_n) to a Discord role. recomputeBands()
// above syncs the five band/Unranked keys from the percentile loop; Prism is granted/revoked
// independently at season close (seasonClose.ts), held alongside a player's band role for the
// whole following season. Mirrors /setqueuechannel's channel-mapping pattern.
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
// (computeBandThresholdMmr, the same value the demotion hysteresis check consumes) since the user
// asked specifically for "cutoffs," matching this codebase's own terminology
// (band_cutoff_garnet_pctile etc.). Iron has no configured cutoff percentile (it's the bottom of
// the ladder), so its line uses computeBandThresholdMmr(pool, 0, mode) — this resolves to the
// pool's lowest MMR, a sensible floor value that keeps the format uniform across all four bands.
// Prism gets a fifth line too, but unlike the four bands it has no live "cutoff" to report — it's
// a season-end snapshot (see CLAUDE.md, "Bands / ranks") held alongside a player's real band, so
// this just reports how many players currently hold it.
// ---------------------------------------------------------------------------

export function handleRanksCommand(interaction: DiscordInteraction) {
  after(() => processRanksCommand(interaction));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
}

async function processRanksCommand(interaction: DiscordInteraction) {
  const supabase = createAdminClient();

  const [garnetCutoff, emeraldCutoff, sapphireCutoff, mmrScale, mmrShift, bandCalcModeRaw] = await Promise.all([
    getConfigNumber("band_cutoff_garnet_pctile", 40),
    getConfigNumber("band_cutoff_emerald_pctile", 70),
    getConfigNumber("band_cutoff_sapphire_pctile", 90),
    getConfigNumber("mmr_scale", 1),
    getConfigNumber("mmr_shift", 0),
    getConfigValue("band_calc_mode"),
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

  const thresholdMmrByBand: Record<Band, number> = {
    Iron: computeBandThresholdMmr(pool, 0, bandCalcMode),
    Garnet: computeBandThresholdMmr(pool, garnetCutoff, bandCalcMode),
    Emerald: computeBandThresholdMmr(pool, emeraldCutoff, bandCalcMode),
    Sapphire: computeBandThresholdMmr(pool, sapphireCutoff, bandCalcMode),
  };

  // Prism is now an independent, additive role (see CLAUDE.md, "Bands / ranks") — a Prism holder
  // is still counted on their real band's line here, no subtraction needed.
  const lines: string[] = [];
  for (const band of BAND_ORDER) {
    const count = pool.filter((p) => p.band === band).length;
    const emoji = await getRankEmoji(band);
    lines.push(`${count} ${emoji} **${getRankLabel(band)}** — ${display(thresholdMmrByBand[band])} MMR`);
  }

  const prismCount = pool.filter((p) => p.is_prism).length;
  const prismEmoji = await getRankEmoji("Prism");
  lines.push(`${prismCount} ${prismEmoji} **Prism** — held from last season's Top N until the next season close`);

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
