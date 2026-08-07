import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendDirectMessage, editOriginalResponse, getGuildId, addMemberRole, removeMemberRole } from "./rest";
import { getConfigNumber } from "./config";
import { hasAdminAccess } from "./admin";
import { type DiscordInteraction } from "./types";
import type { Band, BandRoleKey } from "@/lib/supabase/types";

const BAND_ORDER: Band[] = ["Iron", "Garnet", "Emerald", "Sapphire"];
const VALID_BAND_ROLE_KEYS: BandRoleKey[] = ["Iron", "Garnet", "Emerald", "Sapphire", "Unranked", "Prism"];

type RecomputeSummary = { placed: number; promoted: number; demoted: number; unchanged: number };
type ChangeAction = "placed" | "promoted" | "demoted";

export type BandCutoffConfig = {
  graceGames: number;
  hysteresisPct: number;
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

export function computeBandChange(
  player: { band: Band | null; band_games_played: number; is_placed: boolean; last_rank_game_at?: string | null },
  pctile: number,
  isNewlyPlaced: boolean,
  config: BandCutoffConfig,
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

  if (targetIndex < currentIndex && options?.force) {
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
      // Grace checked first (above), then hysteresis: only demote if more than hysteresisPct
      // percentile points below the promotion-in threshold for their *current* band, not just
      // below the raw target-band cutoff.
      const promotionThreshold: Partial<Record<Band, number>> = {
        Garnet: config.garnetCutoff,
        Emerald: config.emeraldCutoff,
        Sapphire: config.sapphireCutoff,
      };
      const threshold = promotionThreshold[currentBand];
      if (threshold !== undefined && pctile < threshold - config.hysteresisPct) {
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
// safeguards, and syncs Discord roles + DMs for anyone whose band actually changed.
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

  const [placementGamesRequired, graceGames, hysteresisPct, garnetCutoff, emeraldCutoff, sapphireCutoff, graceInactivityDays] =
    await Promise.all([
      getConfigNumber("placement_games_required", 10),
      getConfigNumber("grace_games", 3),
      getConfigNumber("hysteresis_pct", 5),
      getConfigNumber("band_cutoff_garnet_pctile", 40),
      getConfigNumber("band_cutoff_emerald_pctile", 70),
      getConfigNumber("band_cutoff_sapphire_pctile", 90),
      getConfigNumber("grace_inactivity_days", 7),
    ]);
  const cutoffConfig: BandCutoffConfig = { graceGames, hysteresisPct, garnetCutoff, emeraldCutoff, sapphireCutoff, graceInactivityDays };

  const summary: RecomputeSummary = { placed: 0, promoted: 0, demoted: 0, unchanged: 0 };

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

  // Tied MMR is broken by total_games_played (more games at the same rating = more established,
  // ranks slightly higher), then player id as a final deterministic tiebreak.
  const sorted = pool
    .slice()
    .sort((a, b) => a.mmr - b.mmr || a.total_games_played - b.total_games_played || a.id.localeCompare(b.id));
  const n = sorted.length;
  const percentileById = new Map(sorted.map((p, i) => [p.id, ((i + 1) / n) * 100]));
  const newlyPlacedIds = new Set(newlyPlaced.map((p) => p.id));

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

  for (const player of pool) {
    const pctile = percentileById.get(player.id)!;
    const change = computeBandChange(player, pctile, newlyPlacedIds.has(player.id), cutoffConfig, { force: options?.force });

    if (!change) {
      summary.unchanged += 1;
      continue;
    }

    const { action, targetBand } = change;

    const oldBand = action === "placed" ? null : (player.band as Band);

    await supabase
      .from("crl6mansqueuebot_players")
      .update({ band: targetBand, is_placed: true, band_games_played: 0 })
      .eq("id", player.id);

    if (guildId) {
      try {
        if (oldBand) {
          const oldRoleId = roleIdByBand.get(oldBand);
          if (oldRoleId) await removeMemberRole(guildId, player.discord_id, oldRoleId);
        }
        if (action === "placed") {
          // "Unranked" was granted the moment this player first ever queued (see
          // grantUnrankedRoleToNewPlayer below, called from queue.ts) — swap it out for their
          // real computed band now that they've actually placed, same as any other band change.
          const unrankedRoleId = roleIdByBand.get("Unranked");
          if (unrankedRoleId) await removeMemberRole(guildId, player.discord_id, unrankedRoleId);
        }
        const newRoleId = roleIdByBand.get(targetBand);
        if (newRoleId) await addMemberRole(guildId, player.discord_id, newRoleId);
      } catch (err) {
        console.error(`Band recompute: failed to sync Discord role for ${player.discord_id}`, err);
      }
    }


    summary[action] += 1;
  }

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
// season-end-only 'Prism' top-N tier, config prism_top_n) to a Discord role. recomputeBands() above only ever
// grants/revokes Iron/Garnet/Emerald/Sapphire/Unranked — it never touches 'Prism', which is
// exclusively synced by season close (see seasonClose.ts). Mirrors /setqueuechannel's
// channel-mapping pattern.
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
  await supabase.from("crl6mansqueuebot_band_roles").upsert({ band: bandRaw as BandRoleKey, role_id: roleRaw });
  await editOriginalResponse(interaction.token, { content: `${bandRaw} is now mapped to <@&${roleRaw}>.` });
}
