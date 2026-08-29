import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PlayerRow, QueueType, SeriesRow } from "@/lib/supabase/types";
import { discordFetch, sendDirectMessage, editOriginalResponse, deleteOriginalResponse, getGuildId, BRAND_COLOR, SUPERCHARGED_COLOR, SUPERCHARGED_ANNOUNCE_COLOR, GOLD_COLOR, RICH_JOIN_COLOR, RICH_LEAVE_COLOR, RICH_INACTIVITY_COLOR, PRISM_JOIN_COLOR, getRankEmoji } from "./rest";
import { getAdminRoleIds, hasAdminAccess, logAdminAction } from "./admin";
import { VIEW_CHANNEL, SEND_MESSAGES, CONNECT, ROLE_TYPE, MEMBER_TYPE, type PermissionOverwrite } from "./permissions";
import { interactionUserId, interactionDisplayName, type DiscordInteraction } from "./types";
import { startTeamFormation, startSeriesLengthVote } from "./teamFormation";
import { computeBonusDayMultiplier, isSuperchargedDayLive } from "./bonusDay";
import { grantUnrankedRoleToNewPlayer } from "./bands";
import { getConfigNumber, getConfigValue } from "./config";
import { getStreakIds, getPriorRankWinStreak, getPriorRankLossStreak, mention, FLAME_THRESHOLD, COLD_THRESHOLD, ON_FIRE_EMOJI, COLD_EMOJI, type StreakIds } from "./streaks";
import { getRankLabel } from "@/lib/leaderboard/rankIcon";

type AdminClient = ReturnType<typeof createAdminClient>;

