import "server-only";
import { after } from "next/server";
import {
  InteractionResponseType,
  InteractionResponseFlags,
  MessageComponentTypes,
  ButtonStyleTypes,
} from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PlayerRow, QueueType } from "@/lib/supabase/types";
import { discordFetch, sendDirectMessage, editOriginalResponse } from "./rest";
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
// Persistent queue status message
// ---------------------------------------------------------------------------

function queueButtons(queueType: QueueType) {
  return [
    {
      type: MessageComponentTypes.ACTION_ROW,
      components: [
        {
          type: MessageComponentTypes.BUTTON,
          style: ButtonStyleTypes.SUCCESS,
          label: "Join Queue",
          custom_id: `queue_join:${queueType}`,
        },
        {
          type: MessageComponentTypes.BUTTON,
          style: ButtonStyleTypes.DANGER,
          label: "Leave Queue",
          custom_id: `queue_leave:${queueType}`,
        },
      ],
    },
  ];
}

function queueMessageContent(queueType: QueueType, members: PlayerRow[]) {
  const lines = members.length ? members.map((m, i) => `${i + 1}. ${m.display_name}`).join("\n") : "_Empty_";
  return `### ${QUEUE_LABELS[queueType]} (${members.length}/6)\n${lines}`;
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

export async function refreshQueueMessage(supabase: AdminClient, queueType: QueueType) {
  const { data: msgRow } = await supabase
    .from("crl6mansqueuebot_queue_messages")
    .select("*")
    .eq("queue_type", queueType)
    .maybeSingle();
  if (!msgRow) return;

  const members = await fetchQueueMembers(supabase, queueType);
  await discordFetch(`/channels/${msgRow.channel_id}/messages/${msgRow.message_id}`, {
    method: "PATCH",
    body: JSON.stringify({
      content: queueMessageContent(queueType, members),
      components: queueButtons(queueType),
    }),
  });
}

export async function initQueueMessage(queueType: QueueType, channelId: string) {
  const supabase = createAdminClient();
  const members = await fetchQueueMembers(supabase, queueType);
  const message = (await discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: queueMessageContent(queueType, members),
      components: queueButtons(queueType),
    }),
  })) as { id: string };

  await supabase.from("crl6mansqueuebot_queue_messages").upsert({
    queue_type: queueType,
    channel_id: channelId,
    message_id: message.id,
  });
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
// Join / Leave button entry point
// ---------------------------------------------------------------------------

export function handleQueueButton(interaction: DiscordInteraction, action: "join" | "leave", queueType: QueueType) {
  after(() => processQueueButton(interaction, action, queueType));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processQueueButton(interaction: DiscordInteraction, action: "join" | "leave", queueType: QueueType) {
  const supabase = createAdminClient();
  const discordId = interactionUserId(interaction);
  if (!discordId) {
    await editOriginalResponse(interaction.token, { content: "Couldn't identify you — try again." });
    return;
  }

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
    await refreshQueueMessage(supabase, queueType);
    await editOriginalResponse(interaction.token, { content: `Left the ${QUEUE_LABELS[queueType]}.` });
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

  if (result?.status === "joined" && result.queue_size >= 6 && interaction.guild_id) {
    await handlePop(supabase, queueType, interaction.guild_id);
  } else {
    await refreshQueueMessage(supabase, queueType);
  }
}

// ---------------------------------------------------------------------------
// Pop: lock the 6 players in, cross-remove from the other queue, create the series
// + match category/text channel (see CLAUDE.md, "Match channels (created per series
// on pop)"). Team formation (vote/draft, voice channels) is Phase 3 — not built yet.
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

async function createMatchChannels(supabase: AdminClient, seriesId: string, guildId: string, members: PlayerRow[]) {
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
      content: `${mentions}\nYour lobby has popped! Vote for team formation below.`,
    }),
  });

  await startTeamFormation(supabase, guildId, seriesId, textChannel.id, members);
}

// ---------------------------------------------------------------------------
// /setqueuechannel — bootstrap to post the persistent message in a queue channel.
// Owner-or-admin-role gated (see lib/discord/admin.ts) — this creates/overwrites the
// channel's persistent bot-edited message, so it shouldn't be open to any member.
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
