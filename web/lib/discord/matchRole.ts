import "server-only";
import { discordFetch, getGuildId, addMemberRole, removeMemberRole } from "./rest";
import { computePreviewMatchNumber } from "./matchNumber";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PlayerRow, SeriesRow } from "@/lib/supabase/types";

type AdminClient = ReturnType<typeof createAdminClient>;

// ---------------------------------------------------------------------------
// The temporary per-match role — see migration 0053_match_role.sql for why it's created per
// match instead of drawn from a fixed pool.
//
// Every function here fails open: if anything at all goes wrong, the series is left with a null
// match_role_id and both ping sites fall back to the six individual `<@user>` mentions they used
// before this existed. That matters more than usual right now, because the column only exists
// once 0053 is applied by hand to production Supabase — the code can legitimately be live
// against a database without it, and must keep working when it is.
// ---------------------------------------------------------------------------

export const MATCH_ROLE_PREFIX = "Match #";

// Anchored, and the number is required — the sweep reclaim deletes whatever this matches, so a
// bare prefix test is too loose to point a destructive pass at. An admin role literally called
// "Match #" or "Match #1 Stuff" is not touched.
export const MATCH_ROLE_NAME_PATTERN = /^Match #\d+$/;

// A role has to survive its own creation window before the reclaim pass may delete it. The id is
// written to the series row within milliseconds of the role existing, but those are two separate
// round trips, and a sweep tick landing between them would otherwise see an unreferenced
// `Match #n` role and delete it out from under a match that is still forming — leaving the ping
// pointing at `@deleted-role` and nobody notified. Ten minutes is far longer than that gap can
// plausibly be, and a genuinely leaked role simply waits one extra tick.
export const MATCH_ROLE_MIN_RECLAIM_AGE_MS = 10 * 60 * 1000;

// Fixed saturation/lightness so a random hue can never land on something unreadable — the user
// asked for "random color of the rainbow (not too white and not too black)". At S 0.75 / L 0.55
// every channel stays inside [54, 226] for every hue, so the result is always a saturated mid
// tone and can never be 0, which Discord treats as "no color" rather than black.
const MATCH_ROLE_SATURATION = 0.75;
const MATCH_ROLE_LIGHTNESS = 0.55;

export function matchRoleName(matchNumber: number): string {
  return `${MATCH_ROLE_PREFIX}${matchNumber}`;
}

// Discord snowflake -> creation time. Top 42 bits are milliseconds since the Discord epoch.
// BigInt() calls rather than `22n`/`…n` literals — this project targets below ES2020, where the
// literal form is a compile error.
const DISCORD_EPOCH_MS = 1420070400000;

export function roleCreatedAtMs(roleId: string): number {
  return Number((BigInt(roleId) >> BigInt(22)) + BigInt(DISCORD_EPOCH_MS));
}

function hslToRgbInt(hueDegrees: number, saturation: number, lightness: number): number {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = hueDegrees / 60;
  const secondary = chroma * (1 - Math.abs((sector % 2) - 1));
  const [r, g, b] =
    sector < 1 ? [chroma, secondary, 0]
    : sector < 2 ? [secondary, chroma, 0]
    : sector < 3 ? [0, chroma, secondary]
    : sector < 4 ? [0, secondary, chroma]
    : sector < 5 ? [secondary, 0, chroma]
    : [chroma, 0, secondary];
  const offset = lightness - chroma / 2;
  const channel = (v: number) => Math.round((v + offset) * 255);
  return (channel(r) << 16) | (channel(g) << 8) | channel(b);
}

// Pure, and takes its randomness as a parameter so the test can sweep every hue.
export function rainbowRoleColor(random: () => number = Math.random): number {
  return hslToRgbInt(random() * 360, MATCH_ROLE_SATURATION, MATCH_ROLE_LIGHTNESS);
}

// Best-effort teardown of a role we created but don't want (creation failed partway, or the
// write-back failed). Never throws — the caller is already on an error path.
async function discardRole(supabase: AdminClient, seriesId: string, guildId: string, roleId: string) {
  await discordFetch(`/guilds/${guildId}/roles/${roleId}`, { method: "DELETE" }).catch((err) =>
    console.error(`Match role: could not discard role ${roleId} for series ${seriesId}`, err),
  );
  await supabase
    .from("crl6mansqueuebot_series")
    .update({ match_role_id: null } as never)
    .eq("id", seriesId);
}