const QUEUE_LABELS: Record<QueueType, string> = {
  rank: "Rank Queue",
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

async function queueStatusEmbed(queueType: QueueType, members: PlayerRow[], streaks: StreakIds, headline?: string) {
  const label = QUEUE_LABELS[queueType];
  const mentionLine = members.length
    ? members.map((m) => mention(m.discord_id, { onFire: streaks.onFireIds.has(m.id), cold: streaks.coldIds.has(m.id), prism: m.is_prism })).join(" ")
    : "_Empty_";
  const headlineBlock = headline ? `**${headline}**\n\n` : "";
  const color = (await isSuperchargedDayLive()) ? SUPERCHARGED_COLOR : BRAND_COLOR;
  return {
    color,
    description: `${headlineBlock}**Current Queue Members: ${members.length}**\n${mentionLine}`,
    footer: { text: `Run /q to join the ${label} or /l to leave.` },
  };
}

// One-player-per-line roster format (rank emoji + name + band + MMR) — shared by hybrid mode's
// roster message and rich mode's both roster message and "Match Found!" announcement, so the
// three don't drift out of sync with three copies of the same rendering logic.
async function buildRosterLines(members: PlayerRow[], streaks: StreakIds): Promise<string[]> {
  if (!members.length) return ["_Empty_"];
  const scale = await getConfigNumber("mmr_scale", 1);
  const shift = await getConfigNumber("mmr_shift", 0);
  return Promise.all(
    members.map(async (m) => {
      const band = m.is_placed ? m.band : null;
      const emoji = await getRankEmoji(band);
      const who = mention(m.discord_id, { onFire: streaks.onFireIds.has(m.id), cold: streaks.coldIds.has(m.id), prism: m.is_prism });
      const displayMmr = Math.round(m.mmr * scale + shift);
      return `${emoji} ${who} — ${getRankLabel(band)} · ${displayMmr} MMR`;
    }),
  );
}

// Roster embed: one player per line instead of the flat @mention line above. Used by /status
// (a one-off snapshot, any mode), hybrid mode's own tracked roster message (headline lives in
// its own separate, always-stacking announcement instead — see postHybridAnnouncement, so this
// embed is roster-only there), and rich mode's richContext-less fallback (see queueMessageBody —
// now only hit by a headline-less refresh with no single "acting player," e.g. admin force-leave;
// the 6th-join pop no longer falls back to this).
async function hybridRosterEmbed(queueType: QueueType, members: PlayerRow[], streaks: StreakIds) {
  const label = QUEUE_LABELS[queueType];
  const lines = await buildRosterLines(members, streaks);
  const color = (await isSuperchargedDayLive()) ? SUPERCHARGED_COLOR : BRAND_COLOR;
  return {
    color,
    description: `**Current Queue Members: ${members.length}**\n${lines.join("\n")}`,
    footer: { text: `Run /q to join the ${label} or /l to leave.` },
  };
}

// Rich mode's per-join/per-leave message — a single data-rich embed, posted "default"-style (a
// new message per event, nothing deleted — see the mode !== "default" && mode !== "rich" check
// in tryPostAndClaimQueueMessage) since /status already covers "see the whole current roster" on
// demand, so a second, separately-tracked roster message is redundant. Streak counts are the
// acting player's own live numeric streak (not the boolean on-fire/cold flags used for mention
// decoration elsewhere), since the line needs "4-Win Streak" text, not just a yes/no.
//
// Revised this session: the headline used to be a Markdown `###` H3, and Rank/MMR/Streak were
// three separate inline embed fields — Discord's client (especially mobile) both adds real top
// margin above a heading-led description *and* stacks "inline" fields vertically once the embed
// gets narrow, which combined into a lot of dead space and an unnecessarily spread-out card. The
// headline is now plain **bold** text (no built-in heading margin), and Rank/MMR/Streak collapse
// onto one line directly under it — a single rank emoji (getRankEmoji, same one every roster line
// already uses) instead of the band's plain-text name, MMR, and an optional streak suffix, all in
// the embed's `description` rather than separate `fields` blocks, so there's no per-field padding
// between them. Queue Progress stays its own field, and its filled-segment emoji swaps to 🟪 on a
// Bonus Range day (matching the embed's own SUPERCHARGED_ANNOUNCE_COLOR border) instead of always 🟩. The
// streak suffix (`   |   +N Win Streak🔥` / `   |   N Loss Streak🥶`) reuses ON_FIRE_EMOJI/
// COLD_EMOJI from streaks.ts rather than a hardcoded literal, so it's guaranteed to match the same
// emoji used everywhere else in the bot (mention decoration, leaderboard) instead of drifting.
//
// Revised a later session: an `"inactive"` action reuses this same card shape (mention/stat-line/
// progress-bar layout) for the sweep route's auto-remove-after-timeout case, so rich mode gets
// exactly one message per inactive player instead of the roster-refresh-plus-plain-orange-embed
// pair every other mode still posts — see CLAUDE.md, "Queue channels". Color is no longer
// supercharged-overridable for "leave" or "inactive" (only "join" still swaps to
// SUPERCHARGED_ANNOUNCE_COLOR on a bonus day) — leave is always RICH_LEAVE_COLOR (red) and inactive is
// always RICH_INACTIVITY_COLOR (orange), regardless of the day, per explicit request.
async function richEventEmbed(
  supabase: AdminClient,
  action: "join" | "leave" | "inactive",
  player: PlayerRow,
  queueType: QueueType,
  queueSize: number,
): Promise<any> {
  const label = QUEUE_LABELS[queueType];
  const band = player.is_placed ? player.band : null;
  const [scale, shift, rankEmoji, winStreak, lossStreak] = await Promise.all([
    getConfigNumber("mmr_scale", 1),
    getConfigNumber("mmr_shift", 0),
    getRankEmoji(band),
    getPriorRankWinStreak(supabase, player.id),
    getPriorRankLossStreak(supabase, player.id),
  ]);
  const displayMmr = Math.round(player.mmr * scale + shift);

  let statLine = `${rankEmoji} ${displayMmr} MMR`;
  if (winStreak >= FLAME_THRESHOLD) {
    statLine += `   |   +${winStreak} Win Streak${ON_FIRE_EMOJI}`;
  } else if (lossStreak >= COLD_THRESHOLD) {
    statLine += `   |   ${lossStreak} Loss Streak${COLD_EMOJI}`;
  }

  const supercharged = await isSuperchargedDayLive();
  // Leave and inactivity always render in their own fixed color, even on a supercharged day — only
  // join keeps the purple override, since it's the one case worth celebrating. A joining Prism
  // holder's own card wins over even the Bonus Day purple — see CLAUDE.md, "Bands / ranks".
  //
  // Join uses the deeper SUPERCHARGED_ANNOUNCE_COLOR rather than the lighter SUPERCHARGED_COLOR
  // every other gameplay embed swaps to, so the card matches the standalone "Today is a
  // Supercharged Day!" announcement posted above it in the same channel (explicit request).
  const color =
    action === "inactive"
      ? RICH_INACTIVITY_COLOR
      : action === "leave"
        ? RICH_LEAVE_COLOR
        : player.is_prism
          ? PRISM_JOIN_COLOR
          : supercharged
            ? SUPERCHARGED_ANNOUNCE_COLOR
            : RICH_JOIN_COLOR;

  const filled = Math.max(0, Math.min(6, queueSize));
  const filledEmoji = supercharged ? "🟪" : "🟩";
  const progress = `${filledEmoji.repeat(filled)}${"⬛".repeat(6 - filled)}  ${filled}/6`;

  const playerMention = mention(player.discord_id, { onFire: winStreak >= FLAME_THRESHOLD, cold: lossStreak >= COLD_THRESHOLD, prism: player.is_prism });

  // Inactivity is a copy of the leave card's shape (same stat line, same progress bar) with its
  // own headline instead of "left the ... Queue!" — see CLAUDE.md, "Queue channels".
  const headline =
    action === "inactive" ? `**${playerMention} was removed from the ${label} due to inactivity.**` : `**${playerMention} ${action === "join" ? "joined" : "left"} the ${label}!**`;

  return {
    color,
    description: `${headline}\n${statLine}`,
    fields: [{ name: "Queue Progress", value: progress, inline: false }],
    // Join/leave instructions removed — /help already covers that. No footer at all, including
    // on a supercharged day — an earlier version showed ten 🔥 here, removed per direct request.
    thumbnail: player.avatar_url ? { url: player.avatar_url } : undefined,
  };
}

// `headline` (the "<@user> has joined/left..." line) stays in the embed as display text. `ping`
// is the separate first-join role-mention line (e.g. `<@&roleId>`) and is sent as the top-level
// message `content` instead — Discord does not deliver notifications for mentions that appear
// inside an embed, only ones in `content`, so the ping has to live outside the embed to actually
// fire.
//
// Rich mode's `richContext` carries the acting player/action/queueSize needed for richEventEmbed's
// per-player fields. Revised this session — the 6th join (pop) now passes a richContext too, same
// as any other join, so it renders the ordinary join card instead of a roster copy (see the pop
// branch in processQueueCommand). richContext is only absent for a genuinely headline-less refresh
// with no single "acting player" to describe (e.g. admin force-leave), where rich mode still falls
// back to the same roster embed /status returns.
async function queueMessageBody(
  supabase: AdminClient,
  mode: QueueMessageMode,
  queueType: QueueType,
  members: PlayerRow[],
  streaks: StreakIds,
  headline?: string,
  ping?: string,
  richContext?: { action: "join" | "leave" | "inactive"; player: PlayerRow; queueSize: number },
) {
  if (mode === "hybrid") {
    return { content: "", embeds: [await hybridRosterEmbed(queueType, members, streaks)] };
  }
  if (mode === "rich") {
    const embed = richContext
      ? await richEventEmbed(supabase, richContext.action, richContext.player, queueType, richContext.queueSize)
      : await hybridRosterEmbed(queueType, members, streaks);
    return { content: ping ?? "", embeds: [embed] };
  }
  return {
    content: ping ?? "",
    embeds: [await queueStatusEmbed(queueType, members, streaks, headline)],
  };
}

// Hybrid mode's announcement message — "<@user> has joined/left the ... Queue!" posted on its
// own, every join/leave, and intentionally never tracked/deleted: it's a running log of queue
// activity, separate from the single live roster message (hybridRosterEmbed) below it. Carries
// the first-join role ping in `content` (embeds don't notify — see queueMessageBody above).
async function postHybridAnnouncement(channelId: string, headline: string, ping?: string) {
  const color = (await isSuperchargedDayLive()) ? SUPERCHARGED_COLOR : BRAND_COLOR;
  await discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: ping ?? "", embeds: [{ color, description: `**${headline}**` }] }),
  }).catch((err) => console.error(`Failed to post hybrid queue announcement in ${channelId}`, err));
}

// Rich mode's pop-time announcement — a dedicated, always-posted "Match Found!" embed, separate
// from (and in addition to) the roster-copy message queueMessageBody's richContext-less fallback
// already posts as the pop's own single-message-per-event content. Only the *ordinary per-player
// join card* gets replaced by the roster copy at pop — this announcement stays, unchanged from
// before, as the actual "the match is starting" notification. @mentions all 6 players (same
// "must actually notify" precedent as the "Teams formed!" summary and the first-join role ping —
// embed-only mentions never notify).
async function richMatchFoundEmbed(members: PlayerRow[], streaks: StreakIds): Promise<any> {
  const lines = await buildRosterLines(members, streaks);
  return {
    color: GOLD_COLOR,
    description: `### Match Found!\n${lines.join("\n")}`,
    footer: { text: "Forming teams…" },
  };
}

async function postRichMatchFoundAnnouncement(channelId: string, members: PlayerRow[], streaks: StreakIds) {
  const embed = await richMatchFoundEmbed(members, streaks);
  const mentions = members.map((m) => mention(m.discord_id, { prism: m.is_prism })).join(" ");
  await discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: mentions, embeds: [embed] }),
  }).catch((err) => console.error(`Failed to post rich match-found announcement in ${channelId}`, err));
}

