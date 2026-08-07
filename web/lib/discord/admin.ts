import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { discordFetch, BRAND_COLOR } from "./rest";
import { getConfigValue } from "./config";
import { interactionUserId, type DiscordInteraction } from "./types";

// A single before/after pair for the change-log embed logAdminAction posts (see
// postChangeLogEmbed below). "before" is null when there was no prior value (first-ever set).
export type ChangeEntry = { field: string; before: string | null; after: string };

export async function getAdminRoleIds(): Promise<string[]> {
  const supabase = createAdminClient();
  const { data } = await supabase.from("crl6mansqueuebot_admin_roles").select("role_id");
  return (data ?? []).map((r) => r.role_id);
}

async function isGuildOwner(discordUserId: string, guildId: string): Promise<boolean> {
  const guild = (await discordFetch(`/guilds/${guildId}`)) as { owner_id: string };
  return guild.owner_id === discordUserId;
}

// Owner access is checked last (it costs a REST call; the role check is free, already on the
// interaction payload) — this ordering is also what makes "only the owner has admin access
// until a role is granted" happen automatically, with no bootstrap special-casing needed.
export async function hasAdminAccess(interaction: DiscordInteraction): Promise<boolean> {
  const userId = interactionUserId(interaction);
  if (!userId || !interaction.guild_id) return false;

  const memberRoles = interaction.member?.roles ?? [];
  if (memberRoles.length > 0) {
    const adminRoleIds = await getAdminRoleIds();
    if (memberRoles.some((r) => adminRoleIds.includes(r))) return true;
  }

  return isGuildOwner(userId, interaction.guild_id);
}

export async function addAdminRole(roleId: string, addedBy: string) {
  const supabase = createAdminClient();
  await supabase.from("crl6mansqueuebot_admin_roles").upsert({ role_id: roleId, added_by: addedBy });
}

export async function removeAdminRole(roleId: string): Promise<boolean> {
  const supabase = createAdminClient();
  const { data } = await supabase.from("crl6mansqueuebot_admin_roles").delete().eq("role_id", roleId).select("role_id");
  return (data?.length ?? 0) > 0;
}

export async function listAdminRoles() {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("crl6mansqueuebot_admin_roles")
    .select("*")
    .order("added_at", { ascending: true });
  return data ?? [];
}

// `changes` carries structured before/after values for the change-log embed (see
// postChangeLogEmbed) — most call sites still only pass a free-text `details` string, which
// keeps working exactly as before (all existing call sites are untouched). When both are
// omitted `details` is derived from `changes` so `/admin audit-log`'s text listing still shows
// something useful. `logChannelIdOverride` exists only for /admin reset and /admin full-reset,
// which delete crl6mansqueuebot_config (and thus log_channel_id) as part of what they're
// logging — they read the channel id before wiping and pass it through here so the action that
// destroys the log channel's own config can still be posted to it.
export async function logAdminAction(
  actorDiscordId: string,
  action: string,
  target?: string,
  details?: string,
  changes?: ChangeEntry[],
  logChannelIdOverride?: string,
) {
  const supabase = createAdminClient();
  const derivedDetails =
    details ?? (changes && changes.length > 0 ? changes.map((c) => `${c.field}: ${c.before ?? "(unset)"} -> ${c.after}`).join("; ") : undefined);

  await supabase.from("crl6mansqueuebot_audit_log").insert({
    actor_discord_id: actorDiscordId,
    action,
    target: target ?? null,
    details: derivedDetails ?? null,
  });

  // Best-effort: a failure here (missing log channel, Discord API hiccup, bot lacking
  // channel access) must never surface to the caller — logAdminAction is awaited mid-flow by
  // ~30 command handlers that shouldn't fail their actual work over a logging embed.
  try {
    await postChangeLogEmbed(actorDiscordId, action, target, derivedDetails, changes, logChannelIdOverride);
  } catch (err) {
    console.error("Failed to post admin change-log embed", err);
  }
}

function humanizeAction(action: string): string {
  return action
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function postChangeLogEmbed(
  actorDiscordId: string,
  action: string,
  target: string | undefined,
  details: string | undefined,
  changes: ChangeEntry[] | undefined,
  logChannelIdOverride: string | undefined,
) {
  const channelId = logChannelIdOverride ?? (await getConfigValue("log_channel_id"));
  if (!channelId) return;

  const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 3)}...` : s);

  const fields: { name: string; value: string; inline?: boolean }[] = [{ name: "Actor", value: `<@${actorDiscordId}>`, inline: true }];
  if (target) fields.push({ name: "Target", value: truncate(target, 1024), inline: true });

  if (changes && changes.length > 0) {
    // Discord caps embeds at 25 fields total — Actor/Target above already use up to 2.
    for (const c of changes.slice(0, 23)) {
      fields.push({ name: truncate(c.field, 256), value: truncate(`${c.before ?? "*(unset)*"} → ${c.after}`, 1024) });
    }
  } else if (details) {
    fields.push({ name: "Details", value: truncate(details, 1024) });
  }

  await discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      embeds: [
        {
          color: BRAND_COLOR,
          title: humanizeAction(action),
          fields,
          timestamp: new Date().toISOString(),
        },
      ],
    }),
  });
}