// Creates the role and puts it on all six players. Returns the role id, or null to mean "fall
// back to individual mentions" — which is every failure case, including a partial one.
//
// All-or-nothing on the assigns is the point: if five of six succeed, the role ping goes out and
// the sixth player is silently never notified, which is strictly worse than today's behavior.
// Any assign failing therefore unwinds the whole thing. discordFetch already retries 429s on its
// own (6 attempts / 30s budget), so a rate-limited burst doesn't fall straight through to the
// fallback.
export async function createMatchRole(
  supabase: AdminClient,
  seriesId: string,
  guildId: string,
  members: PlayerRow[],
): Promise<string | null> {
  let roleId: string | null = null;
  try {
    // Synthetic dev-panel players have no real Discord account to assign a role to, and a test
    // series must not consume a slot against the guild's 250-role cap either.
    if (members.some((m) => m.is_test_data)) return null;
    const discordIds = members.map((m) => m.discord_id).filter(Boolean);
    if (discordIds.length === 0) return null;

    const { data: series } = await supabase
      .from("crl6mansqueuebot_series")
      .select("created_at, is_test_data")
      .eq("id", seriesId)
      .maybeSingle();
    if (!series || (series as { is_test_data?: boolean }).is_test_data) return null;

    const matchNumber = await computePreviewMatchNumber(supabase, (series as { created_at: string }).created_at);

    const role = (await discordFetch(`/guilds/${guildId}/roles`, {
      method: "POST",
      body: JSON.stringify({
        name: matchRoleName(matchNumber),
        color: rainbowRoleColor(),
        // The whole point — a non-mentionable role can only be pinged by someone holding
        // MENTION_EVERYONE, and the ping has to work from an ordinary bot message.
        mentionable: true,
        permissions: "0",
        hoist: false,
      }),
    })) as { id: string };
    roleId = role.id;

    // Write the id back *before* the assigns. The reclaim pass identifies a stray as "a
    // `Match #n` role no series row points at", so the row has to point at it as early as
    // possible — the age floor covers only this one round trip.
    const { error } = await supabase
      .from("crl6mansqueuebot_series")
      .update({ match_role_id: roleId } as never)
      .eq("id", seriesId);
    if (error) throw new Error(`could not persist match_role_id: ${error.message}`);

    await Promise.all(discordIds.map((discordId) => addMemberRole(guildId, discordId, roleId as string)));
    return roleId;
  } catch (err) {
    console.error(`Match role: creation failed for series ${seriesId}, falling back to individual mentions`, err);
    if (roleId) await discardRole(supabase, seriesId, guildId, roleId);
    return null;
  }
}

// The six participants' Discord ids, read fresh so a substitution is reflected.
async function fetchParticipantDiscordIds(supabase: AdminClient, seriesId: string): Promise<string[]> {
  const { data: seriesPlayers } = await supabase
    .from("crl6mansqueuebot_series_players")
    .select("player_id")
    .eq("series_id", seriesId);
  if (!seriesPlayers || seriesPlayers.length === 0) return [];
  const { data: players } = await supabase
    .from("crl6mansqueuebot_players")
    .select("discord_id, is_test_data")
    .in("id", seriesPlayers.map((sp) => sp.player_id));
  return (players ?? []).filter((p) => !p.is_test_data).map((p) => p.discord_id);
}