// Posted once, alongside the first-join role ping (see the "first join" branch in the /q command
// handler below) — a standalone bright-purple-bordered embed announcing that today is a
// supercharged (Bonus Day) day, so it stands out from the ordinary green/purple queue-status
// embeds around it.
async function postSuperchargedAnnouncement(channelId: string) {
  await discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      embeds: [
        {
          color: SUPERCHARGED_ANNOUNCE_COLOR,
          description: "⚡ **Today is a Supercharged Day!** Rank Queue MMR gains are boosted — queue up while it lasts.",
        },
      ],
    }),
  }).catch((err) => console.error(`Failed to post supercharged announcement in ${channelId}`, err));
}

export async function fetchQueueMembers(supabase: AdminClient, queueType: QueueType): Promise<PlayerRow[]> {
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

export type QueueMessageMode = "simplified" | "default" | "hybrid" | "rich";

// /admin queue-message-mode mode:<simplified|default|hybrid|rich> — see CLAUDE.md-style precedent
// of bot_paused's stop/start and bonus_day_enabled's dedicated toggle in adminTools.ts.
//   - "simplified" (default): exactly one live queue-status message per channel — every
//     join/leave deletes the previous one and posts a fresh combined headline+roster message.
//   - "default": every join/leave posts a new combined headline+roster message without deleting
//     the last one, so the channel keeps a running history instead of pruning down to one.
//   - "hybrid": every join/leave posts two messages — a small headline-only announcement that
//     always stacks (never deleted), plus a one-player-per-line roster message that behaves like
//     "simplified" (single live message, delete-and-repost) EXCEPT the roster posted at the
//     moment a queue pops (6th join) is frozen permanently instead — see
//     freezeQueueRosterMessage — so it stays visible as a record of who played that match.
//   - "rich": one message per join/leave (revised this session — supersedes the earlier
//     two-message "announcement + separately tracked roster" shape, dropped since /status
//     already covers "see the whole current roster" on demand, making the second message
//     redundant): a data-rich embed (richEventEmbed: H3 headline, Rank/MMR/Streak fields, a
//     queue-progress bar), posted "default"-style — a new message per event, nothing deleted, so
//     the channel keeps a running history. At the 6th join (pop), the ordinary per-player join
//     card is what posts — revised again this session, supersedes an intermediate design where
//     the pop instead fell back to a roster-copy embed (/status's shape); reverted back to the
//     plain join card per direct request. That message is still frozen permanently right after —
//     see freezeQueueRosterMessage — so it stays visible as a record of who played that match, and
//     the separate, always-posted gold "Match Found!" announcement (postRichMatchFoundAnnouncement)
//     covers the full 6-player roster regardless of what this message shows. A player auto-removed
//     by the sweep route for inactivity (queue_member_timeout_minutes) also gets exactly one message —
//     the same richEventEmbed card shape, headlined as removed-for-inactivity instead of left, and
//     always RICH_INACTIVITY_COLOR (orange) — rather than the roster-refresh-plus-plain-orange-
//     embed pair every other mode still posts for that case; see CLAUDE.md, "Queue channels".
//

// Reads the new `queue_message_mode` string config first; falls back to the older
// `queue_simplified_messages` boolean (pre-hybrid) so an admin who already toggled that keeps
// their choice honored until they explicitly pick a mode via the new command.
export async function getQueueMessageMode(): Promise<QueueMessageMode> {
  const raw = await getConfigValue("queue_message_mode");
  if (raw === "simplified" || raw === "default" || raw === "hybrid" || raw === "rich") return raw;
  const legacySimplified = (await getConfigNumber("queue_simplified_messages", 1)) !== 0;
  return legacySimplified ? "simplified" : "default";
}

// Posts a fresh message, then atomically claims it as the tracked one for `queueType` before
// deleting the old message — guards against two concurrent refreshes (e.g. two /q joins
// landing at once) both reading the same oldMessageId and each posting their own message,
// which used to leave a duplicate live message in the channel with only the latter tracked in
// the DB (the former orphaned forever). The claim is a CAS keyed on oldMessageId, the same
// atomic UPDATE...WHERE pattern used elsewhere in this codebase (report.ts, teamFormation.ts)
// for settling races — whichever refresh's UPDATE lands second finds message_id has already
// moved and loses the claim, so it deletes its own now-redundant message instead of leaving it
// behind. Returns whether this call won the claim, so callers racing on the same row (see
// refreshQueueMessage) know to retry with a fresh member snapshot rather than silently dropping
// whatever change motivated their refresh.
//
// `mode` gates only the *old, previously-tracked* message's deletion below (kept for "default"
// and "rich" — see queueMessageBody's rich-mode note — deleted for "simplified" and "hybrid") —
// the losing-race cleanup a few lines down always runs regardless, since that's a duplicate this
// exact call itself created (never shown to anyone as "history"), not the old message the mode
// is about preserving.
//
// `oldMessageId === null` means the row currently exists with no live message attached (the state
// freezeQueueRosterMessage puts it in at pop time, instead of reposting an empty placeholder) —
// the CAS claim keys on `message_id is null` in that case, and there's nothing to delete.
async function tryPostAndClaimQueueMessage(
  supabase: AdminClient,
  queueType: QueueType,
  channelId: string,
  oldMessageId: string | null,
  members: PlayerRow[],
  streaks: StreakIds,
  headline: string | undefined,
  mode: QueueMessageMode,
  ping?: string,
  richContext?: { action: "join" | "leave" | "inactive"; player: PlayerRow; queueSize: number },
): Promise<boolean> {
  const message = (await discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify(await queueMessageBody(supabase, mode, queueType, members, streaks, headline, ping, richContext)),
  })) as { id: string };

  let claimQuery = supabase
    .from("crl6mansqueuebot_queue_messages")
    .update({ channel_id: channelId, message_id: message.id })
    .eq("queue_type", queueType);
  claimQuery = oldMessageId === null ? claimQuery.is("message_id", null) : claimQuery.eq("message_id", oldMessageId);
  const { data: claimed, error } = await claimQuery.select("queue_type");
  if (error) console.error(`Queue message claim failed for ${queueType}`, error);

  if (!error && claimed && claimed.length > 0) {
    if (oldMessageId !== null && mode !== "default" && mode !== "rich") {
      await discordFetch(`/channels/${channelId}/messages/${oldMessageId}`, { method: "DELETE" }).catch((err) =>
        console.error(`Failed to delete previous queue message ${oldMessageId}`, err),
      );
    }
    return true;
  }

  // Lost the claim race — another refresh already updated the row. Clean up this now-redundant
  // message rather than leaving an orphaned duplicate live in the channel.
  await discordFetch(`/channels/${channelId}/messages/${message.id}`, { method: "DELETE" }).catch((err) =>
    console.error(`Failed to delete losing-race queue message ${message.id}`, err),
  );
  return false;
}

