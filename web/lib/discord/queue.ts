import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PlayerRow, QueueType } from "@/lib/supabase/types";
import { discordFetch, sendDirectMessage, editOriginalResponse, getGuildId, BRAND_COLOR } from "./rest";
import { getAdminRoleIds, hasAdminAccess } from "./admin";
import { VIEW_CHANNEL, SEND_MESSAGES, ROLE_TYPE, MEMBER_TYPE, type PermissionOverwrite } from "./permissions";
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
    await editOriginalResponse(interaction.token, { content: `Left the ${QUEUE_LABELS[queueType]}.` });
    await refreshQueueMessage(supabase, queueType, `<@${discordId}> has left the ${QUEUE_LABELS[queueType]}.`);
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

  await editOriginalResponse(interaction.token, {
    content: `Joined the ${QUEUE_LABELS[queueType]} (${result?.queue_size ?? "?"}/6).`,
  });

  if (result?.status === "joined" && result.queue_size >= 6) {
    const guildId = interaction.guild_id ?? (await getGuildId());
    await handlePop(supabase, queueType, guildId);
  } else {
    await refreshQueueMessage(supabase, queueType, `<@${discordId}> has joined the ${QUEUE_LABELS[queueType]}!`);
  }
}

// ---------------------------------------------------------------------------
// Pop: lock the 6 players in, cross-remove from the other queue, create the series
// + match category/text channel (see CLAUDE.md, "Match channels (created per series
// on pop)").
// ---------------------------------------------------------------------------

async function handlePop(supabase: AdminClient, queueType: QueueType, guildId: string) {
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
    .insert({ season_id: season.id, queue_type: queueType, status: "forming" })
    .select("id")
    .single();
  if (seriesError || !series) {
    console.error("Failed to create series on pop", seriesError);
    return;
  }

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

  await refreshQueueMessage(supabase, queueType);
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

  await createMatchChannels(supabase, series.id, guildId, members);
}

export async function createMatchChannels(supabase: AdminClient, seriesId: string, guildId: string, members: PlayerRow[]) {
  const adminRoleIds = await getAdminRoleIds();
  const botUserId = process.env.DISCORD_APPLICATION_ID;
  const shortId = seriesId.slice(0, 8);

  // Discord does NOT inherit a category's permission overwrites onto a child channel
  // unless the child's overwrites are byte-identical to the parent's ("synced"). Since the
  // text channel below adds its own SEND_MESSAGES denies, it's unsynced — so the VIEW_CHANNEL
  // deny/allow set has to be repeated explicitly on the text channel too, or @everyone falls
  // back to the guild default (visible) instead of inheriting the category's private setting.
  const baseOverwrites: PermissionOverwrite[] = [
    { id: guildId, type: ROLE_TYPE, deny: VIEW_CHANNEL.toString() },
    ...members.map((m) => ({ id: m.discord_id, type: MEMBER_TYPE, allow: VIEW_CHANNEL.toString() }) as PermissionOverwrite),
    ...adminRoleIds.map((roleId) => ({ id: roleId, type: ROLE_TYPE, allow: VIEW_CHANNEL.toString() }) as PermissionOverwrite),
  ];
  if (botUserId) {
    // Explicit SEND grant, not just VIEW — if the guild denies @everyone Send Messages
    // (common for a locked-down community server), the bot would otherwise be unable to
    // post into the very channel it just created and message-locked the 6 players out of.
    baseOverwrites.push({
      id: botUserId,
      type: MEMBER_TYPE,
      allow: (VIEW_CHANNEL | SEND_MESSAGES).toString(),
    });
  }

  const category = (await discordFetch(`/guilds/${guildId}/channels`, {
    method: "POST",
    body: JSON.stringify({ name: `Match ${shortId}`, type: 4, permission_overwrites: baseOverwrites }),
  })) as { id: string };

  // Discord allows only one overwrite object per id per channel (allow/deny bits share the
  // same object) — the members' entries here replace, not append to, their baseOverwrites ones.
  const memberDiscordIds = new Set(members.map((m) => m.discord_id));
  const textOverwrites: PermissionOverwrite[] = [
    ...baseOverwrites.filter((o) => !memberDiscordIds.has(o.id)),
    ...members.map(
      (m) => ({ id: m.discord_id, type: MEMBER_TYPE, allow: VIEW_CHANNEL.toString(), deny: SEND_MESSAGES.toString() }) as PermissionOverwrite,
    ),
  ];

  const textChannel = (await discordFetch(`/guilds/${guildId}/channels`, {
    method: "POST",
    body: JSON.stringify({
      name: `match-${shortId}`,
      type: 0,
      parent_id: category.id,
      permission_overwrites: textOverwrites,
    }),
  })) as { id: string };

  await supabase
    .from("crl6mansqueuebot_series")
    .update({ category_id: category.id, text_channel_id: textChannel.id })
    .eq("id", seriesId);

  const mentions = members.map((m) => `<@${m.discord_id}>`).join(" ");
  await discordFetch(`/channels/${textChannel.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: `${mentions}\nYour lobby has popped! The match channel has been created — vote for team formation below.`,
    }),
  });

  await startTeamFormation(supabase, guildId, seriesId, textChannel.id, members);
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
