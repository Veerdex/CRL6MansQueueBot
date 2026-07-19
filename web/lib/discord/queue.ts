import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PlayerRow, QueueType, SeriesRow } from "@/lib/supabase/types";
import { discordFetch, sendDirectMessage, editOriginalResponse, deleteOriginalResponse, getGuildId, BRAND_COLOR, getRankEmoji } from "./rest";
import { getAdminRoleIds, hasAdminAccess } from "./admin";
import { VIEW_CHANNEL, SEND_MESSAGES, CONNECT, ROLE_TYPE, MEMBER_TYPE, type PermissionOverwrite } from "./permissions";
import { interactionUserId, interactionDisplayName, type DiscordInteraction } from "./types";
import { startTeamFormation } from "./teamFormation";

type AdminClient = ReturnType<typeof createAdminClient>;

const QUEUE_LABELS: Record<QueueType, string> = {
  rank: "Rank Queue",
  universal: "Universal Queue",
};

// ---------------------------------------------------------------------------
// Queue status message — queueing moved from a persistent button panel to slash commands
// (/q, /queue to join; /l, /leave to leave — Discord has no native command aliasing, so all
// four are separately registered commands calling the same handlers, matching the existing
// /end-vs-/admin-cancel-series precedent in adminTools.ts). To avoid channel clutter, exactly
// one queue-status message is kept alive per queue channel: every join/leave deletes the
// previously tracked message and posts a fresh one, rather than PATCH-editing one message in
// place (the old button-driven behavior) or letting messages pile up.
// ---------------------------------------------------------------------------

function queueStatusEmbed(queueType: QueueType, members: PlayerRow[], headline?: string) {
  const label = QUEUE_LABELS[queueType];
  const mentionLine = members.length ? members.map((m) => `<@${m.discord_id}>`).join(" ") : "_Empty_";
  const headlineBlock = headline ? `**${headline}**\n\n` : "";
  return {
    color: BRAND_COLOR,
    description: `${headlineBlock}**Current Queue Members: ${members.length}**\n${mentionLine}`,
    footer: { text: `Run /q to join the ${label} or /l to leave.` },
  };
}

async function fetchQueueMembers(supabase: AdminClient, queueType: QueueType): Promise<PlayerRow[]> {
  const { data: memberRows, error } = await supabase
    .from("crl6mansqueuebot_queue_members")
    .select("player_id")
    .eq("queue_type", queueType)
    .order("joined_at", { ascending: true });
  if (error) throw new Error(`Failed to fetch queue members: ${error.message}`);

  const playerIds = (memberRows ?? []).map((r) => r.player_id);
  if (playerIds.length === 0) return [];

  const { data: players, error: playersError } = await supabase
    .from("crl6mansqueuebot_players")
    .select("*")
    .in("id", playerIds);
  if (playersError) throw new Error(`Failed to fetch players: ${playersError.message}`);

  const byId = new Map((players ?? []).map((p) => [p.id, p]));
  return playerIds.map((id) => byId.get(id)).filter((p): p is PlayerRow => Boolean(p));
}

// Deletes the previously tracked message for `channelId` (if any — pass null to skip, e.g.
// initial setup) and posts a fresh one, then upserts the new channel/message id mapping. The
// single shared primitive behind refreshQueueMessage and initQueueMessage below.
async function postFreshQueueMessage(
  supabase: AdminClient,
  queueType: QueueType,
  channelId: string,
  oldMessageId: string | null,
  members: PlayerRow[],
  headline?: string,
): Promise<void> {
  if (oldMessageId) {
    await discordFetch(`/channels/${channelId}/messages/${oldMessageId}`, { method: "DELETE" }).catch((err) =>
      console.error(`Failed to delete previous queue message ${oldMessageId}`, err),
    );
  }
  const message = (await discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ embeds: [queueStatusEmbed(queueType, members, headline)] }),
  })) as { id: string };

  await supabase.from("crl6mansqueuebot_queue_messages").upsert({
    queue_type: queueType,
    channel_id: channelId,
    message_id: message.id,
  });
}