// Single-shot version for callers with no concurrent-refresh risk (initQueueMessage's
// first-ever /setqueuechannel setup). `oldMessageId === null` means no row exists yet for this
// queue_type at all, so that case just upserts directly instead of racing a CAS against nothing.
async function postFreshQueueMessage(
  supabase: AdminClient,
  queueType: QueueType,
  channelId: string,
  oldMessageId: string | null,
  members: PlayerRow[],
  headline?: string,
): Promise<void> {
  const streaks = await getStreakIds(supabase, members.map((m) => m.id));
  const mode = await getQueueMessageMode();

  if (oldMessageId === null) {
    const message = (await discordFetch(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify(await queueMessageBody(supabase, mode, queueType, members, streaks, headline)),
    })) as { id: string };
    await supabase.from("crl6mansqueuebot_queue_messages").upsert({
      queue_type: queueType,
      channel_id: channelId,
      message_id: message.id,
    });
    return;
  }

  await tryPostAndClaimQueueMessage(supabase, queueType, channelId, oldMessageId, members, streaks, headline, mode);
}

// Posts a message to a queue channel and tracks it, deleting all other non-permanent messages first.
// Used for status updates, errors, and settled series notifications.
export async function postTrackedQueueMessage(
  supabase: AdminClient,
  channelId: string,
  embed: any,
  messageType: "status" | "error" | "settled" | "teams_formed" | "timeout",
  keepPermanently: boolean = false,
): Promise<string | null> {
  // Delete all non-permanent messages from this channel
  const { data: trackedMessages } = await supabase
    .from("crl6mansqueuebot_queue_channel_messages")
    .select("message_id, keep_permanently")
    .eq("channel_id", channelId) as any;

  if (trackedMessages) {
    for (const msg of trackedMessages) {
      if (!(msg as any).keep_permanently) {
        await discordFetch(`/channels/${channelId}/messages/${msg.message_id}`, { method: "DELETE" }).catch((err) =>
          console.error(`Failed to delete queue channel message ${msg.message_id}`, err),
        );
      }
    }
  }

  // Delete the old non-permanent entries from the tracking table
  await supabase
    .from("crl6mansqueuebot_queue_channel_messages")
    .delete()
    .eq("channel_id", channelId)
    .eq("keep_permanently", false);

  // Post the new message
  try {
    const message = (await discordFetch(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ embeds: [embed] }),
    })) as { id: string };

    // Track the new message
    await supabase.from("crl6mansqueuebot_queue_channel_messages").insert({
      channel_id: channelId,
      message_id: message.id,
      message_type: messageType,
      keep_permanently: keepPermanently,
    } as any);

    return message.id;
  } catch (err) {
    console.error(`Failed to post tracked queue message`, err);
    return null;
  }
}

// Refreshes whichever channel is currently mapped to `queueType`. No-ops if the queue channel
// was never set up. `headline` is the "<@user> has joined/left..." line for command-driven
// refreshes (embedded, does not itself notify); omitted for headline-less refreshes (admin
// force-leave, cross-queue-pop removal). `ping` is the separate first-join role mention, sent
// as the message's top-level content so it actually notifies — see queueMessageBody.
//
// Retries on a lost claim race rather than giving up after one attempt: since join/leave writes
// (join_queue/leave_queue RPCs) always commit before this runs, re-fetching msgRow/members on
// retry picks up every membership change committed so far — including the one that motivated a
// losing refresh's own call — so a burst of concurrent /q joins can't leave the surviving message
// stale by more than whatever lands mid-retry. Capped so a pathological, sustained hammer on one
// queue channel can't loop forever.
const MAX_REFRESH_ATTEMPTS = 5;

export async function refreshQueueMessage(
  supabase: AdminClient,
  queueType: QueueType,
  headline?: string,
  ping?: string,
  richContext?: { action: "join" | "leave" | "inactive"; player: PlayerRow; queueSize: number },
  // Callers that already looked up this queue_type's crl6mansqueuebot_queue_messages row a
  // moment earlier for their own purposes (processQueueCommand resolves channel->queue_type off
  // this exact table before doing anything else) can pass it here to skip attempt 0's otherwise-
  // redundant re-fetch of the same row. Only used for the first attempt — if the optimistic claim
  // built off it loses the race (another refresh already moved message_id), the loop falls back
  // to a fresh fetch on attempt 1 exactly as before, so a slightly stale known row is never unsafe,
  // just occasionally not the fast path.
  knownMsgRow?: { channel_id: string; message_id: string | null },
) {
  const mode = await getQueueMessageMode();
  let announced = false;
  for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt++) {
    const msgRow =
      attempt === 0 && knownMsgRow
        ? knownMsgRow
        : (
            await supabase
              .from("crl6mansqueuebot_queue_messages")
              .select("*")
              .eq("queue_type", queueType)
              .maybeSingle()
          ).data;
    if (!msgRow) return;

    // Hybrid mode's headline-only announcement is a separate, always-stacking message — post it
    // once (not on retries, which just re-attempt the roster message's own claim race) alongside
    // the roster refresh below, which carries no headline/ping of its own in hybrid mode. Rich
    // mode has no equivalent second message anymore — its content lives directly in the claimed
    // message built below (see queueMessageBody).
    if (mode === "hybrid" && headline && !announced) {
      await postHybridAnnouncement(msgRow.channel_id, headline, ping);
      announced = true;
    }

    const members = await fetchQueueMembers(supabase, queueType);
    const streaks = await getStreakIds(supabase, members.map((m) => m.id));
    const won = await tryPostAndClaimQueueMessage(
      supabase,
      queueType,
      msgRow.channel_id,
      msgRow.message_id,
      members,
      streaks,
      mode === "hybrid" || mode === "rich" ? undefined : headline,
      mode,
      mode === "hybrid" ? undefined : ping,
      mode === "rich" ? richContext : undefined,
    );
    if (won) return;
  }
  console.error(`Queue message refresh for ${queueType} gave up after ${MAX_REFRESH_ATTEMPTS} attempts`);
}

// Hybrid and rich modes only: the tracked message posted at pop time (hybrid: the roster embed;
// rich: the ordinary join card for the 6th join) is treated as a historical record of "who played
// this match" and must survive forever — including through the next queue cycle's own message
// refreshes, which would otherwise delete it as their "old" message the moment the next cycle's
// first join lands. Re-homes its tracking out of
// crl6mansqueuebot_queue_messages (the single-row-per-queue_type table every refresh reads and
// deletes from) into crl6mansqueuebot_queue_channel_messages' existing keep_permanently
// mechanism (the same one finalizeTeams's "Teams formed!" message uses in teamFormation.ts).
//
// The queue_type's row is kept (not deleted) with message_id nulled out, rather than reposting a
// fresh "Current Queue Members: 0" placeholder message — that placeholder was reported as
// unnecessary noise (see CLAUDE.md's "Queue channels"). Deleting the row outright isn't an option
// either: processQueueCommand (/q, /l) resolves a channel's queue_type by looking up this exact
// table with no fallback for a missing row, so that would leave the channel entirely unable to
// process /q/l ("this channel isn't set up as a queue channel") from the instant a queue popped
// until an admin manually reran /setqueuechannel. A null message_id (migration
// 0044_nullable_queue_message_id.sql) keeps the channel<->queue_type mapping continuously intact
// with no visible message — the next join's refreshQueueMessage call claims against
// `message_id is null` (tryPostAndClaimQueueMessage) and posts the real join/leave message itself.
async function freezeQueueRosterMessage(supabase: AdminClient, queueType: QueueType) {
  const { data: msgRow } = await supabase
    .from("crl6mansqueuebot_queue_messages")
    .select("*")
    .eq("queue_type", queueType)
    .maybeSingle();
  if (!msgRow) return;

  await supabase.from("crl6mansqueuebot_queue_channel_messages").insert({
    channel_id: msgRow.channel_id,
    message_id: msgRow.message_id,
    message_type: "status",
    keep_permanently: true,
  } as any);

  await supabase
    .from("crl6mansqueuebot_queue_messages")
    .update({ message_id: null })
    .eq("queue_type", queueType);
}

