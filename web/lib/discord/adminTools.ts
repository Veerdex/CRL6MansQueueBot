import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendDirectMessage, editOriginalResponse, discordFetch, getGuildId } from "./rest";
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
  await editOriginalResponse(interaction.token, {
    content: `Unreported series ${series.id} — MMR and game counts reversed for ${players.length} players.`,
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

  // Create 5 test bots with random MMR
  const bots: PlayerRow[] = [];
  const baseMMR = admin.mmr || 1000;
  for (let i = 0; i < 5; i++) {
    const botMMR = baseMMR + (Math.random() * 400 - 200); // ±200 from admin's MMR
    const botDiscordId = `test_bot_${Date.now()}_${i}`;
    const { data: bot } = await supabase
      .from("crl6mansqueuebot_players")
      .insert({ discord_id: botDiscordId, display_name: `Test Bot ${i + 1}`, mmr: botMMR, is_test_data: true })
      .select("*")
      .single();
    if (bot) bots.push(bot);
  }

  if (bots.length < 5) {
    await editOriginalResponse(interaction.token, { content: "Failed to create test bots." });
    return;
  }

  const members = [admin, ...bots];

  // Create series
  const { data: series } = await supabase
    .from("crl6mansqueuebot_series")
    .insert({ season_id: season.id, queue_type: "rank", status: "forming", is_test_data: true })
    .select("*")
    .single();

  if (!series) {
    await editOriginalResponse(interaction.token, { content: "Failed to create test series." });
    return;
  }

  // Add all to lobby
  await supabase.from("crl6mansqueuebot_series_lobby").insert(members.map((m) => ({ series_id: series.id, player_id: m.id })));

  // Create a dummy formation message (won't actually post to Discord for test)
  const { data: updated } = await supabase
    .from("crl6mansqueuebot_series")
    .update({ formation_message_id: "test_dummy_message_id" })
    .eq("id", series.id)
    .select("*")
    .single();

  if (!updated) {
    await editOriginalResponse(interaction.token, { content: "Failed to set up test series." });
    return;
  }

  // Auto-cast bot votes
  for (let i = 0; i < 3; i++) {
    await supabase.from("crl6mansqueuebot_series_votes").insert({
      series_id: series.id,
      player_id: bots[i].id,
      choice: mode as "captains" | "balanced",
    });
  }

  // Settle the vote
  await supabase.from("crl6mansqueuebot_series").update({ vote_result: mode as "captains" | "balanced" }).eq("id", series.id);

  // For captains mode, auto-assign teams
  if (mode === "captains") {
    const sorted = members.sort((a, b) => (b.mmr || 0) - (a.mmr || 0));
    const captainA = sorted[0];
    const captainB = sorted[1];
    const others = sorted.slice(2);

    // Assign: captain A gets 2, captain B gets 2, last one goes to A
    await supabase.from("crl6mansqueuebot_series_lobby").update({ is_captain: true, team: "A" }).eq("player_id", captainA.id).eq("series_id", series.id);
    await supabase.from("crl6mansqueuebot_series_lobby").update({ is_captain: true, team: "B" }).eq("player_id", captainB.id).eq("series_id", series.id);

    await supabase.from("crl6mansqueuebot_series_lobby").update({ team: "A" }).eq("player_id", others[0].id).eq("series_id", series.id);
    await supabase.from("crl6mansqueuebot_series_lobby").update({ team: "B" }).eq("player_id", others[1].id).eq("series_id", series.id);
    await supabase.from("crl6mansqueuebot_series_lobby").update({ team: "B" }).eq("player_id", others[2].id).eq("series_id", series.id);
    await supabase.from("crl6mansqueuebot_series_lobby").update({ team: "A" }).eq("player_id", others[3].id).eq("series_id", series.id);

    // Move lobby to series_players and set status to active
    const { data: lobbyRows } = await supabase.from("crl6mansqueuebot_series_lobby").select("*").eq("series_id", series.id);
    if (lobbyRows) {
      const seriesPlayerRows = lobbyRows.map((row) => ({
        series_id: row.series_id,
        player_id: row.player_id,
        team: row.team! as Team,
      }));
      await supabase.from("crl6mansqueuebot_series_players").insert(seriesPlayerRows);
      await supabase.from("crl6mansqueuebot_series_lobby").delete().eq("series_id", series.id);
    }
  } else {
    // Balanced: compute best split and assign
    const sorted = members.sort((a, b) => (b.mmr || 0) - (a.mmr || 0));
    const teamA = [sorted[0], sorted[3], sorted[4]];
    const teamB = [sorted[1], sorted[2], sorted[5]];

    const { data: lobbyRows } = await supabase.from("crl6mansqueuebot_series_lobby").select("*").eq("series_id", series.id);
    if (lobbyRows) {
      const seriesPlayerRows = lobbyRows.map((row) => ({
        series_id: row.series_id,
        player_id: row.player_id,
        team: (teamA.some((p) => p.id === row.player_id) ? "A" : "B") as Team,
      }));
      await supabase.from("crl6mansqueuebot_series_players").insert(seriesPlayerRows);
      await supabase.from("crl6mansqueuebot_series_lobby").delete().eq("series_id", series.id);
    }
  }

  // Set status to active
  await supabase.from("crl6mansqueuebot_series").update({ status: "active" }).eq("id", series.id);

  // Store series id for cleanup (on /report, test data will be auto-cleaned)
  await editOriginalResponse(interaction.token, {
    content: `Test match created! Series ID: ${series.id}\n\nTeams:\n**Team A**: ${members.slice(0, 3).map((m) => m.display_name).join(", ")}\n**Team B**: ${members.slice(3).map((m) => m.display_name).join(", ")}\n\nRun \`/report result:win\` or \`/report result:loss\` to complete the test.`,
  });

  await logAdminAction(actorId, "test_flow", series.id, `mode=${mode}`);
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