// Posts a message to a queue channel and tracks it, deleting all other non-permanent messages first.
// Used for status updates, errors, and settled series notifications.
export async function postTrackedQueueMessage(
  supabase: AdminClient,
  channelId: string,
  embed: any,
  messageType: "status" | "error" | "settled" | "teams_formed" | "timeout",
  keepPermanently: boolean = false,
): Promise<string | null> {
  // Delete all non-permanent messages from this channel
  const { data: trackedMessages } = await supabase
    .from("crl6mansqueuebot_queue_channel_messages")
    .select("message_id, keep_permanently")
    .eq("channel_id", channelId) as any;

  if (trackedMessages) {
    for (const msg of trackedMessages) {
      if (!(msg as any).keep_permanently) {
        await discordFetch(`/channels/${channelId}/messages/${msg.message_id}`, { method: "DELETE" }).catch((err) =>
          console.error(`Failed to delete queue channel message ${msg.message_id}`, err),
        );
      }
    }
  }

  // Delete the old non-permanent entries from the tracking table
  await supabase
    .from("crl6mansqueuebot_queue_channel_messages")
    .delete()
    .eq("channel_id", channelId)
    .eq("keep_permanently", false);

  // Post the new message
  try {
    const message = (await discordFetch(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ embeds: [embed] }),
    })) as { id: string };

    // Track the new message
    await supabase.from("crl6mansqueuebot_queue_channel_messages").insert({
      channel_id: channelId,
      message_id: message.id,
      message_type: messageType,
      keep_permanently: keepPermanently,
    } as any);

    return message.id;
  } catch (err) {
    console.error(`Failed to post tracked queue message`, err);
    return null;
  }
}

// Refreshes whichever channel is currently mapped to `queueType`. No-ops if the queue channel
// was never set up. `headline` is the "<@user> has joined/left..." line for command-driven
// refreshes; omitted for headline-less refreshes (admin force-leave, cross-queue-pop removal).
export async function refreshQueueMessage(supabase: AdminClient, queueType: QueueType, headline?: string) {
  const { data: msgRow } = await supabase
    .from("crl6mansqueuebot_queue_messages")
    .select("*")
    .eq("queue_type", queueType)
    .maybeSingle();
  if (!msgRow) return;

  const members = await fetchQueueMembers(supabase, queueType);
  await postFreshQueueMessage(supabase, queueType, msgRow.channel_id, msgRow.message_id, members, headline);
}

export async function initQueueMessage(queueType: QueueType, channelId: string) {
  const supabase = createAdminClient();
  const { data: existing } = await supabase
    .from("crl6mansqueuebot_queue_messages")
    .select("*")
    .eq("queue_type", queueType)
    .maybeSingle();

  // Relocating to a new channel — clean up the old channel's message too, since it's about to
  // become untracked and would otherwise sit there stale forever.
  if (existing && existing.channel_id !== channelId) {
    await discordFetch(`/channels/${existing.channel_id}/messages/${existing.message_id}`, { method: "DELETE" }).catch(() => {});
  }

  const members = await fetchQueueMembers(supabase, queueType);
  const oldMessageId = existing && existing.channel_id === channelId ? existing.message_id : null;
  await postFreshQueueMessage(supabase, queueType, channelId, oldMessageId, members);
}

// ---------------------------------------------------------------------------
// Player + lock lookups
// ---------------------------------------------------------------------------

export async function getOrCreatePlayer(supabase: AdminClient, discordId: string, displayName: string): Promise<PlayerRow> {
  const { data: existing } = await supabase
    .from("crl6mansqueuebot_players")
    .select("*")
    .eq("discord_id", discordId)
    .maybeSingle();

  if (existing) {
    if (existing.display_name !== displayName) {
      await supabase.from("crl6mansqueuebot_players").update({ display_name: displayName }).eq("id", existing.id);
      return { ...existing, display_name: displayName };
    }
    return existing;
  }

  const { data: created, error } = await supabase
    .from("crl6mansqueuebot_players")
    .insert({ discord_id: discordId, display_name: displayName })
    .select("*")
    .single();
  if (error || !created) throw new Error(`Failed to create player: ${error?.message}`);
  return created;
}

