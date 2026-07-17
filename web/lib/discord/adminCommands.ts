import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { editOriginalResponse } from "./rest";
import { hasAdminAccess, addAdminRole, removeAdminRole, listAdminRoles, logAdminAction } from "./admin";
import { interactionUserId, type DiscordInteraction } from "./types";

function deferredEphemeral(run: () => Promise<void>) {
  after(run);
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

function getRoleOption(interaction: DiscordInteraction): string | null {
  const value = interaction.data?.options?.find((o) => o.name === "role")?.value;
  return typeof value === "string" ? value : null;
}

// ---------------------------------------------------------------------------
// /add-admin-role, /remove-admin-role, /list-admin-roles — owner-or-admin-role gated
// (see lib/discord/admin.ts, hasAdminAccess). Roles granted here also get match-category/
// channel visibility — see queue.ts, createMatchChannels.
// ---------------------------------------------------------------------------

export function handleAddAdminRoleCommand(interaction: DiscordInteraction) {
  return deferredEphemeral(() => processAddAdminRole(interaction));
}

async function processAddAdminRole(interaction: DiscordInteraction) {
  const actorId = interactionUserId(interaction);
  if (!actorId) {
    await editOriginalResponse(interaction.token, { content: "Couldn't identify you — try again." });
    return;
  }
  if (!(await hasAdminAccess(interaction))) {
    await editOriginalResponse(interaction.token, { content: "You don't have admin access." });
    return;
  }
  const roleId = getRoleOption(interaction);
  if (!roleId) {
    await editOriginalResponse(interaction.token, { content: "Missing role." });
    return;
  }
  await addAdminRole(roleId, actorId);
  await logAdminAction(actorId, "add_admin_role", roleId);
  await editOriginalResponse(interaction.token, {
    content: `<@&${roleId}> now has admin access and visibility into match channels.`,
  });
}

export function handleRemoveAdminRoleCommand(interaction: DiscordInteraction) {
  return deferredEphemeral(() => processRemoveAdminRole(interaction));
}

async function processRemoveAdminRole(interaction: DiscordInteraction) {
  const actorId = interactionUserId(interaction);
  if (!actorId) {
    await editOriginalResponse(interaction.token, { content: "Couldn't identify you — try again." });
    return;
  }
  if (!(await hasAdminAccess(interaction))) {
    await editOriginalResponse(interaction.token, { content: "You don't have admin access." });
    return;
  }
  const roleId = getRoleOption(interaction);
  if (!roleId) {
    await editOriginalResponse(interaction.token, { content: "Missing role." });
    return;
  }
  const removed = await removeAdminRole(roleId);
  if (!removed) {
    await editOriginalResponse(interaction.token, { content: `<@&${roleId}> didn't have admin access.` });
    return;
  }
  await logAdminAction(actorId, "remove_admin_role", roleId);
  await editOriginalResponse(interaction.token, { content: `Removed admin access from <@&${roleId}>.` });
}

export function handleListAdminRolesCommand(interaction: DiscordInteraction) {
  return deferredEphemeral(() => processListAdminRoles(interaction));
}

async function processListAdminRoles(interaction: DiscordInteraction) {
  if (!(await hasAdminAccess(interaction))) {
    await editOriginalResponse(interaction.token, { content: "You don't have admin access." });
    return;
  }
  const roles = await listAdminRoles();
  const content = roles.length
    ? roles.map((r) => `<@&${r.role_id}> — added by <@${r.added_by}>`).join("\n")
    : "No admin roles set yet — only the server owner has admin access.";
  await editOriginalResponse(interaction.token, { content });
}

// ---------------------------------------------------------------------------
// /help — public. Shows the admin command section only if the caller currently has
// admin access, since those commands would just error out for anyone else.
// ---------------------------------------------------------------------------

export function handleHelpCommand(interaction: DiscordInteraction) {
  return deferredEphemeral(() => processHelp(interaction));
}

async function processHelp(interaction: DiscordInteraction) {
  const isAdmin = await hasAdminAccess(interaction);

  const lines = [
    "**Commands**",
    "`/q` or `/queue` — join the queue mapped to the current channel (e.g. #universal-queue, #rank-queue).",
    "`/l` or `/leave` — leave that queue.",
    "`/vote-default mode:<balanced|captains>` — set your default team-formation vote (still overridable per game).",
    "`/report` — run inside your match channel to report the result (inferred from your own team). Settles immediately.",
    "`/sub nominee:<@user>` — run inside your match channel to nominate a replacement; they must accept via a button.",
    "`/abandon target:<@user>` — run inside your match channel to vote a player as abandoned. 3 votes cancels the series.",
    "`/help` — show this message.",
  ];

  if (isAdmin) {
    lines.push(
      "",
      "**Admin commands**",
      "`/setqueuechannel queue_type:<rank|universal>` — post the persistent queue message in the current channel.",
      "`/add-admin-role role:<@role>` — grant a role admin access and match-channel visibility.",
      "`/remove-admin-role role:<@role>` — revoke a role's admin access.",
      "`/list-admin-roles` — list roles with admin access.",
      "`/newseason` — close the current season (if any) and start the next one.",
      "`/setbandrole band:<Iron|Garnet|Emerald|Sapphire|Unranked|Prism> role:<@role>` — map a band (or the Unranked role, or the season-end Prism Top 10 role) to a Discord role for auto role-sync.",
      "`/test-rank-match` / `/test-universal-match` — spin up a simulated match (you + 5 test bots) to try the flow yourself.",
      "`/end-test` — run inside a test match's channel to tear it down (category, voice channels, text channel, and its test data).",
    );
  }

  await editOriginalResponse(interaction.token, { content: lines.join("\n") });
}