// Refreshes the queue's tracked status message after a series settles (report/abandon/cancel/
// sweep timeout) — but only in modes freezeQueueRosterMessage never touched at pop time. Rich and
// hybrid modes already left message_id null there specifically so the channel shows nothing until
// the next real /q or /l posts a fresh message (see freezeQueueRosterMessage's comment) — calling
// plain refreshQueueMessage here for those modes defeats that by immediately reposting a new,
// contentless "Current Queue Members: 0 / Empty" message as pure noise. Default/simplified modes
// were never frozen, so they still need this call to stop showing the stale pre-pop roster as
// "currently queued" (see each call site's own comment for that history).
export async function refreshQueueMessageAfterSettlement(supabase: AdminClient, queueType: QueueType) {
  const mode = await getQueueMessageMode();
  if (mode === "rich" || mode === "hybrid") return;
  await refreshQueueMessage(supabase, queueType);
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
  await postFreshQueueMessage(supabase, queueType, channelId, existing?.message_id ?? null, members);
}

// ---------------------------------------------------------------------------
// Player + lock lookups
// ---------------------------------------------------------------------------

// `onCreated` fires only when this call actually inserts a new player row (not on lookups of an
// existing one) — used by the queue join path to grant the "Unranked" role on a player's first
// ever queue, without every other caller (report, sub, abandon, etc.) needing to know about it.
export async function getOrCreatePlayer(
  supabase: AdminClient,
  discordId: string,
  displayName: string,
  onCreated?: (player: PlayerRow) => void | Promise<void>,
): Promise<PlayerRow> {
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
  if (onCreated) await onCreated(created);
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

// Same lobby∪series_players lookup as isPlayerLockedInActiveSeries, but returns the series
// row itself rather than a boolean — used by /sub and /abandon to resolve "the caller's
// match" by membership instead of by channel. queue_channel_id is a shared queue channel, not
// a per-match channel, so multiple concurrently forming/active series can
// have the same queue_channel_id; a player can only be locked into one at a time, so
// membership is the unambiguous key (mirrors report.ts's own resolution, which never used
// channel inference at all).
export async function getLockedSeriesForPlayer(supabase: AdminClient, playerId: string): Promise<SeriesRow | null> {
  const [{ data: lobbyRows }, { data: seriesPlayerRows }] = await Promise.all([
    supabase.from("crl6mansqueuebot_series_lobby").select("series_id").eq("player_id", playerId),
    supabase.from("crl6mansqueuebot_series_players").select("series_id").eq("player_id", playerId),
  ]);
  const seriesIds = [...new Set([...(lobbyRows ?? []).map((r) => r.series_id), ...(seriesPlayerRows ?? []).map((r) => r.series_id)])];
  if (seriesIds.length === 0) return null;

  const { data } = await supabase
    .from("crl6mansqueuebot_series")
    .select("*")
    .in("id", seriesIds)
    .in("status", ["forming", "active"])
    .maybeSingle();
  return data;
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

  // Selects the full row (not just queue_type) so the channel_id/message_id already known here
  // can be passed straight through to refreshQueueMessage's calls below (as knownMsgRow) instead
  // of it re-querying this exact same row from scratch a moment later — same table, same
  // queue_type, nothing in between changes it.
  const { data: msgRow } = await supabase
    .from("crl6mansqueuebot_queue_messages")
    .select("*")
    .eq("channel_id", channelId)
    .maybeSingle();
  if (!msgRow) {
    await editOriginalResponse(interaction.token, {
      content: "This channel isn't set up as a queue channel — ask an admin to run /setqueuechannel here.",
    });
    return;
  }
  const queueType = msgRow.queue_type as QueueType;
  const knownMsgRow = { channel_id: msgRow.channel_id, message_id: msgRow.message_id };

  const player = await getOrCreatePlayer(
    supabase,
    discordId,
    interactionDisplayName(interaction),
    action === "join" ? (p) => grantUnrankedRoleToNewPlayer(p.discord_id) : undefined,
  );

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
    await refreshQueueMessage(
      supabase,
      queueType,
      `<@${discordId}> has left the ${QUEUE_LABELS[queueType]}.`,
      undefined,
      { action: "leave", player, queueSize: result.queue_size },
      knownMsgRow,
    );
    await deleteOriginalResponse(interaction.token);
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

  if (result?.status === "joined" && result.queue_size >= 6) {
    const guildId = interaction.guild_id ?? (await getGuildId());
    const mode = await getQueueMessageMode();
    if (mode === "rich") {
      // Rich mode: the 6th join posts the ordinary per-player join card (richEventEmbed), same as
      // any other join — revised back this session, supersedes the roster-copy-instead-of-a-join-
      // card behavior above (which itself superseded an even earlier version of this same
      // behavior) per explicit request to go back to showing the join message at 6/6.
      await refreshQueueMessage(
        supabase,
        queueType,
        undefined,
        undefined,
        { action: "join", player, queueSize: result.queue_size },
        knownMsgRow,
      );
    } else {
      // Show the queue at 6/6 (same "has joined" treatment as any other join) before handlePop
      // clears crl6mansqueuebot_queue_members and the vote embed replaces this as the channel's
      // newest message.
      await refreshQueueMessage(supabase, queueType, `<@${discordId}> has joined the ${QUEUE_LABELS[queueType]}!`, undefined, undefined, knownMsgRow);
    }

    // The gold "Match Found!" announcement and the roster-message freeze both claim the match is
    // actually forming, so they must wait until handlePop confirms a series row actually exists —
    // see handlePop's own comment for why this ordering matters (posting them unconditionally
    // beforehand is the bug this guards against: a failed pop left a false "Match Found" up with
    // no vote ever following it, and the 6 players silently still sitting in queue_members).
    const popped = await handlePop(supabase, queueType, guildId, channelId);
    if (popped) {
      if (mode === "rich") {
        const streaks = await getStreakIds(supabase, popped.members.map((m) => m.id));
        await postRichMatchFoundAnnouncement(channelId, popped.members, streaks);
      }
      if (mode === "rich" || mode === "hybrid") {
        await freezeQueueRosterMessage(supabase, queueType);
      }
    }
    // Pop succeeded (or failed with its own error already posted) — delete the deferred response
    // so it auto-dismisses either way.
    await deleteOriginalResponse(interaction.token);
  } else if (result?.status === "joined") {
    const headline = `<@${discordId}> has joined the ${QUEUE_LABELS[queueType]}!`;
    let ping: string | undefined;

    // If this is the first join (queue size was 0, now 1), ping the configured role — sent
    // separately as message content (not embedded) so the notification actually fires.
    if (result.queue_size === 1) {
      const { data: mentionRoleRow } = await supabase
        .from("crl6mansqueuebot_queue_mention_roles")
        .select("role_id")
        .eq("queue_type", queueType)
        .maybeSingle() as any;

      if (mentionRoleRow?.role_id) {
        ping = `<@&${mentionRoleRow.role_id}>`;
      }
    }

    await refreshQueueMessage(supabase, queueType, headline, ping, { action: "join", player, queueSize: result.queue_size }, knownMsgRow);
    if (result.queue_size === 1 && (await isSuperchargedDayLive())) {
      await postSuperchargedAnnouncement(channelId);
    }
    await deleteOriginalResponse(interaction.token);
  }
}

// ---------------------------------------------------------------------------
// /status — read-only snapshot of the queue mapped to the current channel (same
// channel-inference as /q/l), rendered as the same one-player-per-line roster embed hybrid
// mode's live roster message uses (rank emoji + mention + band + MMR) — regardless of the
// channel's actual queue_message_mode, since this is a one-off lookup, not a persistent
// tracked message. Replies publicly (unlike /q/l's ephemeral confirmations) since a roster
// snapshot is useful for everyone in the channel to see, not just the caller.
// ---------------------------------------------------------------------------

export function handleStatusCommand(interaction: DiscordInteraction) {
  after(() => processStatusCommand(interaction));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
}

async function processStatusCommand(interaction: DiscordInteraction) {
  const supabase = createAdminClient();
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

  const members = await fetchQueueMembers(supabase, queueType);
  const streaks = await getStreakIds(supabase, members.map((m) => m.id));
  await editOriginalResponse(interaction.token, { embeds: [await hybridRosterEmbed(queueType, members, streaks)] });
}

// ---------------------------------------------------------------------------
// Pop: lock the 6 players in, cross-remove from the other queue, create the series
// + match category/text channel (see CLAUDE.md, "Match channels (created per series
// on pop)").
// ---------------------------------------------------------------------------


// Returns the popped members on success so the caller can post the "Match Found!" announcement
// only once a series row genuinely exists — never before. Previously that announcement (and the
// roster-freeze) were posted by the caller unconditionally, before handlePop ran at all; if
// handlePop then bailed out here (no active season, or the series insert itself failing — both
// realistic under the DB contention a burst of simultaneous joins across the server can cause),
// the channel was left with a "Match Found! Forming teams…" message that nothing ever followed
// up on, while the 6 players remained silently sitting in crl6mansqueuebot_queue_members (this
// function returns before ever clearing them) — indistinguishable from an ordinary still-queued
// state, so one of them leaving via /l worked as normal and joining back re-triggered a fresh
// pop attempt. Now both failure paths post their own visible error instead of only console.error,
// and the caller no longer announces a match that was never actually formed.
async function handlePop(
  supabase: AdminClient,
  queueType: QueueType,
  guildId: string,
  queueChannelId: string,
): Promise<{ members: PlayerRow[] } | null> {
  const members = await fetchQueueMembers(supabase, queueType);
  const playerIds = members.map((m) => m.id);

  const { data: season } = await supabase
    .from("crl6mansqueuebot_seasons")
    .select("id")
    .eq("is_active", true)
    .maybeSingle();

  if (!season) {
    console.error("Pop triggered but no active season exists — leaving players queued until an admin fixes this");
    await postTrackedQueueMessage(
      supabase,
      queueChannelId,
      { color: 0xef476f, description: "**Error:** No active season configured — ask an admin to check config. Run /l then /q again once it's fixed." },
      "error",
      true,
    );
    return null;
  }

  // Locked in now, at pop (= "the queue completes") — see CLAUDE.md, "Weekly bonus day": a
  // series that pops inside the bonus window keeps its bonus even if reported after the window
  // has since closed, so this can't be recomputed later at report time.
  const bonusDayMultiplier = await computeBonusDayMultiplier();

  const { data: series, error: seriesError } = await supabase
    .from("crl6mansqueuebot_series")
    .insert({
      season_id: season.id,
      queue_type: queueType,
      status: "forming",
      queue_channel_id: queueChannelId,
      bonus_day_multiplier: bonusDayMultiplier,
    })
    .select("id")
    .single();
  if (seriesError || !series) {
    console.error("Failed to create series on pop", seriesError);
    await postTrackedQueueMessage(
      supabase,
      queueChannelId,
      { color: 0xef476f, description: "**Error:** Failed to form your match — run /l then /q again. Ping an admin if this keeps happening." },
      "error",
      true,
    );
    return null;
  }

  // match_number is intentionally left unset here — revised a later session, supersedes
  // assigning it at pop time via a sequence-backed column default (migration
  // 0030_fix_match_number_race.sql). Assigning at pop time meant void/cancelled/timed-out
  // series consumed a real match number identically to reported ones, since nothing at pop time
  // knows a series' eventual outcome. match_number is now only ever assigned once, atomically,
  // at the moment a series actually settles to 'reported' (report.ts) — see migration
  // 0042_match_number_on_report.sql.

  await supabase
    .from("crl6mansqueuebot_series_lobby")
    .insert(playerIds.map((playerId) => ({ series_id: series.id, player_id: playerId })));

  await supabase.from("crl6mansqueuebot_queue_members").delete().eq("queue_type", queueType).in("player_id", playerIds);

  await createMatchChannels(supabase, series.id, guildId, members, queueChannelId);
  return { members };
}

export async function createMatchChannels(supabase: AdminClient, seriesId: string, guildId: string, members: PlayerRow[], queueChannelId: string) {
  try {
    // Best-of-3/5/7 pre-vote, feature-flagged and off by default — see CLAUDE.md, "Team
    // formation (on pop)". When disabled, startTeamFormation runs exactly as it always has;
    // this is the entire guarantee that a disabled feature changes nothing about today's flow.
    const seriesLengthVoteEnabled = (await getConfigNumber("series_length_vote_enabled", 0)) === 1;
    if (seriesLengthVoteEnabled) {
      await startSeriesLengthVote(supabase, guildId, seriesId, queueChannelId, members);
    } else {
      await startTeamFormation(supabase, guildId, seriesId, queueChannelId, members);
    }
  } catch (err) {
    console.error(`Failed to start team formation for series ${seriesId}`, err);
    await postTrackedQueueMessage(
      supabase,
      queueChannelId,
      {
        color: 0xef476f,
        description: "**Error:** Failed to start team formation. Ask an admin to check logs.",
      },
      "error",
      true,
    );
  }
}

export async function createVoiceChannels(
  supabase: AdminClient,
  seriesId: string,
  guildId: string,
  teamA: PlayerRow[],
  teamB: PlayerRow[],
  // Called with a live *preview* number (teamFormation.ts's computePreviewMatchNumber), not the
  // series' real match_number — that isn't assigned until the match is reported, well after
  // these channels are created and named. Naming is otherwise unaware of the distinction.
  matchNumber?: number,
) {
  const adminRoleIds = await getAdminRoleIds();
  const botUserId = process.env.DISCORD_APPLICATION_ID;
  // Use match number if available, otherwise fall back to short series ID
  const channelIdSuffix = matchNumber != null ? `Match #${matchNumber}` : seriesId.slice(0, 7);

  // Fetch admin-specified call category from config
  const { data: categoryConfig } = await supabase
    .from("crl6mansqueuebot_config")
    .select("value")
    .eq("key", "6mans_call_category_id")
    .maybeSingle();

  const categoryId = categoryConfig?.value;
  if (!categoryId) {
    console.error(`6-mans call category not configured for series ${seriesId}`);
    return;
  }

  const voiceOverwrites = (teamMembers: PlayerRow[]): PermissionOverwrite[] => [
    // Viewable by anyone (so the community can see which games are live) but joinable only by
    // the team, admins, and the bot — @everyone gets VIEW_CHANNEL but has CONNECT denied, and
    // that denial is overridden below by member/role-specific allows, since Discord resolves
    // @everyone first and member/role overwrites take precedence over it.
    { id: guildId, type: ROLE_TYPE, allow: VIEW_CHANNEL.toString(), deny: CONNECT.toString() },
    // Test bots use synthetic discord_ids (e.g. "test_bot_..."), not real snowflakes — Discord's
    // API rejects the entire channel-creation request if any permission_overwrites id isn't a
    // real snowflake, so they must be excluded here rather than just skipped elsewhere.
    ...teamMembers
      .filter((m) => !m.is_test_data)
      .map((m) => ({ id: m.discord_id, type: MEMBER_TYPE, allow: (VIEW_CHANNEL | CONNECT).toString() }) as PermissionOverwrite),
    ...adminRoleIds.map((roleId) => ({ id: roleId, type: ROLE_TYPE, allow: (VIEW_CHANNEL | CONNECT).toString() }) as PermissionOverwrite),
    ...(botUserId ? [{ id: botUserId, type: MEMBER_TYPE, allow: (VIEW_CHANNEL | CONNECT).toString() } as PermissionOverwrite] : []),
  ];

  try {
    const voiceA = (await discordFetch(`/guilds/${guildId}/channels`, {
      method: "POST",
      body: JSON.stringify({ name: `Team Blue - ${channelIdSuffix}`, type: 2, parent_id: categoryId, permission_overwrites: voiceOverwrites(teamA) }),
    })) as { id: string };
    const voiceB = (await discordFetch(`/guilds/${guildId}/channels`, {
      method: "POST",
      body: JSON.stringify({ name: `Team Orange - ${channelIdSuffix}`, type: 2, parent_id: categoryId, permission_overwrites: voiceOverwrites(teamB) }),
    })) as { id: string };

    await supabase
      .from("crl6mansqueuebot_series")
      .update({ voice_channel_a_id: voiceA.id, voice_channel_b_id: voiceB.id })
      .eq("id", seriesId);
  } catch (err) {
    console.error(`Failed to create voice channels for series ${seriesId}`, err);
  }
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
  if (!channelId || queueTypeRaw !== "rank") {
    await editOriginalResponse(interaction.token, { content: "Invalid queue_type or channel." });
    return;
  }
  const supabase = createAdminClient();
  const { data: existing } = await supabase
    .from("crl6mansqueuebot_queue_messages")
    .select("channel_id")
    .eq("queue_type", queueTypeRaw)
    .maybeSingle();
  await initQueueMessage(queueTypeRaw, channelId);
  const actorId = interactionUserId(interaction);
  if (actorId) {
    await logAdminAction(actorId, "set_queue_channel", QUEUE_LABELS[queueTypeRaw], undefined, [
      { field: `${QUEUE_LABELS[queueTypeRaw]} channel`, before: existing?.channel_id ? `<#${existing.channel_id}>` : null, after: `<#${channelId}>` },
    ]);
  }
  await editOriginalResponse(interaction.token, { content: `Queue message set up for ${QUEUE_LABELS[queueTypeRaw]}.` });
}

// ---------------------------------------------------------------------------
// /set6manscallcategory — specify the Discord category where match voice channels
// are created. Owner-or-admin-role gated.
// ---------------------------------------------------------------------------

export function handleSet6mansCallCategoryCommand(interaction: DiscordInteraction) {
  const categoryIdParam = interaction.data?.options?.find((o) => o.name === "category")?.value;
  after(() => processSet6mansCallCategory(interaction, categoryIdParam));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processSet6mansCallCategory(interaction: DiscordInteraction, categoryIdParamRaw: string | number | boolean | undefined) {
  if (!(await hasAdminAccess(interaction))) {
    await editOriginalResponse(interaction.token, { content: "You don't have admin access." });
    return;
  }

  let categoryId: string | undefined;
  if (categoryIdParamRaw) {
    categoryId = String(categoryIdParamRaw);
  } else if (interaction.channel_id) {
    // If no parameter, use the parent category of the current channel
    try {
      const channel = (await discordFetch(`/channels/${interaction.channel_id}`)) as { parent_id?: string };
      categoryId = channel.parent_id;
    } catch (err) {
      console.error("Failed to fetch channel details", err);
    }
  }

  if (!categoryId) {
    await editOriginalResponse(interaction.token, { content: "Could not determine category. Run this in a channel inside the category you want to use." });
    return;
  }

  const supabase = createAdminClient();
  const { data: existing } = await supabase.from("crl6mansqueuebot_config").select("value").eq("key", "6mans_call_category_id").maybeSingle();
  await supabase.from("crl6mansqueuebot_config").upsert({ key: "6mans_call_category_id", value: categoryId });
  const actorId = interactionUserId(interaction);
  if (actorId) {
    await logAdminAction(actorId, "set_6mans_call_category", undefined, undefined, [
      { field: "6-mans call category", before: existing?.value ? `<#${existing.value}>` : null, after: `<#${categoryId}>` },
    ]);
  }
  await editOriginalResponse(interaction.token, { content: `6-mans call category set to <#${categoryId}>.` });
}

// ---------------------------------------------------------------------------
// /setreportchannel — specify the Discord channel where match results are posted.
// Owner-or-admin-role gated.
// ---------------------------------------------------------------------------

export function handleSetReportChannelCommand(interaction: DiscordInteraction) {
  const channelIdParam = interaction.data?.options?.find((o) => o.name === "channel")?.value;
  after(() => processSetReportChannel(interaction, channelIdParam));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processSetReportChannel(interaction: DiscordInteraction, channelIdParamRaw: string | number | boolean | undefined) {
  if (!(await hasAdminAccess(interaction))) {
    await editOriginalResponse(interaction.token, { content: "You don't have admin access." });
    return;
  }

  const channelId = channelIdParamRaw ? String(channelIdParamRaw) : interaction.channel_id;

  if (!channelId) {
    await editOriginalResponse(interaction.token, { content: "Could not determine channel. Run this in the channel you want to use as the report channel." });
    return;
  }

  const supabase = createAdminClient();
  const { data: existing } = await supabase.from("crl6mansqueuebot_config").select("value").eq("key", "report_channel_id").maybeSingle();
  await supabase.from("crl6mansqueuebot_config").upsert({ key: "report_channel_id", value: channelId });
  const actorId = interactionUserId(interaction);
  if (actorId) {
    await logAdminAction(actorId, "set_report_channel", undefined, undefined, [
      { field: "Report channel", before: existing?.value ? `<#${existing.value}>` : null, after: `<#${channelId}>` },
    ]);
  }
  await editOriginalResponse(interaction.token, { content: `Report channel set to <#${channelId}>.` });
}

// ---------------------------------------------------------------------------
// /setlogchannel — specify the Discord channel where admin change-log embeds are posted (who
// ran a command, what it changed, before/after — see CLAUDE.md, "Admin change log"). Mirrors
// /setreportchannel exactly. Logs itself after the upsert (not before) so the confirmation
// embed for setting the log channel is the first thing to actually land in it.
// ---------------------------------------------------------------------------

export function handleSetLogChannelCommand(interaction: DiscordInteraction) {
  const channelIdParam = interaction.data?.options?.find((o) => o.name === "channel")?.value;
  after(() => processSetLogChannel(interaction, channelIdParam));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processSetLogChannel(interaction: DiscordInteraction, channelIdParamRaw: string | number | boolean | undefined) {
  if (!(await hasAdminAccess(interaction))) {
    await editOriginalResponse(interaction.token, { content: "You don't have admin access." });
    return;
  }

  const channelId = channelIdParamRaw ? String(channelIdParamRaw) : interaction.channel_id;

  if (!channelId) {
    await editOriginalResponse(interaction.token, { content: "Could not determine channel. Run this in the channel you want to use as the log channel." });
    return;
  }

  const supabase = createAdminClient();
  const { data: existing } = await supabase.from("crl6mansqueuebot_config").select("value").eq("key", "log_channel_id").maybeSingle();
  await supabase.from("crl6mansqueuebot_config").upsert({ key: "log_channel_id", value: channelId });
  const actorId = interactionUserId(interaction);
  if (actorId) {
    await logAdminAction(actorId, "set_log_channel", undefined, undefined, [
      { field: "Log channel", before: existing?.value ? `<#${existing.value}>` : null, after: `<#${channelId}>` },
    ]);
  }
  await editOriginalResponse(interaction.token, { content: `Log channel set to <#${channelId}>. Admin change-log embeds will be posted there.` });
}

// ---------------------------------------------------------------------------
// /setlobbychannel — specify the voice channel players are moved into when their match's team
// voice channels are torn down, instead of being dropped out of voice entirely (see
// moveTeamVoiceOccupantsToLobby in matchChannels.ts). Mirrors /setlogchannel; the `channel:`
// option must be a voice channel, so unlike the text-channel setters there's no
// infer-the-current-channel fallback — a slash command is almost never run from inside one.
// ---------------------------------------------------------------------------

export function handleSetLobbyChannelCommand(interaction: DiscordInteraction) {
  const channelIdParam = interaction.data?.options?.find((o) => o.name === "channel")?.value;
  after(() => processSetLobbyChannel(interaction, channelIdParam));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processSetLobbyChannel(interaction: DiscordInteraction, channelIdParamRaw: string | number | boolean | undefined) {
  if (!(await hasAdminAccess(interaction))) {
    await editOriginalResponse(interaction.token, { content: "You don't have admin access." });
    return;
  }

  const channelId = channelIdParamRaw ? String(channelIdParamRaw) : null;
  if (!channelId) {
    await editOriginalResponse(interaction.token, { content: "Pick the voice channel players should be moved to when a match ends." });
    return;
  }

  const supabase = createAdminClient();
  const { data: existing } = await supabase.from("crl6mansqueuebot_config").select("value").eq("key", "lobby_voice_channel_id").maybeSingle();
  await supabase.from("crl6mansqueuebot_config").upsert({ key: "lobby_voice_channel_id", value: channelId });
  const actorId = interactionUserId(interaction);
  if (actorId) {
    await logAdminAction(actorId, "set_lobby_channel", undefined, undefined, [
      { field: "Lobby voice channel", before: existing?.value ? `<#${existing.value}>` : null, after: `<#${channelId}>` },
    ]);
  }
  await editOriginalResponse(interaction.token, {
    content:
      `Lobby channel set to <#${channelId}>. When a match ends, players still sitting in that match's team voice channels are moved here instead of being disconnected — anyone in another call stays where they are.\n` +
      `Make sure the bot has **Move Members** and that players can connect to <#${channelId}>.`,
  });
}

// ---------------------------------------------------------------------------
// /setqueuementionrole — specify the Discord role to mention when the first
// player joins a queue. Owner-or-admin-role gated.
// ---------------------------------------------------------------------------

export function handleSetQueueMentionRoleCommand(interaction: DiscordInteraction) {
  const queueTypeOption = interaction.data?.options?.find((o) => o.name === "queue_type")?.value;
  const roleIdOption = interaction.data?.options?.find((o) => o.name === "role")?.value;
  after(() => processSetQueueMentionRole(interaction, queueTypeOption, roleIdOption));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processSetQueueMentionRole(
  interaction: DiscordInteraction,
  queueTypeRaw: string | number | boolean | undefined,
  roleIdRaw: string | number | boolean | undefined,
) {
  if (!(await hasAdminAccess(interaction))) {
    await editOriginalResponse(interaction.token, { content: "You don't have admin access." });
    return;
  }

  if (queueTypeRaw !== "rank") {
    await editOriginalResponse(interaction.token, { content: "Invalid queue_type. Use 'rank'." });
    return;
  }

  const roleId = roleIdRaw ? String(roleIdRaw) : undefined;
  if (!roleId) {
    await editOriginalResponse(interaction.token, { content: "You must specify a role." });
    return;
  }

  const supabase = createAdminClient();
  const queueType = queueTypeRaw as QueueType;
  const { data: existing } = await supabase
    .from("crl6mansqueuebot_queue_mention_roles")
    .select("role_id")
    .eq("queue_type", queueType)
    .maybeSingle();
  await supabase.from("crl6mansqueuebot_queue_mention_roles").upsert(
    { queue_type: queueType, role_id: roleId } as any,
    { onConflict: "queue_type" }
  );
  const actorId = interactionUserId(interaction);
  if (actorId) {
    await logAdminAction(actorId, "set_queue_mention_role", QUEUE_LABELS[queueType], undefined, [
      { field: `${QUEUE_LABELS[queueType]} mention role`, before: (existing as any)?.role_id ? `<@&${(existing as any).role_id}>` : null, after: `<@&${roleId}>` },
    ]);
  }
  await editOriginalResponse(interaction.token, { content: `${QUEUE_LABELS[queueType]} mention role set to <@&${roleId}>.` });
}