// Rewrites the permanent "Teams formed!" message's content line from the role ping back to the
// plain mentions, so channel history doesn't fill up with "@deleted-role — teams are formed!"
// once the role is gone. Must run before the role is deleted only in the sense that it must run
// at all; Discord never re-notifies on an edit, so this cannot re-ping anyone.
//
// Plain `<@id>` rather than the fire/cold-decorated mentions the message was posted with: those
// decorations described a streak state that was current at pop time, and re-deriving them at
// teardown would stamp the wrong one onto the record. The embed underneath carries the real
// rosters either way.
async function restoreTeamsFormedMentions(supabase: AdminClient, series: SeriesRow, messageId: string) {
  if (!series.queue_channel_id) return;
  const discordIds = await fetchParticipantDiscordIds(supabase, series.id);
  if (discordIds.length === 0) return;
  await discordFetch(`/channels/${series.queue_channel_id}/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify({ content: `${discordIds.map((id) => `<@${id}>`).join(" ")} — teams are formed!` }),
  });
}

// Teardown. Atomically claims the role id off the series row before touching Discord, so report
// and the sweep racing each other can't both try to delete it, and so a caller holding a stale
// or narrowly-selected row can't miss one. Never throws: channel teardown must not be blocked by
// a role failure.
export async function releaseMatchRole(supabase: AdminClient, series: SeriesRow) {
  try {
    const { data: current } = await supabase
      .from("crl6mansqueuebot_series")
      .select("match_role_id, teams_formed_message_id")
      .eq("id", series.id)
      .maybeSingle();
    const roleId = (current as { match_role_id?: string | null } | null)?.match_role_id;
    if (!roleId) return;

    // The claim: whoever nulls the column wins and is the only one that deletes the role.
    const { data: claimed } = await supabase
      .from("crl6mansqueuebot_series")
      .update({ match_role_id: null } as never)
      .eq("id", series.id)
      .eq("match_role_id", roleId)
      .select("id");
    if (!claimed || claimed.length === 0) return;

    const messageId = (current as { teams_formed_message_id?: string | null } | null)?.teams_formed_message_id;
    if (messageId) {
      await restoreTeamsFormedMentions(supabase, series, messageId).catch((err) =>
        console.error(`Match role: could not restore mentions on the teams-formed message for series ${series.id}`, err),
      );
    }

    // Deleting the role strips it from all six members in one call — no per-member removal.
    await discordFetch(`/guilds/${await getGuildId()}/roles/${roleId}`, { method: "DELETE" });
  } catch (err) {
    console.error(`Match role: release failed for series ${series.id}`, err);
  }
}

// /sub: move the role from the departing player to their replacement, so the next ping on this
// series reaches the people actually in it. Best-effort — a failure here costs a ping, not a seat.
export async function swapMatchRoleHolder(
  supabase: AdminClient,
  seriesId: string,
  leavingDiscordId: string,
  joiningDiscordId: string,
) {
  try {
    const { data: series } = await supabase
      .from("crl6mansqueuebot_series")
      .select("match_role_id")
      .eq("id", seriesId)
      .maybeSingle();
    const roleId = (series as { match_role_id?: string | null } | null)?.match_role_id;
    if (!roleId) return;

    const guildId = await getGuildId();
    await addMemberRole(guildId, joiningDiscordId, roleId).catch((err) =>
      console.error(`Match role: could not add ${roleId} to substitute ${joiningDiscordId}`, err),
    );
    await removeMemberRole(guildId, leavingDiscordId, roleId).catch((err) =>
      console.error(`Match role: could not remove ${roleId} from ${leavingDiscordId}`, err),
    );
  } catch (err) {
    console.error(`Match role: swap failed for series ${seriesId}`, err);
  }
}

// Sweep pass. Load-bearing rather than tidy-up: this guild sits at ~204 of Discord's hard 250
// roles per guild, and hitting that ceiling blocks every role creation server-wide, band roles
// included. Deletes any `Match #n` role past the age floor that no series row claims.
export async function reclaimStrayMatchRoles(supabase: AdminClient): Promise<number> {
  const guildId = await getGuildId();
  const roles = (await discordFetch(`/guilds/${guildId}/roles`)) as { id: string; name: string }[];

  const cutoff = Date.now() - MATCH_ROLE_MIN_RECLAIM_AGE_MS;
  const candidates = roles.filter((r) => MATCH_ROLE_NAME_PATTERN.test(r.name) && roleCreatedAtMs(r.id) < cutoff);
  if (candidates.length === 0) return 0;

  // Every series still pointing at a role, whatever its status — a reported series whose
  // teardown hasn't run yet still owns its role.
  const { data: live, error } = await supabase
    .from("crl6mansqueuebot_series")
    .select("match_role_id")
    .not("match_role_id", "is", null);
  // Fail closed on a read error: without the claim list every match role looks like a stray.
  if (error) throw new Error(`could not read live match roles: ${error.message}`);
  const claimedIds = new Set((live ?? []).map((s) => (s as { match_role_id: string }).match_role_id));

  let reclaimed = 0;
  for (const role of candidates) {
    if (claimedIds.has(role.id)) continue;
    try {
      await discordFetch(`/guilds/${guildId}/roles/${role.id}`, { method: "DELETE" });
      reclaimed += 1;
    } catch (err) {
      console.error(`Match role: could not reclaim stray role ${role.id} (${role.name})`, err);
    }
  }
  return reclaimed;
}
