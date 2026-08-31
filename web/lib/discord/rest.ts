import "server-only";
import { InteractionResponseFlags } from "discord-interactions";
import { getConfigValue } from "./config";

const DISCORD_API_BASE = "https://discord.com/api/v10";

// Shared accent color for the bot's embeds (queue status, vote, teams-formed) — matches the
// design the user provided reference screenshots for.
export const BRAND_COLOR = 0x57f287;

// Win-streak announcement embed color — see CLAUDE.md, "MMR / Elo" (streak bonus).
export const AMBER_COLOR = 0xffbf00;

// Supercharged (Bonus Day) colors — see CLAUDE.md, "Weekly bonus day". SUPERCHARGED_ANNOUNCE_COLOR
// is the bright-purple border on the standalone "today is supercharged" embed posted alongside the
// first-queue-join ping, and (per explicit request) on rich mode's join card too, so the two read
// as the same celebration when they sit next to each other in the queue channel;
// SUPERCHARGED_COLOR is the lighter purple every normally-BRAND_COLOR (green) gameplay embed —
// queue status, hybrid announcements, team formation, report summaries — swaps to for the day.
export const SUPERCHARGED_ANNOUNCE_COLOR = 0x9b30ff;
export const SUPERCHARGED_COLOR = 0xc9a0ff;

// Scheduled-season-reset auto-fire announcement embed — see CLAUDE.md, "Seasons".
export const GOLD_COLOR = 0xffd700;

// "Rich" queue-message mode's per-event announcement colors — Discord-native green/red for a
// join vs. a leave (see CLAUDE.md, "Queue channels"). Overridden by SUPERCHARGED_ANNOUNCE_COLOR on a
// bonus day, same precedent every other queue-status embed already follows.
export const RICH_JOIN_COLOR = 0x3ba55d;
export const RICH_LEAVE_COLOR = 0xed4245;
export const RICH_INACTIVITY_COLOR = 0xffa500;

// Bot-token REST calls — used for anything outside the 15-minute interaction-webhook
// window (editing the persistent queue message later, creating match channels, etc).
// Interaction responses/follow-ups themselves go through the interaction webhook instead.
// Only a 429 is ever retried. A 403 (missing permission, or a member above the bot in the role
// hierarchy — the guild owner can never be renamed by a bot at all) will fail identically
// forever, and retrying it just burns invalid requests: Discord temp-bans an IP after 10,000
// 401/403/429s in 10 minutes, which on Vercel's shared egress is not an IP we control.
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_MAX_WAIT_SECONDS = 30;

export async function discordFetch(path: string, init: RequestInit = {}) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("Missing DISCORD_BOT_TOKEN");
  }

  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(`${DISCORD_API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });

    if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
      // Discord reports the wait in seconds, in the body for bucketed limits and in the header
      // for Cloudflare-level ones. Capped so a long global limit surfaces as an error instead of
      // silently holding the function open.
      const body = (await res.json().catch(() => null)) as { retry_after?: number } | null;
      const headerWait = Number(res.headers.get("retry-after") ?? Number.NaN);
      const wait = body?.retry_after ?? (Number.isFinite(headerWait) ? headerWait : 1);
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, RATE_LIMIT_MAX_WAIT_SECONDS) * 1000));
      continue;
    }

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`Discord API ${init.method ?? "GET"} ${path} failed: ${res.status} ${errorBody}`);
    }

    if (res.status === 204) {
      return null;
    }

    return res.json();
  }
}

// Best-effort DM — swallows failures (DMs closed, user left the server, etc.) since a
// failed notification shouldn't break the caller's main flow. Returns whether it succeeded
// so callers that need a fallback (e.g. the captains-draft DM prompt in teamFormation.ts)
// can react to a closed-DMs case instead of silently doing nothing.
export async function sendDirectMessage(
  discordId: string,
  content: string,
  components?: unknown[],
  embeds?: unknown[],
): Promise<boolean> {
  try {
    const dmChannel = (await discordFetch("/users/@me/channels", {
      method: "POST",
      body: JSON.stringify({ recipient_id: discordId }),
    })) as { id: string };

    const body: any = { content };
    if (components) body.components = components;
    if (embeds) body.embeds = embeds;

    await discordFetch(`/channels/${dmChannel.id}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
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
  // Check if guild ID is set in the database config
  const configGuildId = await getConfigValue("discord_guild_id");
  if (configGuildId) {
    cachedGuildId = configGuildId;
    return cachedGuildId;
  }
  const guilds = (await discordFetch("/users/@me/guilds")) as { id: string }[];
  if (guilds.length !== 1) {
    throw new Error(`Expected the bot to be in exactly 1 guild, found ${guilds.length} — set DISCORD_GUILD_ID or use /admin setguildid.`);
  }
  cachedGuildId = guilds[0].id;
  return cachedGuildId;
}

