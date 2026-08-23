import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { discordFetch, getGuildId } from "./rest";
import { stripClanTag } from "./types";

// Same pattern as seasonClose.ts's fetchAllPages/chunk — duplicated rather than imported since
// it's a tiny, generic helper and seasonClose.ts keeps it module-private (see CLAUDE.md's note
// on this project's existing small-helper duplication precedent, e.g. register-commands.mjs's
// CONFIG_KEYS). PostgREST silently truncates unbounded selects past a project row cap, so any
// select that can grow with the player count needs to be paged.
const PAGE_SIZE = 1000;
const ID_CHUNK = 200;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function fetchAllPages<T>(page: (from: number, to: number) => PromiseLike<T[]>): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const batch = await page(from, from + PAGE_SIZE - 1);
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
    from += PAGE_SIZE;
  }
}

type DiscordGuildMember = {
  user: { id: string; avatar: string | null; username: string; global_name: string | null };
  avatar: string | null;
  nick: string | null;
};

// Same nickname-first, tag-stripped preference as interactionDisplayName (types.ts) — kept in
// sync deliberately, since this is the bulk/lazy path for players who haven't run a command
// (and so haven't hit getOrCreatePlayer's live update) since setting or changing their nickname.
function resolveDisplayName(member: DiscordGuildMember): string {
  const candidates = [member.nick, member.user.global_name, member.user.username];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const stripped = stripClanTag(candidate);
    if (stripped) return stripped;
  }
  return "Unknown";
}

// Builds a ready-to-use CDN URL so the website never needs Discord-specific URL logic: prefers
// the member's per-server avatar, falls back to their account-wide avatar, then Discord's
// deterministic default avatar (index derived from the snowflake — the current, post-Pomelo
// formula; the old modulo-5-on-discriminator formula no longer applies to users on the new
// username system, which is effectively everyone now).
function buildAvatarUrl(guildId: string, userId: string, member: DiscordGuildMember): string {
  const animated = (hash: string) => hash.startsWith("a_");
  if (member.avatar) {
    const ext = animated(member.avatar) ? "gif" : "png";
    return `https://cdn.discordapp.com/guilds/${guildId}/users/${userId}/avatars/${member.avatar}.${ext}`;
  }
  if (member.user.avatar) {
    const ext = animated(member.user.avatar) ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${userId}/${member.user.avatar}.${ext}`;
  }
  const defaultIndex = Number((BigInt(userId) >> BigInt(22)) % BigInt(6));
  return `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
}

// Paginates the full guild member list (limit=1000 per Discord's max, cursor = highest user id
// seen so far) — requires the Server Members privileged intent to be enabled for this
// application in the Developer Portal, gated by Discord on this REST endpoint even without a
// gateway connection.
async function listAllGuildMembers(guildId: string): Promise<DiscordGuildMember[]> {
  const members: DiscordGuildMember[] = [];
  let after = "0";
  for (;;) {
    const batch = (await discordFetch(`/guilds/${guildId}/members?limit=1000&after=${after}`)) as DiscordGuildMember[];
    members.push(...batch);
    if (batch.length < 1000) return members;
    after = batch[batch.length - 1].user.id;
  }
}

export type AvatarRefreshSummary = { updated: number; skipped: number; renamed: number };

// Daily job (see CLAUDE.md, "Match time stats" precedent for this project's cron pattern) —
// re-fetches every real player's current server avatar and nickname and writes them onto their
// row, so a player who changes their pfp or nickname shows the new one on the website within a
// day without any per-request Discord API calls (display_name otherwise only updates lazily, the
// next time that player runs a command — see queue.ts's getOrCreatePlayer). Test-data players are
// excluded — their discord_ids aren't real guild members, same treatment as recomputeBands().
export async function refreshPlayerAvatars(): Promise<AvatarRefreshSummary> {
  const supabase = createAdminClient();
  const guildId = await getGuildId();

  const members = await listAllGuildMembers(guildId);
  const memberByDiscordId = new Map(members.map((m) => [m.user.id, m]));

  const players = await fetchAllPages((from, to) =>
    supabase
      .from("crl6mansqueuebot_players")
      .select("id, discord_id, display_name")
      .eq("is_test_data", false)
      .range(from, to)
      .then(({ data }) => data ?? []),
  );

  const summary: AvatarRefreshSummary = { updated: 0, skipped: 0, renamed: 0 };
  const updates = players.flatMap((p) => {
    const member = memberByDiscordId.get(p.discord_id);
    if (!member) {
      summary.skipped += 1;
      return [];
    }
    const avatarUrl = buildAvatarUrl(guildId, p.discord_id, member);
    const displayName = resolveDisplayName(member);
    return [{ id: p.id, avatarUrl, displayName, renamed: displayName !== p.display_name }];
  });

  // Per-row updates (not a bulk upsert) — same precedent as seasonClose.ts's MMR decay write,
  // since PostgREST upsert would otherwise require satisfying the table's Insert type (discord_id,
  // display_name) for a call that only ever touches existing rows. Chunked to bound concurrency
  // at a reasonable fan-out rather than firing every request at once.
  for (const batch of chunk(updates, ID_CHUNK)) {
    await Promise.all(
      batch.map(async ({ id, avatarUrl, displayName, renamed }) => {
        const { error } = await supabase
          .from("crl6mansqueuebot_players")
          .update({ avatar_url: avatarUrl, display_name: displayName })
          .eq("id", id);
        if (error) {
          console.error(`Failed to refresh avatar/name for player ${id}`, error);
          return;
        }
        summary.updated += 1;
        if (renamed) summary.renamed += 1;
      }),
    );
  }

  return summary;
}