export async function isPlayerLockedInActiveSeries(supabase: AdminClient, playerId: string): Promise<boolean> {
  // Checks both series_lobby (pre-team-formation) and series_players (post-team-formation) —
  // teamFormation.ts's finalizeTeams deletes the player's lobby row the moment a series flips
  // from 'forming' to 'active', so series_lobby alone would falsely unlock a player as soon as
  // teams are set, well before their match is actually reported.
  const [{ data: lobbyRows }, { data: seriesPlayerRows }] = await Promise.all([
    supabase.from("crl6mansqueuebot_series_lobby").select("series_id").eq("player_id", playerId),
    supabase.from("crl6mansqueuebot_series_players").select("series_id").eq("player_id", playerId),
  ]);
  const seriesIds = [...new Set([...(lobbyRows ?? []).map((r) => r.series_id), ...(seriesPlayerRows ?? []).map((r) => r.series_id)])];
  if (seriesIds.length === 0) return false;

  const { data: activeSeries } = await supabase
    .from("crl6mansqueuebot_series")
    .select("id")
    .in("id", seriesIds)
    .in("status", ["forming", "active"]);
  return (activeSeries?.length ?? 0) > 0;
}

// Same lobby∪series_players lookup as isPlayerLockedInActiveSeries, but returns the series
// row itself rather than a boolean — used by /sub and /abandon to resolve "the caller's
// match" by membership instead of by channel. queue_channel_id is a shared rank/universal
// queue channel, not a per-match channel, so multiple concurrently forming/active series can
// have the same queue_channel_id; a player can only be locked into one at a time, so
// membership is the unambiguous key (mirrors report.ts's own resolution, which never used
// channel inference at all).
export async function getLockedSeriesForPlayer(supabase: AdminClient, playerId: string): Promise<SeriesRow | null> {
  const [{ data: lobbyRows }, { data: seriesPlayerRows }] = await Promise.all([
    supabase.from("crl6mansqueuebot_series_lobby").select("series_id").eq("player_id", playerId),
    supabase.from("crl6mansqueuebot_series_players").select("series_id").eq("player_id", playerId),
  ]);
  const seriesIds = [...new Set([...(lobbyRows ?? []).map((r) => r.series_id), ...(seriesPlayerRows ?? []).map((r) => r.series_id)])];
  if (seriesIds.length === 0) return null;

  const { data } = await supabase
    .from("crl6mansqueuebot_series")
    .select("*")
    .in("id", seriesIds)
    .in("status", ["forming", "active"])
    .maybeSingle();
  return data;
}

// ---------------------------------------------------------------------------
// /q, /queue (join) and /l, /leave (leave) — channel-inferred queue type via the
// crl6mansqueuebot_queue_messages mapping set up by /setqueuechannel. Replies ephemerally to
// the caller (confirmation or error); the public queue-state message is a separate,
// delete-and-repost message — see refreshQueueMessage above.
// ---------------------------------------------------------------------------