// See bands.ts's reconcileMemberRole: fetches what the member actually holds right now, rather
// than trusting our own band/is_prism columns to say which role they're wearing (a Prism holder's
// `band` column still reads their underlying band, and a previously-failed add/remove leaves the
// DB and Discord disagreeing) — the fix has to check reality, not just infer it.
export async function getMemberRoles(guildId: string, userId: string): Promise<string[]> {
  const member = (await discordFetch(`/guilds/${guildId}/members/${userId}`)) as { roles: string[] };
  return member.roles;
}

export type DiscordGuildMember = {
  user: { id: string; avatar: string | null; username: string; global_name: string | null };
  avatar: string | null;
  nick: string | null;
};

// Paginates the full guild member list (limit=1000 per Discord's max, cursor = highest user id
// seen so far) — requires the Server Members privileged intent to be enabled for this
// application in the Developer Portal, gated by Discord on this REST endpoint even without a
// gateway connection. One request covers the whole server at this community's size, so both
// daily jobs that need every member's nickname (avatars.ts, nicknameSync.ts) read it here
// rather than fetching members one at a time.
export async function listAllGuildMembers(guildId: string): Promise<DiscordGuildMember[]> {
  const members: DiscordGuildMember[] = [];
  let after = "0";
  for (;;) {
    const batch = (await discordFetch(`/guilds/${guildId}/members?limit=1000&after=${after}`)) as DiscordGuildMember[];
    members.push(...batch);
    if (batch.length < 1000) return members;
    after = batch[batch.length - 1].user.id;
  }
}

// null clears the nickname entirely (the member falls back to their account display name),
// which is different from "" — Discord treats an empty string the same way but null is the
// documented form. Requires MANAGE_NICKNAMES and the bot ranking above the target.
export async function setMemberNickname(guildId: string, userId: string, nick: string | null) {
  await discordFetch(`/guilds/${guildId}/members/${userId}`, {
    method: "PATCH",
    body: JSON.stringify({ nick }),
  });
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

// Posts an additional ephemeral message via the interaction's webhook token — used when a
// single response would exceed Discord's 2000-char message limit (e.g. /admin config get's
// full listing) and the content needs to span multiple messages. Only valid within the same
// 15-minute interaction-token window as editOriginalResponse.
export async function sendFollowupMessage(interactionToken: string, body: Record<string, unknown>) {
  const appId = process.env.DISCORD_APPLICATION_ID;
  if (!appId) throw new Error("Missing DISCORD_APPLICATION_ID");

  const res = await fetch(`https://discord.com/api/v10/webhooks/${appId}/${interactionToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ flags: InteractionResponseFlags.EPHEMERAL, ...body }),
  });
  if (!res.ok) {
    console.error("Failed to send followup interaction response", await res.text());
  }
}

export async function deleteOriginalResponse(interactionToken: string) {
  const appId = process.env.DISCORD_APPLICATION_ID;
  if (!appId) throw new Error("Missing DISCORD_APPLICATION_ID");

  const res = await fetch(`https://discord.com/api/v10/webhooks/${appId}/${interactionToken}/messages/@original`, {
    method: "DELETE",
  });
  if (!res.ok) {
    console.error("Failed to delete original interaction response", await res.text());
  }
}

let rankEmojiCache: Map<string, string | null> | null = null;

export async function getRankEmoji(band: string | null): Promise<string> {
  // Load cache if not already loaded (once per instance)
  if (!rankEmojiCache) {
    rankEmojiCache = new Map();
    try {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const supabase = createAdminClient();
      const { data } = await supabase.from("crl6mansqueuebot_rank_emoji").select("*");
      if (data) {
        for (const row of data as any) {
          rankEmojiCache.set(row.band, row.emoji_id);
        }
      }
    } catch (err) {
      console.error("Failed to load rank emoji cache", err);
    }
  }

  if (!band) {
    const unrankedId = rankEmojiCache.get("Unranked");
    return unrankedId ? `<:rank_unranked:${unrankedId}>` : "❓";
  }

  const emojiId = rankEmojiCache.get(band);
  if (emojiId) {
    return `<:rank_${band.toLowerCase()}:${emojiId}>`;
  }

  // Fallback emoji if not configured
  const fallbacks: Record<string, string> = {
    Iron: "⚒️",
    Garnet: "💎",
    Emerald: "💚",
    Sapphire: "💙",
    Prism: "⭐",
    Unranked: "❓",
  };
  return fallbacks[band] || "❓";
}
