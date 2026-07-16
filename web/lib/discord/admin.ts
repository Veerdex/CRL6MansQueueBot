import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { discordFetch } from "./rest";
import { interactionUserId, type DiscordInteraction } from "./types";

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

export async function logAdminAction(actorDiscordId: string, action: string, target?: string, details?: string) {
  const supabase = createAdminClient();
  await supabase.from("crl6mansqueuebot_audit_log").insert({
    actor_discord_id: actorDiscordId,
    action,
    target: target ?? null,
    details: details ?? null,
  });
}