export function handleQueueJoinCommand(interaction: DiscordInteraction) {
  after(() => processQueueCommand(interaction, "join"));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

export function handleQueueLeaveCommand(interaction: DiscordInteraction) {
  after(() => processQueueCommand(interaction, "leave"));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processQueueCommand(interaction: DiscordInteraction, action: "join" | "leave") {
  const supabase = createAdminClient();
  const discordId = interactionUserId(interaction);
  if (!discordId) {
    await editOriginalResponse(interaction.token, { content: "Couldn't identify you — try again." });
    return;
  }
  const channelId = interaction.channel_id;
  if (!channelId) {
    await editOriginalResponse(interaction.token, { content: "Run this inside a queue channel." });
    return;
  }

  const { data: msgRow } = await supabase
    .from("crl6mansqueuebot_queue_messages")
    .select("queue_type")
    .eq("channel_id", channelId)
    .maybeSingle();
  if (!msgRow) {
    await editOriginalResponse(interaction.token, {
      content: "This channel isn't set up as a queue channel — ask an admin to run /setqueuechannel here.",
    });
    return;
  }
  const queueType = msgRow.queue_type as QueueType;

  const player = await getOrCreatePlayer(supabase, discordId, interactionDisplayName(interaction));

  if (action === "leave") {
    const { data, error } = await supabase.rpc("crl6mansqueuebot_leave_queue", {
      p_queue_type: queueType,
      p_player_id: player.id,
    });
    if (error) {
      console.error("leave_queue rpc failed", error);
      await editOriginalResponse(interaction.token, { content: "Something went wrong — try again." });
      return;
    }
    const result = data?.[0];
    if (result?.status === "not_queued") {
      await editOriginalResponse(interaction.token, { content: `You're not in the ${QUEUE_LABELS[queueType]}.` });
      return;
    }
    await refreshQueueMessage(supabase, queueType, `<@${discordId}> has left the ${QUEUE_LABELS[queueType]}.`);
    await deleteOriginalResponse(interaction.token);
    return;
  }

  // action === "join"
  if (await isPlayerLockedInActiveSeries(supabase, player.id)) {
    await editOriginalResponse(interaction.token, {
      content: "You're already locked into an active series — finish or report that first.",
    });
    return;
  }

  const { data, error } = await supabase.rpc("crl6mansqueuebot_join_queue", {
    p_queue_type: queueType,
    p_player_id: player.id,
  });
  if (error) {
    console.error("join_queue rpc failed", error);
    await editOriginalResponse(interaction.token, { content: "Something went wrong — try again." });
    return;
  }
  const result = data?.[0];

  if (result?.status === "already_queued") {
    await editOriginalResponse(interaction.token, { content: `You're already in the ${QUEUE_LABELS[queueType]}.` });
    return;
  }
  if (result?.status === "full") {
    await editOriginalResponse(interaction.token, {
      content: `The ${QUEUE_LABELS[queueType]} is full — try again in a moment.`,
    });
    return;
  }

  if (result?.status === "joined" && result.queue_size >= 6) {
    const guildId = interaction.guild_id ?? (await getGuildId());
    await handlePop(supabase, queueType, guildId, channelId);
    // Pop succeeded — delete the deferred response so it auto-dismisses
    await deleteOriginalResponse(interaction.token);
  } else if (result?.status === "joined") {
    let headline = `<@${discordId}> has joined the ${QUEUE_LABELS[queueType]}!`;

    // If this is the first join (queue size was 0, now 1), mention the configured role
    if (result.queue_size === 1) {
      const { data: mentionRoleRow } = await supabase
        .from("crl6mansqueuebot_queue_mention_roles")
        .select("role_id")
        .eq("queue_type", queueType)
        .maybeSingle() as any;

      if (mentionRoleRow?.role_id) {
        headline = `<@&${mentionRoleRow.role_id}> — ${headline}`;
      }
    }

    await refreshQueueMessage(supabase, queueType, headline);
    await deleteOriginalResponse(interaction.token);
  }
}

// ---------------------------------------------------------------------------
// Pop: lock the 6 players in, cross-remove from the other queue, create the series
// + match category/text channel (see CLAUDE.md, "Match channels (created per series
// on pop)").
// ---------------------------------------------------------------------------


async function handlePop(supabase: AdminClient, queueType: QueueType, guildId: string, queueChannelId: string) {
  const members = await fetchQueueMembers(supabase, queueType);
  const playerIds = members.map((m) => m.id);

  const { data: season } = await supabase
    .from("crl6mansqueuebot_seasons")
    .select("id")
    .eq("is_active", true)
    .maybeSingle();

  if (!season) {
    console.error("Pop triggered but no active season exists — leaving players queued until an admin fixes this");
    return;
  }

  const { data: series, error: seriesError } = await supabase
    .from("crl6mansqueuebot_series")
    .insert({ season_id: season.id, queue_type: queueType, status: "forming", queue_channel_id: queueChannelId })
    .select("id")
    .single();
  if (seriesError || !series) {
    console.error("Failed to create series on pop", seriesError);
    return;
  }

  // Assign match number based on count of reported series
  const { count: reportedCount } = await supabase
    .from("crl6mansqueuebot_series")
    .select("id", { count: "exact", head: true })
    .eq("status", "reported");
  const matchNumber = reportedCount ?? 0;
  await supabase.from("crl6mansqueuebot_series").update({ match_number: matchNumber } as any).eq("id", series.id);

  await supabase
    .from("crl6mansqueuebot_series_lobby")
    .insert(playerIds.map((playerId) => ({ series_id: series.id, player_id: playerId })));

  await supabase.from("crl6mansqueuebot_queue_members").delete().eq("queue_type", queueType).in("player_id", playerIds);

  const otherQueueType: QueueType = queueType === "rank" ? "universal" : "rank";
  const { data: crossRemoved } = await supabase
    .from("crl6mansqueuebot_queue_members")
    .delete()
    .eq("queue_type", otherQueueType)
    .in("player_id", playerIds)
    .select("player_id");

  // Don't refresh queue message here — the vote embed will be posted in the queue channel
  // by createMatchChannels, and we don't want to send a "0 members" message after pop
  if (crossRemoved && crossRemoved.length > 0) {
    await refreshQueueMessage(supabase, otherQueueType);
    const crossRemovedIds = new Set(crossRemoved.map((r) => r.player_id));
    await Promise.all(
      members
        .filter((m) => crossRemovedIds.has(m.id))
        .map((m) =>
          sendDirectMessage(
            m.discord_id,
            `Your ${QUEUE_LABELS[queueType]} popped, so you've been pulled out of the ${QUEUE_LABELS[otherQueueType]} too.`,
          ),
        ),
    );
  }

  await createMatchChannels(supabase, series.id, guildId, members, queueChannelId);
}

export async function createMatchChannels(supabase: AdminClient, seriesId: string, guildId: string, members: PlayerRow[], queueChannelId: string) {
  try {
    await startTeamFormation(supabase, guildId, seriesId, queueChannelId, members);
  } catch (err) {
    console.error(`Failed to start team formation for series ${seriesId}`, err);
    await postTrackedQueueMessage(
      supabase,
      queueChannelId,
      {
        color: 0xef476f,
        description: "**Error:** Failed to start team formation. Ask an admin to check logs.",
      },
      "error",
      true,
    );
  }
}

export async function createVoiceChannels(
  supabase: AdminClient,
  seriesId: string,
  guildId: string,
  teamA: PlayerRow[],
  teamB: PlayerRow[],
  matchNumber?: number,
) {
  const adminRoleIds = await getAdminRoleIds();
  const botUserId = process.env.DISCORD_APPLICATION_ID;
  // Use match number if available, otherwise fall back to short series ID
  const channelIdSuffix = matchNumber != null ? `Match #${matchNumber}` : seriesId.slice(0, 7);

  // Fetch admin-specified call category from config
  const { data: categoryConfig } = await supabase
    .from("crl6mansqueuebot_config")
    .select("value")
    .eq("key", "6mans_call_category_id")
    .maybeSingle();

  const categoryId = categoryConfig?.value;
  if (!categoryId) {
    console.error(`6-mans call category not configured for series ${seriesId}`);
    return;
  }

  const voiceOverwrites = (teamMembers: PlayerRow[]): PermissionOverwrite[] => [
    { id: guildId, type: ROLE_TYPE, deny: VIEW_CHANNEL.toString() },
    // Test bots use synthetic discord_ids (e.g. "test_bot_..."), not real snowflakes — Discord's
    // API rejects the entire channel-creation request if any permission_overwrites id isn't a
    // real snowflake, so they must be excluded here rather than just skipped elsewhere.
    ...teamMembers
      .filter((m) => !m.is_test_data)
      .map((m) => ({ id: m.discord_id, type: MEMBER_TYPE, allow: (VIEW_CHANNEL | CONNECT).toString() }) as PermissionOverwrite),
    ...adminRoleIds.map((roleId) => ({ id: roleId, type: ROLE_TYPE, allow: (VIEW_CHANNEL | CONNECT).toString() }) as PermissionOverwrite),
    ...(botUserId ? [{ id: botUserId, type: MEMBER_TYPE, allow: (VIEW_CHANNEL | CONNECT).toString() } as PermissionOverwrite] : []),
  ];

  try {
    const voiceA = (await discordFetch(`/guilds/${guildId}/channels`, {
      method: "POST",
      body: JSON.stringify({ name: `Team Blue - ${channelIdSuffix}`, type: 2, parent_id: categoryId, permission_overwrites: voiceOverwrites(teamA) }),
    })) as { id: string };
    const voiceB = (await discordFetch(`/guilds/${guildId}/channels`, {
      method: "POST",
      body: JSON.stringify({ name: `Team Orange - ${channelIdSuffix}`, type: 2, parent_id: categoryId, permission_overwrites: voiceOverwrites(teamB) }),
    })) as { id: string };

    await supabase
      .from("crl6mansqueuebot_series")
      .update({ voice_channel_a_id: voiceA.id, voice_channel_b_id: voiceB.id })
      .eq("id", seriesId);
  } catch (err) {
    console.error(`Failed to create voice channels for series ${seriesId}`, err);
  }
}

// ---------------------------------------------------------------------------
// /setqueuechannel — bootstrap to post the queue message in a channel and map it to a queue
// type for /q, /queue, /l, /leave to look up. Owner-or-admin-role gated (see
// lib/discord/admin.ts) — this creates/overwrites the channel's tracked bot message, so it
// shouldn't be open to any member.
// ---------------------------------------------------------------------------

export function handleSetQueueChannelCommand(interaction: DiscordInteraction) {
  const queueTypeOption = interaction.data?.options?.find((o) => o.name === "queue_type")?.value;
  const channelId = interaction.channel_id;
  after(() => processSetQueueChannel(interaction, queueTypeOption, channelId));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processSetQueueChannel(
  interaction: DiscordInteraction,
  queueTypeRaw: string | number | boolean | undefined,
  channelId: string | undefined,
) {
  if (!(await hasAdminAccess(interaction))) {
    await editOriginalResponse(interaction.token, { content: "You don't have admin access." });
    return;
  }
  if (!channelId || (queueTypeRaw !== "rank" && queueTypeRaw !== "universal")) {
    await editOriginalResponse(interaction.token, { content: "Invalid queue_type or channel." });
    return;
  }
  await initQueueMessage(queueTypeRaw, channelId);
  await editOriginalResponse(interaction.token, { content: `Queue message set up for ${QUEUE_LABELS[queueTypeRaw]}.` });
}

// ---------------------------------------------------------------------------
// /set6manscallcategory — specify the Discord category where match voice channels
// are created. Owner-or-admin-role gated.
// ---------------------------------------------------------------------------

export function handleSet6mansCallCategoryCommand(interaction: DiscordInteraction) {
  const categoryIdParam = interaction.data?.options?.find((o) => o.name === "category")?.value;
  after(() => processSet6mansCallCategory(interaction, categoryIdParam));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processSet6mansCallCategory(interaction: DiscordInteraction, categoryIdParamRaw: string | number | boolean | undefined) {
  if (!(await hasAdminAccess(interaction))) {
    await editOriginalResponse(interaction.token, { content: "You don't have admin access." });
    return;
  }

  let categoryId: string | undefined;
  if (categoryIdParamRaw) {
    categoryId = String(categoryIdParamRaw);
  } else if (interaction.channel_id) {
    // If no parameter, use the parent category of the current channel
    try {
      const channel = (await discordFetch(`/channels/${interaction.channel_id}`)) as { parent_id?: string };
      categoryId = channel.parent_id;
    } catch (err) {
      console.error("Failed to fetch channel details", err);
    }
  }

  if (!categoryId) {
    await editOriginalResponse(interaction.token, { content: "Could not determine category. Run this in a channel inside the category you want to use." });
    return;
  }

  const supabase = createAdminClient();
  await supabase.from("crl6mansqueuebot_config").upsert({ key: "6mans_call_category_id", value: categoryId });
  await editOriginalResponse(interaction.token, { content: `6-mans call category set to <#${categoryId}>.` });
}

// ---------------------------------------------------------------------------
// /setreportchannel — specify the Discord channel where match results are posted.
// Owner-or-admin-role gated.
// ---------------------------------------------------------------------------

export function handleSetReportChannelCommand(interaction: DiscordInteraction) {
  const channelIdParam = interaction.data?.options?.find((o) => o.name === "channel")?.value;
  after(() => processSetReportChannel(interaction, channelIdParam));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processSetReportChannel(interaction: DiscordInteraction, channelIdParamRaw: string | number | boolean | undefined) {
  if (!(await hasAdminAccess(interaction))) {
    await editOriginalResponse(interaction.token, { content: "You don't have admin access." });
    return;
  }

  const channelId = channelIdParamRaw ? String(channelIdParamRaw) : interaction.channel_id;

  if (!channelId) {
    await editOriginalResponse(interaction.token, { content: "Could not determine channel. Run this in the channel you want to use as the report channel." });
    return;
  }

  const supabase = createAdminClient();
  await supabase.from("crl6mansqueuebot_config").upsert({ key: "report_channel_id", value: channelId });
  await editOriginalResponse(interaction.token, { content: `Report channel set to <#${channelId}>.` });
}

// ---------------------------------------------------------------------------
// /setqueuementionrole — specify the Discord role to mention when the first
// player joins a queue. Owner-or-admin-role gated.
// ---------------------------------------------------------------------------

export function handleSetQueueMentionRoleCommand(interaction: DiscordInteraction) {
  const queueTypeOption = interaction.data?.options?.find((o) => o.name === "queue_type")?.value;
  const roleIdOption = interaction.data?.options?.find((o) => o.name === "role")?.value;
  after(() => processSetQueueMentionRole(interaction, queueTypeOption, roleIdOption));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processSetQueueMentionRole(
  interaction: DiscordInteraction,
  queueTypeRaw: string | number | boolean | undefined,
  roleIdRaw: string | number | boolean | undefined,
) {
  if (!(await hasAdminAccess(interaction))) {
    await editOriginalResponse(interaction.token, { content: "You don't have admin access." });
    return;
  }

  if (queueTypeRaw !== "rank" && queueTypeRaw !== "universal") {
    await editOriginalResponse(interaction.token, { content: "Invalid queue_type. Use 'rank' or 'universal'." });
    return;
  }

  const roleId = roleIdRaw ? String(roleIdRaw) : undefined;
  if (!roleId) {
    await editOriginalResponse(interaction.token, { content: "You must specify a role." });
    return;
  }

  const supabase = createAdminClient();
  const queueType = queueTypeRaw as QueueType;
  await supabase.from("crl6mansqueuebot_queue_mention_roles").upsert(
    { queue_type: queueType, role_id: roleId } as any,
    { onConflict: "queue_type" }
  );
  await editOriginalResponse(interaction.token, { content: `${QUEUE_LABELS[queueType]} mention role set to <@&${roleId}>.` });
}
