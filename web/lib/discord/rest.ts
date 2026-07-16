import "server-only";

const DISCORD_API_BASE = "https://discord.com/api/v10";

// Bot-token REST calls — used for anything outside the 15-minute interaction-webhook
// window (editing the persistent queue message later, creating match channels, etc).
// Interaction responses/follow-ups themselves go through the interaction webhook instead.
export async function discordFetch(path: string, init: RequestInit = {}) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("Missing DISCORD_BOT_TOKEN");
  }

  const res = await fetch(`${DISCORD_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Discord API ${init.method ?? "GET"} ${path} failed: ${res.status} ${errorBody}`);
  }

  if (res.status === 204) {
    return null;
  }

  return res.json();
}

// Best-effort DM — swallows failures (DMs closed, user left the server, etc.) since a
// failed notification shouldn't break the caller's main flow. Returns whether it succeeded
// so callers that need a fallback (e.g. the captains-draft DM prompt in teamFormation.ts)
// can react to a closed-DMs case instead of silently doing nothing.
export async function sendDirectMessage(discordId: string, content: string, components?: unknown[]): Promise<boolean> {
  try {
    const dmChannel = (await discordFetch("/users/@me/channels", {
      method: "POST",
      body: JSON.stringify({ recipient_id: discordId }),
    })) as { id: string };
    await discordFetch(`/channels/${dmChannel.id}/messages`, {
      method: "POST",
      body: JSON.stringify(components ? { content, components } : { content }),
    });
    return true;
  } catch (err) {
    console.error(`Failed to DM ${discordId}`, err);
    return false;
  }
}

let cachedGuildId: string | null = null;

// This bot is single-server (see scripts/register-commands.mjs, which auto-detects the same
// way) — background jobs like the daily band recompute have no interaction payload to pull
// guild_id from, so they resolve it here instead. DISCORD_GUILD_ID overrides if ever set
// (e.g. if the bot joins a second guild). Cached at module scope since it doesn't change
// within a warm serverless instance.
export async function getGuildId(): Promise<string> {
  if (process.env.DISCORD_GUILD_ID) return process.env.DISCORD_GUILD_ID;
  if (cachedGuildId) return cachedGuildId;
  const guilds = (await discordFetch("/users/@me/guilds")) as { id: string }[];
  if (guilds.length !== 1) {
    throw new Error(`Expected the bot to be in exactly 1 guild, found ${guilds.length} — set DISCORD_GUILD_ID explicitly.`);
  }
  cachedGuildId = guilds[0].id;
  return cachedGuildId;
}

export async function addMemberRole(guildId: string, userId: string, roleId: string) {
  await discordFetch(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, { method: "PUT" });
}

export async function removeMemberRole(guildId: string, userId: string, roleId: string) {
  await discordFetch(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, { method: "DELETE" });
}

// Edits the deferred ACK sent for a command/component interaction. Uses the interaction's
// own webhook token (embedded in the URL, no bot-token auth needed) rather than discordFetch
// — this is a different Discord auth mechanism, and the token expires after 15 minutes, so
// it's only ever used for the immediate follow-up to a still-live interaction, never for
// later edits (those go through discordFetch + a stored message ID instead).
export async function editOriginalResponse(interactionToken: string, body: Record<string, unknown>) {
  const appId = process.env.DISCORD_APPLICATION_ID;
  if (!appId) throw new Error("Missing DISCORD_APPLICATION_ID");

  const res = await fetch(`https://discord.com/api/v10/webhooks/${appId}/${interactionToken}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error("Failed to edit original interaction response", await res.text());
  }
}
