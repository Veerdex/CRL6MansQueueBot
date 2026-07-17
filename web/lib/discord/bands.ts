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
  player: { band: Band | null; band_games_played: number; is_placed: boolean },
  pctile: number,
  isNewlyPlaced: boolean,
  config: BandCutoffConfig,
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

  if (targetIndex < currentIndex && player.band_games_played >= config.graceGames) {
    // Grace checked first (the caller's `>=` above), then hysteresis: only demote if more than
    // hysteresisPct percentile points below the promotion-in threshold for their *current*
    // band, not just below the raw target-band cutoff.
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

  return null;
}

// ---------------------------------------------------------------------------
// Daily band recompute — see CLAUDE.md, "Bands / ranks". Percentile-ranks every currently-
// placed player (plus anyone crossing the placement threshold this run) by MMR, assigns bands
// off admin-configured cumulative cutoffs, applies the grace-period + hysteresis demotion
// safeguards, and syncs Discord roles + DMs for anyone whose band actually changed. Called by
// the pg_cron-triggered /api/discord/recompute-bands route — see CLAUDE.md, "Discord bot
// runtime architecture".
// ---------------------------------------------------------------------------

export async function recomputeBands(): Promise<RecomputeSummary> {
  const supabase = createAdminClient();

  const [placementGamesRequired, graceGames, hysteresisPct, garnetCutoff, emeraldCutoff, sapphireCutoff] = await Promise.all([
    getConfigNumber("placement_games_required", 10),
    getConfigNumber("grace_games", 3),
    getConfigNumber("hysteresis_pct", 5),
    getConfigNumber("band_cutoff_garnet_pctile", 40),
    getConfigNumber("band_cutoff_emerald_pctile", 70),
    getConfigNumber("band_cutoff_sapphire_pctile", 90),
  ]);
  const cutoffConfig: BandCutoffConfig = { graceGames, hysteresisPct, garnetCutoff, emeraldCutoff, sapphireCutoff };

  const summary: RecomputeSummary = { placed: 0, promoted: 0, demoted: 0, unchanged: 0 };

  // Test-data players (dev panel) are synthetic and carry fake discord_ids that aren't real
  // guild members — role grant/revoke would just 404, and mixing them into the percentile pool
  // would distort real cutoffs. Exclude them entirely, same treatment as any other bot-side
  // Discord operation.
  const { data: players } = await supabase.from("crl6mansqueuebot_players").select("*").eq("is_test_data", false);
  const allPlayers = players ?? [];

  const alreadyPlaced = allPlayers.filter((p) => p.is_placed);
  const newlyPlaced = allPlayers.filter((p) => !p.is_placed && p.total_games_played >= placementGamesRequired);
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
    const change = computeBandChange(player, pctile, newlyPlacedIds.has(player.id), cutoffConfig);

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
        const newRoleId = roleIdByBand.get(targetBand);
        if (newRoleId) await addMemberRole(guildId, player.discord_id, newRoleId);
        if (action === "placed") {
          const unrankedRoleId = roleIdByBand.get("Unranked");
          if (unrankedRoleId) await addMemberRole(guildId, player.discord_id, unrankedRoleId);
        }
      } catch (err) {
        console.error(`Band recompute: failed to sync Discord role for ${player.discord_id}`, err);
      }
    }


    summary[action] += 1;
  }

  return summary;
}

// ---------------------------------------------------------------------------
// /setbandrole band:<Iron|Garnet|Emerald|Sapphire|Unranked|Prism> role:<@role> — admin-gated, maps
// a band (or the 'Unranked' informational role for newly placed players, or the season-end-only
// 'Prism' Top 10 tier) to a Discord role. recomputeBands() below only ever grants/revokes
// Iron/Garnet/Emerald/Sapphire/Unranked — it never touches 'Prism', which is exclusively synced
// by season close (see seasonClose.ts). Mirrors /setqueuechannel's channel-mapping pattern.
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
