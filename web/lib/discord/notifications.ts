import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendDirectMessage, editOriginalResponse, discordFetch, deleteOriginalResponse } from "./rest";
import { hasAdminAccess, logAdminAction } from "./admin";
import { interactionUserId, interactionDisplayName, type DiscordInteraction } from "./types";
import type { QueueType } from "@/lib/supabase/types";

const QUEUE_LABELS: Record<QueueType, string> = {
  rank: "Rank Queue",
  universal: "Universal Queue",
};

const NOTIFICATION_MESSAGE_CONTENT = {
  embeds: [
    {
      title: "🔔 Queue Notifications",
      description: "Toggle your notifications for each queue type by clicking below:\n\nYour settings are saved to your Discord roles and are persistent.",
      color: 0xff8238,
    },
  ],
  components: [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          custom_id: "notification:rank",
          label: "🎮 Rank Queue Notifications",
        },
        {
          type: 2,
          style: 1,
          custom_id: "notification:universal",
          label: "🎮 Universal Queue Notifications",
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// /setnotificationchannel — post the notification preference message to a channel
// ---------------------------------------------------------------------------

export function handleSetNotificationChannelCommand(interaction: DiscordInteraction) {
  after(() => processSetNotificationChannel(interaction));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processSetNotificationChannel(interaction: DiscordInteraction) {
  if (!(await hasAdminAccess(interaction))) {
    await editOriginalResponse(interaction.token, { content: "You don't have admin access." });
    return;
  }

  const channelId = interaction.channel_id;
  if (!channelId) {
    await editOriginalResponse(interaction.token, { content: "Could not determine channel." });
    return;
  }

  const supabase = createAdminClient();

  try {
    // Post the notification preference message
    const message = (await discordFetch(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify(NOTIFICATION_MESSAGE_CONTENT),
    })) as { id: string };

    // Store the message ID for persistence
    await supabase.from("crl6mansqueuebot_notification_messages").upsert(
      { channel_id: channelId, message_id: message.id } as any,
      { onConflict: "channel_id" }
    );

    await editOriginalResponse(interaction.token, {
      content: `Notification preference message posted to <#${channelId}>.`,
    });
  } catch (err) {
    console.error("Failed to post notification message", err);
    await editOriginalResponse(interaction.token, { content: "Failed to post notification message." });
  }
}

// ---------------------------------------------------------------------------
// /setnotificationrole — configure which role is used for notifications
// ---------------------------------------------------------------------------

export function handleSetNotificationRoleCommand(interaction: DiscordInteraction) {
  const queueTypeOption = interaction.data?.options?.find((o) => o.name === "queue_type")?.value;
  const roleIdOption = interaction.data?.options?.find((o) => o.name === "role")?.value;
  after(() => processSetNotificationRole(interaction, queueTypeOption, roleIdOption));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processSetNotificationRole(
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

  try {
    await supabase.from("crl6mansqueuebot_notification_roles").upsert(
      { queue_type: queueType, role_id: roleId } as any,
      { onConflict: "queue_type" }
    );

    await editOriginalResponse(interaction.token, {
      content: `${QUEUE_LABELS[queueType]} notification role set to <@&${roleId}>.`,
    });
  } catch (err) {
    console.error("Failed to set notification role", err);
    await editOriginalResponse(interaction.token, { content: "Failed to set notification role." });
  }
}

// ---------------------------------------------------------------------------
// Notification button handlers
// ---------------------------------------------------------------------------

export function handleNotificationButton(interaction: DiscordInteraction, queueType: QueueType) {
  after(() => processNotificationButton(interaction, queueType));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processNotificationButton(interaction: DiscordInteraction, queueType: QueueType) {
  const userId = interactionUserId(interaction);
  const guildId = interaction.guild_id;

  if (!userId || !guildId) {
    await sendEphemeralNotificationEmbed(interaction.token, {
      title: "❌ Error",
      description: "Could not identify you or determine guild.",
      color: 0xef476f,
    });
    return;
  }

  const supabase = createAdminClient();

  try {
    // Fetch the notification role for this queue type
    const { data: roleConfig } = (await supabase
      .from("crl6mansqueuebot_notification_roles")
      .select("role_id")
      .eq("queue_type", queueType)
      .maybeSingle()) as any;

    if (!roleConfig?.role_id) {
      return await sendEphemeralNotificationEmbed(interaction.token, {
        title: "⚠️ Not Configured",
        description: `${QUEUE_LABELS[queueType]} notifications are not configured yet. Ask an admin to set them up.`,
        color: 0xef476f,
      });
    }

    const roleId = roleConfig.role_id;

    // Check if user has the role
    const memberRes = (await discordFetch(`/guilds/${guildId}/members/${userId}`)) as { roles: string[] } | undefined;
    const hasRole = memberRes?.roles?.includes(roleId) ?? false;

    // Toggle the role
    if (hasRole) {
      // Remove role
      await discordFetch(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, { method: "DELETE" });
      await sendEphemeralNotificationEmbed(interaction.token, {
        title: "🔕 Disabled",
        description: `${QUEUE_LABELS[queueType]} notifications have been disabled.\n\nYou will no longer receive notifications for this queue.`,
        color: 0x97979f,
      });
    } else {
      // Add role
      await discordFetch(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
        method: "PUT",
        body: JSON.stringify({}),
      });
      await sendEphemeralNotificationEmbed(interaction.token, {
        title: "🔔 Enabled",
        description: `${QUEUE_LABELS[queueType]} notifications have been enabled.\n\nYou'll now receive notifications when players are queuing.`,
        color: 0xff8238,
      });
    }
  } catch (err) {
    console.error(`Failed to toggle notification role for ${queueType}`, err);
    await sendEphemeralNotificationEmbed(interaction.token, {
      title: "❌ Error",
      description: "Something went wrong. Try again later.",
      color: 0xef476f,
    });
  }
}

async function sendEphemeralNotificationEmbed(
  token: string,
  embed: { title: string; description: string; color: number }
) {
  // Send the embed response
  await editOriginalResponse(token, {
    embeds: [embed],
  });

  // Delete after 10 seconds
  setTimeout(async () => {
    try {
      await deleteOriginalResponse(token);
    } catch (err) {
      console.error("Failed to delete ephemeral notification message", err);
    }
  }, 10000);
}
