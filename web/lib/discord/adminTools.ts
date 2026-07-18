import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendDirectMessage, editOriginalResponse, deleteOriginalResponse, discordFetch, getGuildId } from "./rest";
import { getConfigNumber, KNOWN_CONFIG_DEFAULTS, setConfigValue } from "./config";
import { hasAdminAccess, logAdminAction } from "./admin";
import { recomputeBands } from "./bands";
import { refreshQueueMessage, getOrCreatePlayer, getLockedSeriesForPlayer } from "./queue";
import { claimSeriesVoid, closeMatchChannelsAfterDelay } from "./matchChannels";
import { interactionUserId, interactionDisplayName, type CommandOption, type DiscordInteraction } from "./types";
import type { SeriesRow, PlayerRow, Team } from "@/lib/supabase/types";

type AdminClient = ReturnType<typeof createAdminClient>;

function deferredEphemeral(run: () => Promise<void>) {
  after(run);
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

// Walks Discord's nested subcommand/subcommand-group option tree down to the leaf params —
// a node with `options` set (and no `value`) is a subcommand/subcommand-group hop, a node
// with `value` set is a leaf param. /admin config get|set is the only nested case this bot
// has (one subcommand group, two subcommands); everything else is a single-level subcommand.
function resolveAdminSubcommandPath(options: CommandOption[] | undefined): { path: string[]; params: CommandOption[] } {
  const path: string[] = [];
  let current = options;
  while (current && current.length > 0 && current[0].options !== undefined) {
    path.push(current[0].name);
    current = current[0].options;
  }
  return { path, params: current ?? [] };
}

function getParamValue(params: CommandOption[], name: string) {
  return params.find((p) => p.name === name)?.value;
}

// ---------------------------------------------------------------------------
// /admin — top-level dispatcher. The whole subtree is owner-or-admin-role gated once here;
// individual subcommands don't need their own per-call admin checks the way /report's `id:`
// override does, since /report itself is open to any of the 6 players but /admin isn't open
// to anyone at all. See CLAUDE.md, "Admin toolset" / "Admin commands".
// ---------------------------------------------------------------------------

export function handleAdminCommand(interaction: DiscordInteraction) {
  return deferredEphemeral(() => processAdminCommand(interaction));
}

async function processAdminCommand(interaction: DiscordInteraction) {
  const actorId = interactionUserId(interaction);
  if (!actorId) {
    await editOriginalResponse(interaction.token, { content: "Couldn't identify you — try again." });
    return;
  }
  if (!(await hasAdminAccess(interaction))) {
    await editOriginalResponse(interaction.token, { content: "You don't have admin access." });
    return;
  }

  const { path, params } = resolveAdminSubcommandPath(interaction.data?.options);

  switch (path[0]) {
    case "unreport": {
      const id = getParamValue(params, "id");
      if (typeof id !== "string" || !id) {
        await editOriginalResponse(interaction.token, { content: "Missing id." });
        return;
      }
      await processUnreport(interaction, actorId, id);
      return;
    }
    case "cancel-series": {
      const id = getParamValue(params, "id");
      await processCancelSeries(interaction, actorId, typeof id === "string" && id ? id : null);
      return;
    }
    case "cancel-matches": {
      await processCancelMatches(interaction, actorId);
      return;
    }
    case "adjust-mmr": {
      const target = getParamValue(params, "target");
      const delta = getParamValue(params, "delta");
      const mmr = getParamValue(params, "mmr");
      await processAdjustMmr(
        interaction,
        actorId,
        typeof target === "string" ? target : null,
        typeof delta === "number" ? delta : undefined,
        typeof mmr === "number" ? mmr : undefined,
      );
      return;
    }
    case "force-leave": {
      const target = getParamValue(params, "target");
      await processForceLeave(interaction, actorId, typeof target === "string" ? target : null);
      return;
    }
    case "recompute-bands":
      await processRecomputeBands(interaction, actorId);
      return;
    case "config": {
      if (path[1] === "get") {
        const key = getParamValue(params, "key");
        await processConfigGet(interaction, typeof key === "string" ? key : null);
        return;
      }
      if (path[1] === "set") {
        const key = getParamValue(params, "key");
        const value = getParamValue(params, "value");
        await processConfigSet(interaction, actorId, typeof key === "string" ? key : null, typeof value === "number" ? value : undefined);
        return;
      }
      await editOriginalResponse(interaction.token, { content: "Unrecognized config subcommand." });
      return;
    }
    case "audit-log": {
      const limit = getParamValue(params, "limit");
      await processAuditLog(interaction, typeof limit === "number" ? limit : undefined);
      return;
    }
    case "test-flow": {
      const mode = getParamValue(params, "mode");
      await processTestFlow(interaction, actorId, typeof mode === "string" ? mode : "balanced");
      return;
    }
    case "set-rank-emoji": {
      const band = getParamValue(params, "band");
      const imageAttachmentId = getParamValue(params, "image");
      await processSetRankEmoji(interaction, actorId, typeof band === "string" ? band : null, typeof imageAttachmentId === "string" ? imageAttachmentId : null);
      return;
    }
    case "reset": {
      const confirmation = getParamValue(params, "confirmation");
      await processReset(interaction, actorId, typeof confirmation === "string" ? confirmation : null);
      return;
    }
    case "full-reset": {
      const confirmation = getParamValue(params, "confirmation");
      await processFullReset(interaction, actorId, typeof confirmation === "string" ? confirmation : null);
      return;
    }
    case "stop": {
      await processStop(interaction, actorId);
      return;
    }
    case "start": {
      await processStart(interaction, actorId);
      return;
    }
    case "checklist": {
      await processChecklist(interaction);
      return;
    }
    default:
      await editOriginalResponse(interaction.token, { content: "Unrecognized admin subcommand." });
      return;
  }
}

// ---------------------------------------------------------------------------
// /admin unreport id:<series_id> — reverses a reported series back to 'void' (reusing the
// existing status rather than adding a new one; the audit log entry is what distinguishes an
// admin-corrected void from a genuine timeout/abandon void). Unwinds each affected player's
// mmr_delta (rank-queue series only) and the games-played counters /report incremented,
// mirroring report.ts's writes in reverse. Match channels are already long gone by the time a
// series is reported (deleted 30s after /report), so there's nothing to clean up there.
// ---------------------------------------------------------------------------

async function processUnreport(interaction: DiscordInteraction, actorId: string, seriesId: string) {
  const supabase = createAdminClient();

  const { data: claimed } = await supabase
    .from("crl6mansqueuebot_series")
    .update({ status: "void", winner_team: null })
    .eq("id", seriesId)
    .eq("status", "reported")
    .select("*");
  const series = claimed?.[0] as SeriesRow | undefined;
  if (!series) {
    await editOriginalResponse(interaction.token, { content: "That series isn't in a reported state (already unreported, still active, or doesn't exist)." });
    return;
  }

  const { data: seriesPlayers } = await supabase.from("crl6mansqueuebot_series_players").select("*").eq("series_id", series.id);
  const players = seriesPlayers ?? [];
  const { data: playerRows } = await supabase
    .from("crl6mansqueuebot_players")
    .select("*")
    .in("id", players.map((p) => p.player_id));
  const byId = new Map((playerRows ?? []).map((p) => [p.id, p]));

  await Promise.all(
    players.map((sp) => {
      const p = byId.get(sp.player_id);
      if (!p) return Promise.resolve(null);
      const update: Partial<Pick<PlayerRow, "total_games_played" | "mmr" | "rank_games_played" | "band_games_played">> = {
        total_games_played: Math.max(0, p.total_games_played - 1),
      };
      if (series.queue_type === "rank") {
        update.mmr = p.mmr - sp.mmr_delta;
        update.rank_games_played = Math.max(0, p.rank_games_played - 1);
        update.band_games_played = Math.max(0, p.band_games_played - 1);
      }
      return supabase.from("crl6mansqueuebot_players").update(update).eq("id", p.id);
    }),
  );

  await logAdminAction(actorId, "unreport", series.id, `queue_type=${series.queue_type} players=${players.length}`);
  const matchNumber = (series as any).match_number;
  const matchLabel = matchNumber !== null && matchNumber !== undefined ? `Match #${matchNumber}` : `Series ${series.id.slice(0, 8)}`;
  await editOriginalResponse(interaction.token, {
    content: `Unreported ${matchLabel} — MMR and game counts reversed for ${players.length} players.`,
  });
}

// ---------------------------------------------------------------------------
// /admin cancel-series [id] — void an in-progress (forming/active) series. Shares
// claimSeriesVoid/closeMatchChannelsAfterDelay (matchChannels.ts) with /admin force-leave's
// active-series case, and the same reply-then-delay ordering /report and /abandon use so the
// admin's ephemeral confirmation isn't blocked on the 30s closing warning. With no id:, resolves
// to whichever match the calling admin is currently sitting in (via membership, not channel —
// queue_channel_id is a shared rank/universal queue channel, so multiple concurrently active
// series can share it); an admin who isn't a participant must pass id: explicitly.
// ---------------------------------------------------------------------------

async function resolveSeriesForAdmin(
  supabase: AdminClient,
  interaction: DiscordInteraction,
  seriesIdOverride: string | null,
  actorId: string,
): Promise<SeriesRow | null> {
  if (seriesIdOverride) {
    const { data } = await supabase.from("crl6mansqueuebot_series").select("*").eq("id", seriesIdOverride).maybeSingle();
    return data;
  }
  const caller = await getOrCreatePlayer(supabase, actorId, interactionDisplayName(interaction));
  return getLockedSeriesForPlayer(supabase, caller.id);
}

async function processCancelSeries(interaction: DiscordInteraction, actorId: string, seriesIdOverride: string | null) {
  const supabase = createAdminClient();
  const series = await resolveSeriesForAdmin(supabase, interaction, seriesIdOverride, actorId);
  if (!series) {
    await editOriginalResponse(interaction.token, {
      content: seriesIdOverride ? "Series not found." : "You're not part of an active match — pass id: to cancel a different one.",
    });
    return;
  }

  const ok = await claimSeriesVoid(supabase, series, "**Series cancelled by an admin.** No MMR change.");
  if (!ok) {
    await editOriginalResponse(interaction.token, { content: "This match has already been settled." });
    return;
  }

  await logAdminAction(actorId, "cancel_series", series.id);
  await editOriginalResponse(interaction.token, { content: `Cancelled series ${series.id}.` });
  await closeMatchChannelsAfterDelay(supabase, series);
}

// ---------------------------------------------------------------------------
// /admin cancel-matches — cancels all active and forming series at once.
// ---------------------------------------------------------------------------

async function processCancelMatches(interaction: DiscordInteraction, actorId: string) {
  const supabase = createAdminClient();

  // Fetch all active and forming series
  const { data: activeSeries } = await supabase
    .from("crl6mansqueuebot_series")
    .select("*")
    .in("status", ["forming", "active"]);

  if (!activeSeries || activeSeries.length === 0) {
    await editOriginalResponse(interaction.token, { content: "No active or forming matches to cancel." });
    return;
  }

  const seriesList = activeSeries as SeriesRow[];
  let cancelledCount = 0;

  // Cancel each series
  for (const series of seriesList) {
    const ok = await claimSeriesVoid(supabase, series, "**All matches cancelled by an admin.** No MMR change.");
    if (ok) {
      cancelledCount++;
      await closeMatchChannelsAfterDelay(supabase, series);
    }
  }

  await logAdminAction(actorId, "cancel_matches", "all", `cancelled=${cancelledCount}`);
  await editOriginalResponse(interaction.token, { content: `Cancelled ${cancelledCount} active/forming match${cancelledCount === 1 ? "" : "es"}.` });
}

// ---------------------------------------------------------------------------
// /admin adjust-mmr target:<@user> [delta] [mmr] — exactly one of delta: (relative) or
// mmr: (absolute) must be given.
// ---------------------------------------------------------------------------

async function processAdjustMmr(
  interaction: DiscordInteraction,
  actorId: string,
  targetDiscordId: string | null,
  delta: number | undefined,
  mmr: number | undefined,
) {
  if (!targetDiscordId) {
    await editOriginalResponse(interaction.token, { content: "Missing target." });
    return;
  }
  const hasDelta = delta !== undefined;
  const hasAbsolute = mmr !== undefined;
  if (hasDelta === hasAbsolute) {
    await editOriginalResponse(interaction.token, { content: "Provide exactly one of delta: or mmr:." });
    return;
  }

  const supabase = createAdminClient();
  const { data: player } = await supabase.from("crl6mansqueuebot_players").select("*").eq("discord_id", targetDiscordId).maybeSingle();
  if (!player) {
    await editOriginalResponse(interaction.token, { content: "That player has no record yet — they haven't played." });
    return;
  }

  const newMmr = hasAbsolute ? (mmr as number) : player.mmr + (delta as number);
  await supabase.from("crl6mansqueuebot_players").update({ mmr: newMmr }).eq("id", player.id);
  await logAdminAction(actorId, "adjust_mmr", player.discord_id, `${player.mmr.toFixed(1)} -> ${newMmr.toFixed(1)}`);
  await sendDirectMessage(player.discord_id, `An admin manually adjusted your MMR: ${player.mmr.toFixed(1)} → ${newMmr.toFixed(1)}.`);
  await editOriginalResponse(interaction.token, { content: `<@${player.discord_id}>: ${player.mmr.toFixed(1)} → ${newMmr.toFixed(1)}.` });
}

// ---------------------------------------------------------------------------
// /admin force-leave target:<@user> — dequeues the player if only queued, and/or voids any
// active series they're locked into. An admin bypass for a stuck/unresponsive player when the
// other 5 can't gather 3 /abandon votes.
// ---------------------------------------------------------------------------

async function findActiveSeriesForPlayer(supabase: AdminClient, playerId: string): Promise<SeriesRow[]> {
  const [{ data: lobbyRows }, { data: seriesPlayerRows }] = await Promise.all([
    supabase.from("crl6mansqueuebot_series_lobby").select("series_id").eq("player_id", playerId),
    supabase.from("crl6mansqueuebot_series_players").select("series_id").eq("player_id", playerId),
  ]);
  const seriesIds = [...new Set([...(lobbyRows ?? []).map((r) => r.series_id), ...(seriesPlayerRows ?? []).map((r) => r.series_id)])];
  if (seriesIds.length === 0) return [];

  const { data } = await supabase.from("crl6mansqueuebot_series").select("*").in("id", seriesIds).in("status", ["forming", "active"]);
  return data ?? [];
}

async function processForceLeave(interaction: DiscordInteraction, actorId: string, targetDiscordId: string | null) {
  if (!targetDiscordId) {
    await editOriginalResponse(interaction.token, { content: "Missing target." });
    return;
  }

  const supabase = createAdminClient();
  const { data: player } = await supabase.from("crl6mansqueuebot_players").select("*").eq("discord_id", targetDiscordId).maybeSingle();
  if (!player) {
    await editOriginalResponse(interaction.token, { content: "That player has no record yet." });
    return;
  }

  const { data: queuedIn } = await supabase.from("crl6mansqueuebot_queue_members").select("queue_type").eq("player_id", player.id);
  const queueTypes = [...new Set((queuedIn ?? []).map((r) => r.queue_type))];
  if (queueTypes.length > 0) {
    await supabase.from("crl6mansqueuebot_queue_members").delete().eq("player_id", player.id);
    await Promise.all(queueTypes.map((qt) => refreshQueueMessage(supabase, qt)));
  }

  const activeSeries = await findActiveSeriesForPlayer(supabase, player.id);
  const voidedSeries: SeriesRow[] = [];
  for (const series of activeSeries) {
    const ok = await claimSeriesVoid(
      supabase,
      series,
      `**Series cancelled by an admin.** <@${player.discord_id}> was force-removed. No MMR change.`,
    );
    if (ok) voidedSeries.push(series);
  }

  if (queueTypes.length === 0 && voidedSeries.length === 0) {
    await editOriginalResponse(interaction.token, { content: "That player isn't queued or in an active series — nothing to do." });
    return;
  }

  await logAdminAction(actorId, "force_leave", player.discord_id, `queues=${queueTypes.join(",") || "none"} seriesVoided=${voidedSeries.length}`);
  await editOriginalResponse(interaction.token, {
    content: `Removed <@${player.discord_id}>${queueTypes.length ? ` from ${queueTypes.join(" & ")} queue` : ""}${voidedSeries.length ? ` and cancelled ${voidedSeries.length} active series` : ""}.`,
  });

  await Promise.all(voidedSeries.map((s) => closeMatchChannelsAfterDelay(supabase, s)));
}

// ---------------------------------------------------------------------------
// /admin recompute-bands — thin manual trigger for the same recomputeBands() the daily
// pg_cron job calls (bands.ts).
// ---------------------------------------------------------------------------

async function processRecomputeBands(interaction: DiscordInteraction, actorId: string) {
  const summary = await recomputeBands();
  await logAdminAction(
    actorId,
    "recompute_bands",
    undefined,
    `placed=${summary.placed} promoted=${summary.promoted} demoted=${summary.demoted} unchanged=${summary.unchanged}`,
  );
  await editOriginalResponse(interaction.token, {
    content: `Recomputed bands — placed ${summary.placed}, promoted ${summary.promoted}, demoted ${summary.demoted}, unchanged ${summary.unchanged}.`,
  });
}

// ---------------------------------------------------------------------------
// /admin config get [key] | set key value — validated against KNOWN_CONFIG_DEFAULTS
// (config.ts), which mirrors CLAUDE.md's "Config values" table.
// ---------------------------------------------------------------------------

async function processConfigGet(interaction: DiscordInteraction, key: string | null) {
  if (key) {
    if (!(key in KNOWN_CONFIG_DEFAULTS)) {
      await editOriginalResponse(interaction.token, { content: `Unknown config key. Known keys: ${Object.keys(KNOWN_CONFIG_DEFAULTS).join(", ")}` });
      return;
    }
    const value = await getConfigNumber(key, KNOWN_CONFIG_DEFAULTS[key]);
    await editOriginalResponse(interaction.token, { content: `${key} = ${value}` });
    return;
  }

  const supabase = createAdminClient();
  const { data: rows } = await supabase.from("crl6mansqueuebot_config").select("*");
  const overrides = new Map((rows ?? []).map((r) => [r.key, r.value]));
  const lines = Object.entries(KNOWN_CONFIG_DEFAULTS).map(
    ([k, def]) => `${k} = ${overrides.get(k) ?? def}${overrides.has(k) ? "" : " (default)"}`,
  );
  await editOriginalResponse(interaction.token, { content: lines.join("\n") });
}

async function processConfigSet(interaction: DiscordInteraction, actorId: string, key: string | null, value: number | undefined) {
  if (!key || !(key in KNOWN_CONFIG_DEFAULTS)) {
    await editOriginalResponse(interaction.token, { content: `Unknown config key. Known keys: ${Object.keys(KNOWN_CONFIG_DEFAULTS).join(", ")}` });
    return;
  }
  if (value === undefined) {
    await editOriginalResponse(interaction.token, { content: "value must be a number." });
    return;
  }

  await setConfigValue(key, String(value));
  await logAdminAction(actorId, "config_set", key, `value=${value}`);
  await editOriginalResponse(interaction.token, { content: `${key} set to ${value}.` });
}

// ---------------------------------------------------------------------------
// /admin audit-log [limit] — most recent entries first, capped at 25 per Discord message
// length practicality.
// ---------------------------------------------------------------------------

async function processAuditLog(interaction: DiscordInteraction, limitRaw: number | undefined) {
  const supabase = createAdminClient();
  const limit = limitRaw !== undefined ? Math.min(Math.max(Math.trunc(limitRaw), 1), 25) : 10;
  const { data: rows } = await supabase
    .from("crl6mansqueuebot_audit_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (!rows || rows.length === 0) {
    await editOriginalResponse(interaction.token, { content: "No audit log entries." });
    return;
  }

  const lines = rows.map((r) => {
    const ts = Math.floor(new Date(r.created_at).getTime() / 1000);
    return `<t:${ts}:R> **${r.action}** by <@${r.actor_discord_id}>${r.target ? ` → ${r.target}` : ""}${r.details ? ` (${r.details})` : ""}`;
  });
  await editOriginalResponse(interaction.token, { content: lines.join("\n") });
}

// ---------------------------------------------------------------------------
// /admin test-flow mode:<captains|balanced> — admin testing tool. Creates a temporary
// 6-player match (5 test bots + the admin), auto-casts bot votes for the specified mode,
// forms teams, and allows the admin to run /report. All test data is deleted afterward.
// ---------------------------------------------------------------------------

async function processTestFlow(interaction: DiscordInteraction, actorId: string, mode: string) {
  if (mode !== "captains" && mode !== "balanced") {
    await editOriginalResponse(interaction.token, { content: "Mode must be 'captains' or 'balanced'." });
    return;
  }

  const supabase = createAdminClient();
  const { data: season } = await supabase.from("crl6mansqueuebot_seasons").select("id").eq("is_active", true).maybeSingle();
  if (!season) {
    await editOriginalResponse(interaction.token, { content: "No active season — run /newseason first." });
    return;
  }

  const admin = await getOrCreatePlayer(supabase, actorId, interactionDisplayName(interaction));
  if (await getLockedSeriesForPlayer(supabase, admin.id)) {
    await editOriginalResponse(interaction.token, { content: "You're already in an active match." });
    return;
  }

  // Determine which queue channel this command is running in
  const { data: queueMessages } = await supabase.from("crl6mansqueuebot_queue_messages").select("queue_type, channel_id");
  const queueMessageMap = new Map((queueMessages as any ?? []).map((q: any) => [q.queue_type, q.channel_id]));

  let queueChannelId: string | null = null;
  let queueType: "rank" | "universal" | null = null;

  const rankChannelId = queueMessageMap.get("rank") as string | undefined;
  const universalChannelId = queueMessageMap.get("universal") as string | undefined;

  if (rankChannelId && interaction.channel_id === rankChannelId) {
    queueChannelId = rankChannelId;
    queueType = "rank";
  } else if (universalChannelId && interaction.channel_id === universalChannelId) {
    queueChannelId = universalChannelId;
    queueType = "universal";
  }

  if (!queueChannelId || !queueType) {
    await editOriginalResponse(interaction.token, { content: "Run this command in a queue channel." });
    return;
  }

  // Send initial message
  const queueLabel = queueType === "rank" ? "Rank Queue" : "Universal Queue";
  await editOriginalResponse(interaction.token, {
    content: `🤖 Creating test bots and adding them to the ${queueLabel}...`,
  });

  // Create 5 bots one at a time and add each to the queue
  const baseMMR = admin.mmr || 1000;
  const addedBots: string[] = [];

  for (let i = 0; i < 5; i++) {
    const botMMR = baseMMR + (Math.random() * 400 - 200);
    const botDiscordId = `test_bot_${Date.now()}_${i}`;

    // Create bot
    const { data: bot } = await supabase
      .from("crl6mansqueuebot_players")
      .insert({ discord_id: botDiscordId, display_name: `Test Bot ${i + 1}`, mmr: botMMR, is_test_data: true, vote_default: mode as any })
      .select("*")
      .single();

    if (!bot) continue;

    // Add bot to queue using RPC
    const { data: queueResults } = await supabase.rpc("crl6mansqueuebot_join_queue", {
      p_player_id: bot.id,
      p_queue_type: queueType,
    });

    const queueResult = Array.isArray(queueResults) ? queueResults[0] : queueResults;

    if (queueResult?.status === "joined") {
      addedBots.push(bot.discord_id);
    }

    // Small delay between joins for visibility
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Fetch all queue members and post final queue status
  const { data: memberRows } = await supabase
    .from("crl6mansqueuebot_queue_members")
    .select("player_id")
    .eq("queue_type", queueType)
    .order("joined_at", { ascending: true });

  if (memberRows) {
    const playerIds = memberRows.map((r) => r.player_id);
    const { data: players } = await supabase
      .from("crl6mansqueuebot_players")
      .select("*")
      .in("id", playerIds);

    if (players) {
      const memberMentions = players.map((p) => `<@${p.discord_id}>`).join(" ");
      const embed = {
        color: 0x57f287,
        description: `**Current Queue Members: ${players.length}**\n${memberMentions}`,
        footer: { text: `Run /q to join as the 6th player. Mode: ${mode}` },
      };

      await discordFetch(`/channels/${queueChannelId}/messages`, {
        method: "POST",
        body: JSON.stringify({ embeds: [embed] }),
      }).catch((err) => console.error(`Failed to post queue update`, err));
    }
  }

  // Final message telling admin to join, then delete it so it auto-dismisses
  await editOriginalResponse(interaction.token, {
    content: `✅ Test bot queue is ready (${addedBots.length}/5 bots added)!\n\n**Now use /q to join as the 6th player and start the match.**\n\nThe vote screen with **${mode}** buttons will appear automatically when all 6 players are ready.`,
  });

  // Delete the deferred response so it auto-dismisses after a short delay
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await deleteOriginalResponse(interaction.token);

  await logAdminAction(actorId, "test_flow", "queue_setup", `${queueType} queue, mode=${mode} with 5 test bots`);
}

// ---------------------------------------------------------------------------
// /admin reset confirmation:<text> — dangerous: wipes all game data and
// resets to a clean slate. Requires "SEASON RESET" confirmation text.
// Does NOT start a new season — just clears all tables.
// ---------------------------------------------------------------------------

async function processReset(interaction: DiscordInteraction, actorId: string, confirmation: string | null) {
  if (confirmation !== "SEASON RESET") {
    await editOriginalResponse(interaction.token, { content: 'Confirmation failed. Type exactly: "SEASON RESET"' });
    return;
  }

  const supabase = createAdminClient();

  try {
    // Delete in order of foreign key dependencies to avoid constraint violations
    await supabase.from("crl6mansqueuebot_abandon_votes").delete().neq("series_id", "");
    await supabase.from("crl6mansqueuebot_sub_requests").delete().neq("series_id", "");
    await supabase.from("crl6mansqueuebot_series_votes").delete().neq("series_id", "");
    await supabase.from("crl6mansqueuebot_series_players").delete().neq("series_id", "");
    await supabase.from("crl6mansqueuebot_series_lobby").delete().neq("series_id", "");
    await supabase.from("crl6mansqueuebot_series").delete().neq("id", "");
    await supabase.from("crl6mansqueuebot_queue_members").delete().neq("player_id", "");
    await supabase.from("crl6mansqueuebot_queue_messages").delete().neq("channel_id", "");

    // Reset players but keep them (delete all game data only)
    await supabase
      .from("crl6mansqueuebot_players")
      .update({
        mmr: 0,
        is_placed: false,
        band: null,
        total_games_played: 0,
        rank_games_played: 0,
        band_games_played: 0,
        vote_default: null,
        is_prism: false,
      })
      .neq("id", "");

    // Keep seasons table untouched (they track historical data)
    // Keep rank emoji config untouched
    // Keep admin roles untouched
    // Keep config values untouched

    await logAdminAction(actorId, "reset", "all_game_data", "Wiped all series, queue members, and reset player stats to 0");
    await editOriginalResponse(interaction.token, {
      content: "✅ All game data reset to clean slate. Players retained with stats reset to 0.",
    });
  } catch (err) {
    console.error("Failed to reset game data", err);
    await editOriginalResponse(interaction.token, { content: "An error occurred while resetting data." });
  }
}

// ---------------------------------------------------------------------------
// /admin full-reset — complete factory reset, deletes EVERYTHING including
// configuration, making the bot act as if it's brand new
// ---------------------------------------------------------------------------

async function processFullReset(interaction: DiscordInteraction, actorId: string, confirmation: string | null) {
  if (confirmation !== "FACTORY RESET") {
    await editOriginalResponse(interaction.token, { content: 'Confirmation failed. Type exactly: "FACTORY RESET"' });
    return;
  }

  const supabase = createAdminClient();

  try {
    // Delete in order of foreign key dependencies
    await supabase.from("crl6mansqueuebot_abandon_votes").delete().neq("series_id", "");
    await supabase.from("crl6mansqueuebot_sub_requests").delete().neq("series_id", "");
    await supabase.from("crl6mansqueuebot_series_votes").delete().neq("series_id", "");
    await supabase.from("crl6mansqueuebot_series_players").delete().neq("series_id", "");
    await supabase.from("crl6mansqueuebot_series_lobby").delete().neq("series_id", "");
    await supabase.from("crl6mansqueuebot_series").delete().neq("id", "");
    await supabase.from("crl6mansqueuebot_queue_members").delete().neq("player_id", "");
    await supabase.from("crl6mansqueuebot_season_history").delete().neq("season_id", "");
    await supabase.from("crl6mansqueuebot_seasons").delete().neq("id", "");
    await supabase.from("crl6mansqueuebot_players").delete().neq("id", "");
    await supabase.from("crl6mansqueuebot_queue_messages").delete().neq("channel_id", "");
    await supabase.from("crl6mansqueuebot_queue_channel_messages").delete().neq("channel_id", "");

    // Clear all configuration (delete all rows)
    await (supabase.from("crl6mansqueuebot_config") as any).delete();
    await (supabase.from("crl6mansqueuebot_band_roles") as any).delete();
    await (supabase.from("crl6mansqueuebot_queue_mention_roles") as any).delete();
    await (supabase.from("crl6mansqueuebot_rank_emoji") as any).delete();

    // Clear audit log
    await supabase.from("crl6mansqueuebot_audit_log").delete().neq("id", "");

    // Clear admin roles (but NOT the admin_roles table structure itself — that stays)
    await supabase.from("crl6mansqueuebot_admin_roles").delete().neq("role_id", "");

    await logAdminAction(actorId, "full_reset", "all_data", "Complete factory reset — all data and configuration deleted");
    await editOriginalResponse(interaction.token, {
      content: "✅ Complete factory reset done. Bot is now brand new. You'll need to run setup commands again.",
    });
  } catch (err) {
    console.error("Failed to perform full reset", err);
    await editOriginalResponse(interaction.token, { content: "An error occurred while performing factory reset." });
  }
}

// ---------------------------------------------------------------------------
// /admin checklist — shows which settings are configured and which need setup
// ---------------------------------------------------------------------------

async function processChecklist(interaction: DiscordInteraction) {
  const supabase = createAdminClient();

  try {
    // Fetch all config values
    const { data: configs } = await supabase.from("crl6mansqueuebot_config").select("*");
    const configMap = new Map((configs ?? []).map((c) => [c.key, c.value]));

    // Fetch queue messages (which track queue channel setup)
    const { data: queueMessages } = await supabase.from("crl6mansqueuebot_queue_messages").select("*");
    const queueMessageMap = new Map((queueMessages ?? []).map((q) => [q.queue_type, q.channel_id]));

    // Fetch rank emoji
    const { data: emojis } = await supabase.from("crl6mansqueuebot_rank_emoji").select("*");
    const emojiMap = new Map((emojis as any ?? []).map((e: any) => [e.band, e.emoji_id]));

    // Fetch band roles
    const { data: bandRoles } = await supabase.from("crl6mansqueuebot_band_roles").select("*");
    const bandRoleMap = new Map((bandRoles as any ?? []).map((b: any) => [b.band, b.role_id]));

    // Fetch mention roles
    const { data: mentionRoles } = await supabase.from("crl6mansqueuebot_queue_mention_roles").select("*");
    const mentionRoleMap = new Map((mentionRoles as any ?? []).map((m: any) => [m.queue_type, m.role_id]));

    // Fetch admin roles
    const { count: adminRoleCount } = await supabase
      .from("crl6mansqueuebot_admin_roles")
      .select("*", { count: "exact", head: true });

    // Build checklist
    const items: string[] = [];

    // Channels
    items.push(`**Channels**`);
    items.push(queueMessageMap.has("rank") ? `✅ Rank Queue channel` : `❌ Rank Queue channel`);
    items.push(queueMessageMap.has("universal") ? `✅ Universal Queue channel` : `❌ Universal Queue channel`);
    items.push(configMap.has("report_channel_id") ? `✅ Report channel` : `❌ Report channel`);
    items.push(configMap.has("6mans_call_category_id") ? `✅ 6-mans call category` : `❌ 6-mans call category`);

    // Rank emoji
    items.push(``);
    items.push(`**Rank Emoji**`);
    items.push(emojiMap.has("Iron") ? `✅ Iron` : `❌ Iron`);
    items.push(emojiMap.has("Garnet") ? `✅ Garnet` : `❌ Garnet`);
    items.push(emojiMap.has("Emerald") ? `✅ Emerald` : `❌ Emerald`);
    items.push(emojiMap.has("Sapphire") ? `✅ Sapphire` : `❌ Sapphire`);
    items.push(emojiMap.has("Prism") ? `✅ Prism` : `❌ Prism`);
    items.push(emojiMap.has("Unranked") ? `✅ Unranked` : `❌ Unranked`);

    // Band roles
    items.push(``);
    items.push(`**Band Roles**`);
    items.push(bandRoleMap.has("Iron") ? `✅ Iron role` : `❌ Iron role`);
    items.push(bandRoleMap.has("Garnet") ? `✅ Garnet role` : `❌ Garnet role`);
    items.push(bandRoleMap.has("Emerald") ? `✅ Emerald role` : `❌ Emerald role`);
    items.push(bandRoleMap.has("Sapphire") ? `✅ Sapphire role` : `❌ Sapphire role`);
    items.push(bandRoleMap.has("Unranked") ? `✅ Unranked role` : `❌ Unranked role`);
    items.push(bandRoleMap.has("Prism") ? `✅ Prism role` : `❌ Prism role`);

    // Mention roles
    items.push(``);
    items.push(`**Queue Mention Roles**`);
    items.push(mentionRoleMap.has("rank") ? `✅ Rank Queue mention role` : `❌ Rank Queue mention role`);
    items.push(mentionRoleMap.has("universal") ? `✅ Universal Queue mention role` : `❌ Universal Queue mention role`);

    // Admin roles
    items.push(``);
    items.push(`**Admin Setup**`);
    items.push(adminRoleCount && adminRoleCount > 0 ? `✅ Admin roles (${adminRoleCount} configured)` : `❌ No admin roles configured`);

    const description = items.join("\n");
    const configured = items.filter((i) => i.startsWith("✅")).length;
    const total = items.filter((i) => i.startsWith("✅") || i.startsWith("❌")).length;

    await editOriginalResponse(interaction.token, {
      embeds: [
        {
          color: 0x57f287,
          title: `Setup Checklist`,
          description,
          footer: { text: `${configured}/${total} items configured` },
        },
      ],
    });
  } catch (err) {
    console.error("Failed to generate checklist", err);
    await editOriginalResponse(interaction.token, { content: "An error occurred while generating the checklist." });
  }
}

// ---------------------------------------------------------------------------
// /admin set-rank-emoji band:<band> image:<attachment> — uploads a custom emoji
// to the guild and stores the emoji ID for the specified rank band. The emoji is
// then used in embed displays (report summary, queue status, etc) instead of image URLs.
// ---------------------------------------------------------------------------

async function processSetRankEmoji(
  interaction: DiscordInteraction,
  actorId: string,
  band: string | null,
  imageAttachmentId: string | null,
) {
  if (!band || !["Iron", "Garnet", "Emerald", "Sapphire", "Prism", "Unranked"].includes(band)) {
    await editOriginalResponse(interaction.token, { content: "Invalid band." });
    return;
  }
  if (!imageAttachmentId) {
    await editOriginalResponse(interaction.token, { content: "No image provided." });
    return;
  }

  const attachment = interaction.data?.resolved?.attachments?.[imageAttachmentId];
  if (!attachment) {
    await editOriginalResponse(interaction.token, { content: "Attachment not found." });
    return;
  }

  try {
    const guildId = interaction.guild_id ?? (await getGuildId());
    if (!guildId) {
      await editOriginalResponse(interaction.token, { content: "Could not determine guild ID." });
      return;
    }

    // Fetch the image data from the attachment URL
    const imageRes = await fetch(attachment.url);
    if (!imageRes.ok) {
      await editOriginalResponse(interaction.token, { content: "Failed to download image." });
      return;
    }
    const imageBuffer = await imageRes.arrayBuffer();
    const base64Image = Buffer.from(imageBuffer).toString("base64");
    const dataUri = `data:${attachment.content_type || "image/png"};base64,${base64Image}`;

    // Create the emoji on the guild
    const createdEmoji = await discordFetch(`/guilds/${guildId}/emojis`, {
      method: "POST",
      body: JSON.stringify({
        name: `rank_${band.toLowerCase()}`,
        image: dataUri,
      }),
    });

    if (!createdEmoji || !createdEmoji.id) {
      await editOriginalResponse(interaction.token, { content: "Failed to create emoji on the guild." });
      return;
    }

    // Store the emoji ID in the database
    const supabase = createAdminClient();
    const discordId = interactionUserId(interaction);

    await supabase.from("crl6mansqueuebot_rank_emoji").upsert({
      band,
      emoji_id: createdEmoji.id,
      set_by: discordId,
    } as any);

    await logAdminAction(actorId, "set_rank_emoji", band, `emoji_id=${createdEmoji.id}`);
    await editOriginalResponse(interaction.token, {
      content: `Successfully set emoji for ${band} rank: <:rank_${band.toLowerCase()}:${createdEmoji.id}>`,
    });
  } catch (err) {
    console.error(`Failed to set rank emoji for ${band}`, err);
    await editOriginalResponse(interaction.token, { content: "An error occurred while setting the emoji." });
  }
}

// ---------------------------------------------------------------------------
// /admin stop — pause all bot activity (queue joins, team formation, etc.)
// ---------------------------------------------------------------------------

async function processStop(interaction: DiscordInteraction, actorId: string) {
  await setConfigValue("bot_paused", "1");
  await logAdminAction(actorId, "stop_bot", "", "bot paused");
  await editOriginalResponse(interaction.token, { content: "Bot paused — all player commands are blocked." });
}

// ---------------------------------------------------------------------------
// /admin start — resume bot activity after a pause
// ---------------------------------------------------------------------------

async function processStart(interaction: DiscordInteraction, actorId: string) {
  await setConfigValue("bot_paused", "0");
  await logAdminAction(actorId, "start_bot", "", "bot resumed");
  await editOriginalResponse(interaction.token, { content: "Bot resumed." });
}
