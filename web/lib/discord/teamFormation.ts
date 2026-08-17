import "server-only";
import { after } from "next/server";
import {
  InteractionResponseType,
  InteractionResponseFlags,
  MessageComponentTypes,
  ButtonStyleTypes,
} from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PlayerRow, SeriesLobbyRow, SeriesRow, Team, VoteChoice, SeriesLength } from "@/lib/supabase/types";
import { discordFetch, sendDirectMessage, sendFollowupMessage, editOriginalResponse, getGuildId, BRAND_COLOR, SUPERCHARGED_COLOR, getRankEmoji } from "./rest";
import { getAdminRoleIds, hasAdminAccess } from "./admin";
import { getConfigNumber, getDisplayMMR } from "./config";
import { VIEW_CHANNEL, CONNECT, ROLE_TYPE, MEMBER_TYPE, type PermissionOverwrite } from "./permissions";
import { interactionUserId, interactionDisplayName, type DiscordInteraction } from "./types";
import { createVoiceChannels, postTrackedQueueMessage, getOrCreatePlayer, getLockedSeriesForPlayer, refreshQueueMessage } from "./queue";
import { getStreakIds, mention, type StreakIds } from "./streaks";
import { deleteMatchChannels, clearPendingSeriesState } from "./matchChannels";
import { recordMatchTimeStats } from "./matchTimeStats";
import { calculateTeamStrength } from "@/lib/mmr/teamStrength";

type AdminClient = ReturnType<typeof createAdminClient>;

// Votes required to void a series via mutual agreement — usable during both 'forming' and
// 'active' via the /cancel slash command (no vote-message button anymore — removed since it
// duplicated /cancel as a voting option) against the shared crl6mansqueuebot_cancel_votes
// table. See registerCancelVoteAndMaybeVoid below and CLAUDE.md, "Series end".
const CANCEL_VOTE_THRESHOLD = 4;

// Ephemeral error replies from the button handlers below must go through the followup webhook,
// never the interaction's one-shot /callback endpoint. Every one of these runs inside an after()
// callback, i.e. *after* route.ts has already acknowledged the click with DEFERRED_UPDATE_MESSAGE
// — Discord rejects a second /callback POST on an already-acknowledged interaction, and the
// blanket .catch(() => {}) these previously used swallowed that rejection, so none of these
// messages were ever actually delivered. Same latent bug, and same fix, as /mafia's replyError
// (see CLAUDE.md, "Mafia mini-game").
async function replyError(interaction: DiscordInteraction, content: string) {
  await sendFollowupMessage(interaction.token, { content }).catch(() => {});
}

// Best-of-3/5/7 series-length pre-vote — see CLAUDE.md, "Team formation (on pop)". Fixed
// constants, not admin-configurable (only the whole feature's on/off state is, via /admin
// series-length-vote toggle) — same precedent as CANCEL_VOTE_THRESHOLD above, since the user
// supplied exact fixed values rather than asking for them to be tunable.
const SERIES_LENGTH_VOTE_THRESHOLD = 3;
const SERIES_LENGTH_ORDER: SeriesLength[] = ["bo3", "bo5", "bo7"];
export const SERIES_LENGTH_K_MULTIPLIERS: Record<SeriesLength, number> = { bo3: 0.6, bo5: 1.0, bo7: 1.4 };
export const SERIES_LENGTH_LABELS: Record<SeriesLength, string> = { bo3: "Best of 3", bo5: "Best of 5", bo7: "Best of 7" };

// Picks whichever series length currently has the most votes; ties (including a 0-0-0 tie, i.e.
// nobody voted at all) favor the shorter series, since SERIES_LENGTH_ORDER is walked bo3->bo5->bo7
// and only a *strictly* greater count replaces the running winner. Pure and exported so it's
// unit-testable independent of DB access, same as bonusDay.ts's isDayInRange. Used both for the
// "all 6 voted, nobody hit 3" case (necessarily an exact 2-2-2 split) and for the sweep route's
// timeout-driven majority resolution.
export function resolveSeriesLengthTieBreak(counts: Record<SeriesLength, number>): SeriesLength {
  let winner: SeriesLength = "bo3";
  for (const length of SERIES_LENGTH_ORDER) {
    if (counts[length] > counts[winner]) winner = length;
  }
  return winner;
}

// ---------------------------------------------------------------------------
// Vote message: Balanced vs Captains, first to 3/6 wins, exact 3-3 tie -> Captains.
// See CLAUDE.md, "Team formation (on pop)" / "Team formation, in the match channel".
// ---------------------------------------------------------------------------

// Whether the given series popped during a supercharged (Bonus Day) window — reads the snapshot
// written once at pop time (queue.ts), not a live re-check, so a series that popped inside the
// window keeps its purple theming even if reported after the window has since closed. See
// CLAUDE.md, "Weekly bonus day".
async function isSuperchargedSeries(supabase: AdminClient, seriesId: string): Promise<boolean> {
  const { data } = await supabase.from("crl6mansqueuebot_series").select("bonus_day_multiplier").eq("id", seriesId).maybeSingle();
  return ((data as { bonus_day_multiplier?: number } | null)?.bonus_day_multiplier ?? 1) > 1;
}

function voteEmbed(balancedCount: number, captainsCount: number, timeoutSeconds: number, supercharged: boolean) {
  const minutes = Math.round(timeoutSeconds / 60);
  return {
    color: supercharged ? SUPERCHARGED_COLOR : BRAND_COLOR,
    description: `You have **${minutes} minute${minutes === 1 ? "" : "s"}** to vote!`,
    fields: [
      { name: "Balanced Teams", value: `${balancedCount} / 3`, inline: true },
      { name: "Captains", value: `${captainsCount} / 3`, inline: true },
    ],
  };
}

function voteButtons(seriesId: string) {
  return [
    {
      type: MessageComponentTypes.ACTION_ROW,
      components: [
        { type: MessageComponentTypes.BUTTON, style: ButtonStyleTypes.PRIMARY, label: "Balanced", custom_id: `vote:${seriesId}:balanced` },
        { type: MessageComponentTypes.BUTTON, style: ButtonStyleTypes.PRIMARY, label: "Captains", custom_id: `vote:${seriesId}:captains` },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Series-length vote message: Best of 3/5/7, first to 3/6 wins, same shape as the Balanced vs
// Captains vote above. Runs *before* that vote when series_length_vote_enabled is on — see
// startSeriesLengthVote/resolveSeriesLengthVote below.
// ---------------------------------------------------------------------------

function seriesLengthVoteEmbed(bo3Count: number, bo5Count: number, bo7Count: number, timeoutSeconds: number, supercharged: boolean) {
  const minutes = Math.round(timeoutSeconds / 60);
  return {
    color: supercharged ? SUPERCHARGED_COLOR : BRAND_COLOR,
    description: `You have **${minutes} minute${minutes === 1 ? "" : "s"}** to vote on series length!`,
    fields: [
      { name: `${SERIES_LENGTH_K_MULTIPLIERS.bo3 * 100}%`, value: `Best of 3\n${bo3Count} / 3`, inline: true },
      { name: `${SERIES_LENGTH_K_MULTIPLIERS.bo5 * 100}%`, value: `Best of 5\n${bo5Count} / 3`, inline: true },
      { name: `${SERIES_LENGTH_K_MULTIPLIERS.bo7 * 100}%`, value: `Best of 7\n${bo7Count} / 3`, inline: true },
    ],
  };
}

function seriesLengthVoteButtons(seriesId: string) {
  return [
    {
      type: MessageComponentTypes.ACTION_ROW,
      components: [
        { type: MessageComponentTypes.BUTTON, style: ButtonStyleTypes.PRIMARY, label: "Best of 3", custom_id: `series_length_vote:${seriesId}:bo3` },
        { type: MessageComponentTypes.BUTTON, style: ButtonStyleTypes.PRIMARY, label: "Best of 5", custom_id: `series_length_vote:${seriesId}:bo5` },
        { type: MessageComponentTypes.BUTTON, style: ButtonStyleTypes.PRIMARY, label: "Best of 7", custom_id: `series_length_vote:${seriesId}:bo7` },
      ],
    },
  ];
}

async function fetchLobbyMembers(supabase: AdminClient, seriesId: string): Promise<PlayerRow[]> {
  const { data: lobbyRows, error } = await supabase.from("crl6mansqueuebot_series_lobby").select("player_id").eq("series_id", seriesId);
  if (error) throw new Error(`Failed to fetch lobby: ${error.message}`);
  const playerIds = (lobbyRows ?? []).map((r) => r.player_id);
  if (playerIds.length === 0) return [];
  const { data: players, error: playersError } = await supabase.from("crl6mansqueuebot_players").select("*").in("id", playerIds);
  if (playersError) throw new Error(`Failed to fetch players: ${playersError.message}`);
  return players ?? [];
}

async function fetchLobbyRowsWithPlayers(supabase: AdminClient, seriesId: string): Promise<{ row: SeriesLobbyRow; player: PlayerRow }[]> {
  const { data: lobbyRows } = await supabase.from("crl6mansqueuebot_series_lobby").select("*").eq("series_id", seriesId);
  const rows = lobbyRows ?? [];
  const playerIds = rows.map((r) => r.player_id);
  if (playerIds.length === 0) return [];
  const { data: players } = await supabase.from("crl6mansqueuebot_players").select("*").in("id", playerIds);
  const byId = new Map((players ?? []).map((p) => [p.id, p]));
  return rows.map((row) => ({ row, player: byId.get(row.player_id) })).filter((x): x is { row: SeriesLobbyRow; player: PlayerRow } => Boolean(x.player));
}

// Entry point called by queue.ts once the series is created (feature disabled, or the series-
// length vote has just resolved) — posts the Balanced-vs-Captains vote message, then auto-casts
// any player's saved /vote-default preference (still overridable per game by clicking a button).
// Cast sequentially so a mid-loop resolution's follow-on writes (draft/balanced setup) can't
// interleave with a not-yet-processed auto-cast.
//
// `existingMessageId`, when passed, means the series-length vote already posted a message and
// resolved into this one — PATCH that message into the Balanced/Captains vote UI instead of
// posting a new one, so the whole flow (series-length tally -> this vote -> draft-turn UI) reads
// as one continuously-edited message rather than a new post per phase. Either way,
// `vote_started_at` is (re)stamped here so this vote gets its own full vote_timeout_seconds
// window regardless of how long the series-length vote (if any) took to resolve.
export async function startTeamFormation(
  supabase: AdminClient,
  guildId: string,
  seriesId: string,
  queueChannelId: string,
  members: PlayerRow[],
  existingMessageId?: string,
) {
  const timeoutSeconds = await getConfigNumber("vote_timeout_seconds", 180);
  const streaks = await getStreakIds(supabase, members.map((m) => m.id));
  const mentions = members.map((m) => mention(m.discord_id, { onFire: streaks.onFireIds.has(m.id), cold: streaks.coldIds.has(m.id) })).join(" ");
  const supercharged = await isSuperchargedSeries(supabase, seriesId);
  const body = { content: mentions, embeds: [voteEmbed(0, 0, timeoutSeconds, supercharged)], components: voteButtons(seriesId) };

  let messageId: string;
  if (existingMessageId) {
    messageId = existingMessageId;
    await discordFetch(`/channels/${queueChannelId}/messages/${existingMessageId}`, { method: "PATCH", body: JSON.stringify(body) });
  } else {
    const message = (await discordFetch(`/channels/${queueChannelId}/messages`, { method: "POST", body: JSON.stringify(body) })) as { id: string };
    messageId = message.id;
  }

  await supabase
    .from("crl6mansqueuebot_series")
    .update({ formation_message_id: messageId, vote_started_at: new Date().toISOString() })
    .eq("id", seriesId);

  for (const member of members) {
    if (member.vote_default) {
      await castVote(supabase, guildId, seriesId, queueChannelId, messageId, members, member.id, member.vote_default);
    }
  }
}

export async function castVote(
  supabase: AdminClient,
  guildId: string,
  seriesId: string,
  queueChannelId: string,
  messageId: string,
  members: PlayerRow[],
  playerId: string,
  choice: VoteChoice,
) {
  await supabase.from("crl6mansqueuebot_series_votes").upsert({ series_id: seriesId, player_id: playerId, choice });

  const { data: votes } = await supabase.from("crl6mansqueuebot_series_votes").select("choice").eq("series_id", seriesId);

  const balancedCount = (votes ?? []).filter((v) => v.choice === "balanced").length;
  const captainsCount = (votes ?? []).filter((v) => v.choice === "captains").length;

  let winner: VoteChoice | null = null;
  if (balancedCount >= 3) winner = "balanced";
  else if (captainsCount >= 3) winner = "captains";
  else if (balancedCount + captainsCount >= 6) winner = "captains"; // exact 3-3 tie

  if (!winner) {
    const timeoutSeconds = await getConfigNumber("vote_timeout_seconds", 180);
    const supercharged = await isSuperchargedSeries(supabase, seriesId);
    await discordFetch(`/channels/${queueChannelId}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ embeds: [voteEmbed(balancedCount, captainsCount, timeoutSeconds, supercharged)], components: voteButtons(seriesId) }),
    });
    return;
  }

  // Atomic resolution claim: a plain `UPDATE ... WHERE vote_result IS NULL` serializes
  // concurrent winning votes via Postgres's row-level locking — the second writer's WHERE
  // clause no longer matches once the first commits, so only one caller proceeds past here.
  const { data: claimed } = await supabase
    .from("crl6mansqueuebot_series")
    .update({ vote_result: winner })
    .eq("id", seriesId)
    .is("vote_result", null)
    .select("id");
  if (!claimed || claimed.length === 0) return;

  // Replace the vote message with a short "___ Chosen!" announcement — the announcement's own
  // message id becomes the new formation_message_id, so the balanced-summary/captains-draft UI
  // that follows (sendDraftPickPrompt PATCHes whatever formation_message_id currently is) picks
  // up from here rather than trying to edit the now-deleted vote message.
  const supercharged = await isSuperchargedSeries(supabase, seriesId);
  await discordFetch(`/channels/${queueChannelId}/messages/${messageId}`, { method: "DELETE" }).catch(() => {});
  const chosenMessage = (await discordFetch(`/channels/${queueChannelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ embeds: [{ color: supercharged ? SUPERCHARGED_COLOR : BRAND_COLOR, description: `**${winner === "balanced" ? "Balanced" : "Captains"} Chosen!**` }] }),
  })) as { id: string };
  await supabase.from("crl6mansqueuebot_series").update({ formation_message_id: chosenMessage.id }).eq("id", seriesId);

  if (winner === "balanced") {
    await resolveBalanced(supabase, guildId, seriesId, queueChannelId, chosenMessage.id, members);
  } else {
    await beginCaptainsDraft(supabase, guildId, seriesId, queueChannelId, chosenMessage.id, members);
  }
}

// ---------------------------------------------------------------------------
// Series-length vote flow — runs before the Balanced/Captains vote when
// series_length_vote_enabled is on (queue.ts's createMatchChannels decides which one starts
// first; this vote never auto-casts from a saved default, since none exists for series length).
// ---------------------------------------------------------------------------

// Entry point called by queue.ts instead of startTeamFormation when the feature is enabled.
export async function startSeriesLengthVote(supabase: AdminClient, guildId: string, seriesId: string, queueChannelId: string, members: PlayerRow[]) {
  const timeoutSeconds = await getConfigNumber("vote_timeout_seconds", 180);
  const streaks = await getStreakIds(supabase, members.map((m) => m.id));
  const mentions = members.map((m) => mention(m.discord_id, { onFire: streaks.onFireIds.has(m.id), cold: streaks.coldIds.has(m.id) })).join(" ");
  const supercharged = await isSuperchargedSeries(supabase, seriesId);
  const message = (await discordFetch(`/channels/${queueChannelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: mentions, embeds: [seriesLengthVoteEmbed(0, 0, 0, timeoutSeconds, supercharged)], components: seriesLengthVoteButtons(seriesId) }),
  })) as { id: string };

  await supabase
    .from("crl6mansqueuebot_series")
    .update({ formation_message_id: message.id, vote_started_at: new Date().toISOString(), series_length_vote_active: true })
    .eq("id", seriesId);
}

// Shared tail for both the click-resolved and timeout-majority-resolved paths: atomically claims
// the outcome (same UPDATE...WHERE-IS-NULL pattern castVote uses for vote_result), writes the
// matching K-factor multiplier alongside it, clears series_length_vote_active (so the sweep
// route's Balanced/Captains timeout check picks this series back up instead of the series-length
// one), then hands off to startTeamFormation to PATCH the same message into the Balanced/Captains
// vote UI.
async function resolveSeriesLengthVote(
  supabase: AdminClient,
  guildId: string,
  seriesId: string,
  queueChannelId: string,
  messageId: string,
  members: PlayerRow[],
  winner: SeriesLength,
) {
  const { data: claimed } = await supabase
    .from("crl6mansqueuebot_series")
    .update({ series_length: winner, series_length_k_multiplier: SERIES_LENGTH_K_MULTIPLIERS[winner], series_length_vote_active: false })
    .eq("id", seriesId)
    .is("series_length", null)
    .select("id");
  if (!claimed || claimed.length === 0) return;

  // Announce the chosen series length as its own short-lived message — additive to, not a
  // replacement for, the existing hand-off: startTeamFormation below still PATCH-edits the same
  // `messageId` from the series-length vote UI directly into the Balanced/Captains vote UI.
  const supercharged = await isSuperchargedSeries(supabase, seriesId);
  await discordFetch(`/channels/${queueChannelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ embeds: [{ color: supercharged ? SUPERCHARGED_COLOR : BRAND_COLOR, description: `**${winner.toUpperCase()} Chosen!**` }] }),
  }).catch(() => {});

  await startTeamFormation(supabase, guildId, seriesId, queueChannelId, members, messageId);
}

export async function castSeriesLengthVote(
  supabase: AdminClient,
  guildId: string,
  seriesId: string,
  queueChannelId: string,
  messageId: string,
  members: PlayerRow[],
  playerId: string,
  choice: SeriesLength,
) {
  await supabase.from("crl6mansqueuebot_series_length_votes").upsert({ series_id: seriesId, player_id: playerId, choice });

  const { data: votes } = await supabase.from("crl6mansqueuebot_series_length_votes").select("choice").eq("series_id", seriesId);
  const counts: Record<SeriesLength, number> = {
    bo3: (votes ?? []).filter((v) => v.choice === "bo3").length,
    bo5: (votes ?? []).filter((v) => v.choice === "bo5").length,
    bo7: (votes ?? []).filter((v) => v.choice === "bo7").length,
  };
  const totalVotes = counts.bo3 + counts.bo5 + counts.bo7;

  let winner: SeriesLength | null = null;
  if (counts.bo3 >= SERIES_LENGTH_VOTE_THRESHOLD) winner = "bo3";
  else if (counts.bo5 >= SERIES_LENGTH_VOTE_THRESHOLD) winner = "bo5";
  else if (counts.bo7 >= SERIES_LENGTH_VOTE_THRESHOLD) winner = "bo7";
  else if (totalVotes >= 6) winner = resolveSeriesLengthTieBreak(counts); // exact 2-2-2 tie

  if (!winner) {
    const timeoutSeconds = await getConfigNumber("vote_timeout_seconds", 180);
    const supercharged = await isSuperchargedSeries(supabase, seriesId);
    await discordFetch(`/channels/${queueChannelId}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({
        embeds: [seriesLengthVoteEmbed(counts.bo3, counts.bo5, counts.bo7, timeoutSeconds, supercharged)],
        components: seriesLengthVoteButtons(seriesId),
      }),
    });
    return;
  }

  await resolveSeriesLengthVote(supabase, guildId, seriesId, queueChannelId, messageId, members, winner);
}

// Called by the sweep route once vote_timeout_seconds has elapsed with no winner reached —
// resolves by whichever option currently has the most votes, lowest-length tie-break (including
// the 0-0-0 case where nobody voted at all). Never voids the series — see CLAUDE.md.
export async function resolveSeriesLengthByMajority(supabase: AdminClient, series: SeriesRow): Promise<void> {
  if (!series.formation_message_id || !series.queue_channel_id) return;
  const guildId = await getGuildId();
  const { data: votes } = await supabase.from("crl6mansqueuebot_series_length_votes").select("choice").eq("series_id", series.id);
  const counts: Record<SeriesLength, number> = {
    bo3: (votes ?? []).filter((v) => v.choice === "bo3").length,
    bo5: (votes ?? []).filter((v) => v.choice === "bo5").length,
    bo7: (votes ?? []).filter((v) => v.choice === "bo7").length,
  };
  const winner = resolveSeriesLengthTieBreak(counts);
  const members = await fetchLobbyMembers(supabase, series.id);
  await resolveSeriesLengthVote(supabase, guildId, series.id, series.queue_channel_id, series.formation_message_id, members, winner);
}

export function handleSeriesLengthVoteButton(interaction: DiscordInteraction, seriesId: string, choice: SeriesLength) {
  after(() => processSeriesLengthVoteButton(interaction, seriesId, choice));
  return {
    type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE,
  };
}

async function processSeriesLengthVoteButton(interaction: DiscordInteraction, seriesId: string, choice: SeriesLength) {
  const supabase = createAdminClient();
  const discordId = interactionUserId(interaction);
  if (!discordId || !interaction.guild_id || !interaction.channel_id) {
    await replyError(interaction, "Couldn't identify you — try again.");
    return;
  }

  const { data: player } = await supabase.from("crl6mansqueuebot_players").select("*").eq("discord_id", discordId).maybeSingle();
  const { data: lobbyRow } = player
    ? await supabase.from("crl6mansqueuebot_series_lobby").select("player_id").eq("series_id", seriesId).eq("player_id", player.id).maybeSingle()
    : { data: null };
  if (!player || !lobbyRow) {
    await replyError(interaction, "You're not part of this match.");
    return;
  }

  const { data: series } = await supabase.from("crl6mansqueuebot_series").select("*").eq("id", seriesId).maybeSingle();
  if (!series || series.series_length || !series.formation_message_id) {
    await replyError(interaction, "Voting isn't open for this match anymore.");
    return;
  }

  const members = await fetchLobbyMembers(supabase, seriesId);
  await castSeriesLengthVote(supabase, interaction.guild_id, seriesId, interaction.channel_id, series.formation_message_id, members, player.id, choice);
}

// ---------------------------------------------------------------------------
// Vote button entry point
// ---------------------------------------------------------------------------

export function handleVoteButton(interaction: DiscordInteraction, seriesId: string, choice: VoteChoice) {
  after(() => processVoteButton(interaction, seriesId, choice));
  return {
    type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE,
  };
}

async function processVoteButton(interaction: DiscordInteraction, seriesId: string, choice: VoteChoice) {
  const supabase = createAdminClient();
  const discordId = interactionUserId(interaction);
  if (!discordId || !interaction.guild_id || !interaction.channel_id) {
    await replyError(interaction, "Couldn't identify you — try again.");
    return;
  }

  const { data: player } = await supabase.from("crl6mansqueuebot_players").select("*").eq("discord_id", discordId).maybeSingle();
  const { data: lobbyRow } = player
    ? await supabase.from("crl6mansqueuebot_series_lobby").select("player_id").eq("series_id", seriesId).eq("player_id", player.id).maybeSingle()
    : { data: null };
  if (!player || !lobbyRow) {
    await replyError(interaction, "You're not part of this match.");
    return;
  }

  const { data: series } = await supabase.from("crl6mansqueuebot_series").select("*").eq("id", seriesId).maybeSingle();
  if (!series || series.vote_result || !series.formation_message_id) {
    await replyError(interaction, "Voting isn't open for this match anymore.");
    return;
  }

  const members = await fetchLobbyMembers(supabase, seriesId);
  await castVote(supabase, interaction.guild_id, seriesId, interaction.channel_id, series.formation_message_id, members, player.id, choice);
}

// Casts (or re-casts) `playerId`'s cancel vote against `series` and, once CANCEL_VOTE_THRESHOLD
// is reached, atomically voids it (same UPDATE...WHERE-status-IN claim pattern used throughout
// this codebase, so a race against a simultaneous /report or /abandon can't double-settle).
// Called by the /cancel slash command below, for both 'forming' and 'active' series. Voice
// channels only exist once a series is 'active' (finalizeTeams creates them) —
// deleteMatchChannels no-ops on the null ids a still-'forming' series has.
async function registerCancelVoteAndMaybeVoid(
  supabase: AdminClient,
  series: SeriesRow,
  playerId: string,
): Promise<{ cancelCount: number; voided: boolean }> {
  await supabase.from("crl6mansqueuebot_cancel_votes").upsert({ series_id: series.id, player_id: playerId });

  const { data: cancelVotes } = await supabase.from("crl6mansqueuebot_cancel_votes").select("player_id").eq("series_id", series.id);
  const cancelCount = (cancelVotes ?? []).length;
  if (cancelCount < CANCEL_VOTE_THRESHOLD) return { cancelCount, voided: false };

  const { data: claimed } = await supabase
    .from("crl6mansqueuebot_series")
    .update({ status: "void", winner_team: null })
    .eq("id", series.id)
    .in("status", ["forming", "active"])
    .select("id");
  if (!claimed || claimed.length === 0) return { cancelCount, voided: false };

  await clearPendingSeriesState(supabase, series.id);
  await supabase.from("crl6mansqueuebot_series_votes").delete().eq("series_id", series.id);
  await supabase.from("crl6mansqueuebot_cancel_votes").delete().eq("series_id", series.id);

  if (series.formation_message_id && series.queue_channel_id) {
    await discordFetch(`/channels/${series.queue_channel_id}/messages/${series.formation_message_id}`, { method: "DELETE" }).catch(() => {});
  }
  if (series.queue_channel_id) {
    await discordFetch(`/channels/${series.queue_channel_id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content: `**Series cancelled** — ${CANCEL_VOTE_THRESHOLD} players voted to cancel. No MMR change.`,
      }),
    }).catch(() => {});
  }

  // The 6 popped players are freed the instant this settles, but the queue channel's tracked
  // status message was deliberately left un-refreshed at pop time (see handlePop's comment in
  // queue.ts) and nothing since has touched it — without this call it would keep showing the
  // stale pre-pop 6/6 roster as "currently queued" until some unrelated future /q or /l happened
  // to replace it, which reads to players as the queue randomly "resetting."
  await refreshQueueMessage(supabase, series.queue_type);

  // Same 30s closing-warning window /report and /abandon use before the actual voice-channel
  // teardown — no-op for a still-'forming' void, since voice channels don't exist yet.
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  await deleteMatchChannels(supabase, series);

  return { cancelCount, voided: true };
}

// ---------------------------------------------------------------------------
// /cancel — usable by any of the 6 players in a popped match, in either 'forming' or 'active'
// status (no vote-message button anymore — removed since it duplicated /cancel as a voting
// option; this command is now the only way to cast a cancel vote). Casts a no-fault cancel
// vote toward the same CANCEL_VOTE_THRESHOLD; no target, unlike /abandon (see
// CLAUDE.md, "Mid-series abandonment") which blames a specific player and needs only 3 of the
// remaining 5. `id:` is an optional admin-gated override, same pattern as /report/`/sub`/`/abandon`.
// ---------------------------------------------------------------------------

export function handleCancelCommand(interaction: DiscordInteraction) {
  const idOption = interaction.data?.options?.find((o) => o.name === "id")?.value;
  const seriesIdOverride = typeof idOption === "string" && idOption.length > 0 ? idOption : null;
  after(() => processCancelCommand(interaction, seriesIdOverride));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processCancelCommand(interaction: DiscordInteraction, seriesIdOverride: string | null) {
  const supabase = createAdminClient();
  const discordId = interactionUserId(interaction);
  if (!discordId) {
    await editOriginalResponse(interaction.token, { content: "Couldn't identify you — try again." });
    return;
  }

  const caller = await getOrCreatePlayer(supabase, discordId, interactionDisplayName(interaction));

  let series: SeriesRow | null;
  if (seriesIdOverride) {
    if (!(await hasAdminAccess(interaction))) {
      await editOriginalResponse(interaction.token, { content: "Only admins can cancel by id: from outside the match." });
      return;
    }
    const { data } = await supabase.from("crl6mansqueuebot_series").select("*").eq("id", seriesIdOverride).maybeSingle();
    series = data;
  } else {
    series = await getLockedSeriesForPlayer(supabase, caller.id);
  }

  if (!series) {
    await editOriginalResponse(interaction.token, { content: seriesIdOverride ? "Series not found." : "You're not part of an active match." });
    return;
  }
  if (series.status !== "forming" && series.status !== "active") {
    await editOriginalResponse(interaction.token, { content: "This match has already been settled." });
    return;
  }

  const { voided, cancelCount } = await registerCancelVoteAndMaybeVoid(supabase, series, caller.id);
  await editOriginalResponse(interaction.token, {
    content: voided
      ? "Series cancelled — enough players voted to cancel."
      : `Vote recorded — ${cancelCount}/${CANCEL_VOTE_THRESHOLD} needed to cancel this match.`,
  });

  // Public announcement so the other players actually see the vote happening, not just the
  // caller's own ephemeral confirmation above — the settled "Series cancelled" message already
  // posts publicly on its own (registerCancelVoteAndMaybeVoid), so this only fires pre-threshold.
  if (!voided && series.queue_channel_id) {
    await discordFetch(`/channels/${series.queue_channel_id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        embeds: [{ description: `<@${discordId}> wants to cancel ${cancelCount}/${CANCEL_VOTE_THRESHOLD}`, color: BRAND_COLOR }],
      }),
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Balanced mode: brute-force all 10 unique 3v3 splits, pick the smallest team-strength gap
// (calculateTeamStrength — see web/lib/mmr/teamStrength.ts, also used by the Elo engine).
// ---------------------------------------------------------------------------

export function bestBalancedSplit(members: PlayerRow[]): { teamA: PlayerRow[]; teamB: PlayerRow[] } {
  let best: { teamA: PlayerRow[]; teamB: PlayerRow[]; diff: number } | null = null;
  const seenSplits = new Set<string>();

  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      for (let k = j + 1; k < members.length; k++) {
        const teamA = [members[i], members[j], members[k]];
        const teamAIds = new Set(teamA.map((p) => p.id));
        const teamB = members.filter((m) => !teamAIds.has(m.id));

        const splitKey = [teamA, teamB]
          .map((team) => team.map((p) => p.id).sort().join(","))
          .sort()
          .join("|");
        if (seenSplits.has(splitKey)) continue;
        seenSplits.add(splitKey);

        const strengthA = calculateTeamStrength(teamA.map((p) => p.mmr));
        const strengthB = calculateTeamStrength(teamB.map((p) => p.mmr));
        const diff = Math.abs(strengthA - strengthB);
        if (!best || diff < best.diff) best = { teamA, teamB, diff };
      }
    }
  }

  return { teamA: best!.teamA, teamB: best!.teamB };
}

async function resolveBalanced(supabase: AdminClient, guildId: string, seriesId: string, queueChannelId: string, messageId: string, members: PlayerRow[]) {
  const { teamA, teamB } = bestBalancedSplit(members);
  const teamAssignments = new Map<string, Team>();
  teamA.forEach((p) => teamAssignments.set(p.id, "A"));
  teamB.forEach((p) => teamAssignments.set(p.id, "B"));

  await Promise.all(
    members.map((m) =>
      supabase
        .from("crl6mansqueuebot_series_lobby")
        .update({ team: teamAssignments.get(m.id) })
        .eq("series_id", seriesId)
        .eq("player_id", m.id),
    ),
  );

  await finalizeTeams(supabase, guildId, seriesId, queueChannelId, messageId, members, teamAssignments);
}

// ---------------------------------------------------------------------------
// Captains mode: captains are drawn from *ranked* (is_placed) players first, falling back to
// unranked players only to the extent there aren't enough ranked players in the lobby to fill
// both captain slots — see CLAUDE.md, "Team formation (on pop)" for the four scenarios this
// covers. Draft order (Captain A picks 1, Captain B picks 2, last remaining player auto-assigns
// to Captain A) is derived purely by counting how many non-captain lobby rows already have a
// team — no separate turn column.
// ---------------------------------------------------------------------------

export function deriveTurnCaptain(nonCaptainAssignedCount: number): Team | null {
  if (nonCaptainAssignedCount === 0) return "A";
  if (nonCaptainAssignedCount === 1 || nonCaptainAssignedCount === 2) return "B";
  return null; // 3 assigned -> the 4th auto-assigns, draft is complete
}

function byMmrDesc(a: PlayerRow, b: PlayerRow): number {
  return b.mmr - a.mmr || a.discord_id.localeCompare(b.discord_id);
}

// Randomly excludes one of exactly 3 candidates, returning the other two.
function pickTwoOfThreeRandom(topThree: PlayerRow[]): [PlayerRow, PlayerRow] {
  const excluded = topThree[Math.floor(Math.random() * topThree.length)];
  const [a, b] = topThree.filter((p) => p.id !== excluded.id);
  return [a, b];
}

// Randomly picks 1 candidate out of the top n (by MMR) of the given pool.
function pickOneRandomFromTop(sorted: PlayerRow[], n: number): PlayerRow {
  const top = sorted.slice(0, n);
  return top[Math.floor(Math.random() * top.length)];
}

// Selects the 2 (unordered) captain candidates for a 6-player lobby. Ranked players are always
// preferred over unranked ones — unranked players are only ever drawn on to fill a captain slot
// ranked players couldn't, never to replace one. See CLAUDE.md, "Team formation (on pop)":
//   - 3+ ranked players: top 3 ranked by MMR, 2 of them chosen at random (unchanged from before
//     this only ever considered the whole lobby's top 3 rather than ranked players specifically).
//   - Exactly 2 ranked players: both become captains outright, no randomness.
//   - Exactly 1 ranked player: that player plus 1 random pick from the top 2 unranked by MMR.
//   - 0 ranked players: top 3 unranked by MMR, 2 of them chosen at random (same shape as the 3+
//     ranked case, just sourced from the unranked pool instead).
export function selectCaptainCandidates(members: PlayerRow[]): [PlayerRow, PlayerRow] {
  const ranked = members.filter((m) => m.is_placed).sort(byMmrDesc);
  const unranked = members.filter((m) => !m.is_placed).sort(byMmrDesc);

  if (ranked.length >= 3) return pickTwoOfThreeRandom(ranked.slice(0, 3));
  if (ranked.length === 2) return [ranked[0], ranked[1]];
  if (ranked.length === 1) return [ranked[0], pickOneRandomFromTop(unranked, 2)];
  return pickTwoOfThreeRandom(unranked.slice(0, 3));
}

async function beginCaptainsDraft(supabase: AdminClient, guildId: string, seriesId: string, queueChannelId: string, messageId: string, members: PlayerRow[]) {
  const [pickedA, pickedB] = selectCaptainCandidates(members);
  // Which of the two chosen captains picks first (Captain A) is a coin flip — not tied to MMR,
  // ranked status, or which one is "picked[0]" — see CLAUDE.md, "Team formation (on pop)".
  const captainA = Math.random() < 0.5 ? pickedA : pickedB;
  const captainB = captainA === pickedA ? pickedB : pickedA;

  await supabase.from("crl6mansqueuebot_series_lobby").update({ team: "A", is_captain: true }).eq("series_id", seriesId).eq("player_id", captainA.id);
  await supabase.from("crl6mansqueuebot_series_lobby").update({ team: "B", is_captain: true }).eq("series_id", seriesId).eq("player_id", captainB.id);

  const remaining = members.filter((m) => m.id !== captainA.id && m.id !== captainB.id);
  await sendDraftPickPrompt(queueChannelId, messageId, seriesId, captainA, captainB, remaining, "A");
  await autoAdvanceDraftIfFake(supabase, guildId, seriesId);
}

// Auto-plays a captains-draft pick on behalf of a synthetic test player (is_test_data) whose
// turn it is — used by /test-rank-match and /test-universal-match (testMatch.ts), where fake
// lobby members have no real Discord account to click a "Choose" button with. No-ops the
// instant the turn belongs to a real player, so this has zero effect on ordinary matches.
// Re-fetches fresh state on every call rather than threading it through the caller, and
// recurses so a fake captain's back-to-back picks (Captain B picks twice in a row) both
// resolve in one pass.
async function autoAdvanceDraftIfFake(supabase: AdminClient, guildId: string, seriesId: string) {
  const { data: series } = await supabase.from("crl6mansqueuebot_series").select("*").eq("id", seriesId).maybeSingle();
  if (!series || series.vote_result !== "captains" || series.status !== "forming" || !series.queue_channel_id || !series.formation_message_id) return;

  const lobby = await fetchLobbyRowsWithPlayers(supabase, seriesId);
  const captainARow = lobby.find((x) => x.row.is_captain && x.row.team === "A");
  const captainBRow = lobby.find((x) => x.row.is_captain && x.row.team === "B");
  if (!captainARow || !captainBRow) return;

  const nonCaptainRows = lobby.filter((x) => !x.row.is_captain);
  const assignedCount = nonCaptainRows.filter((x) => x.row.team).length;
  const turnCaptain = deriveTurnCaptain(assignedCount);
  if (!turnCaptain) return;

  const turnCaptainPlayer = turnCaptain === "A" ? captainARow.player : captainBRow.player;
  if (!turnCaptainPlayer.is_test_data) return;

  const target = nonCaptainRows.find((x) => !x.row.team);
  if (!target) return;

  const { data: claimed } = await supabase
    .from("crl6mansqueuebot_series_lobby")
    .update({ team: turnCaptain })
    .eq("series_id", seriesId)
    .eq("player_id", target.row.player_id)
    .is("team", null)
    .select("player_id");
  if (!claimed || claimed.length === 0) return; // lost a race (e.g. a real pick landed first)

  const newAssignedCount = assignedCount + 1;
  const allMembers = lobby.map((x) => x.player);

  if (newAssignedCount >= 3) {
    const lastRemaining = nonCaptainRows.find((x) => x.row.player_id !== target.row.player_id && !x.row.team);
    const teamAssignments = new Map<string, Team>();
    for (const x of lobby) if (x.row.team) teamAssignments.set(x.row.player_id, x.row.team);
    teamAssignments.set(target.row.player_id, turnCaptain);
    if (lastRemaining) {
      await supabase.from("crl6mansqueuebot_series_lobby").update({ team: "A" }).eq("series_id", seriesId).eq("player_id", lastRemaining.row.player_id);
      teamAssignments.set(lastRemaining.row.player_id, "A");
    }
    await finalizeTeams(supabase, guildId, seriesId, series.queue_channel_id, series.formation_message_id, allMembers, teamAssignments);
    return;
  }

  const nextTurn = deriveTurnCaptain(newAssignedCount)!;
  const remaining = nonCaptainRows.filter((x) => x.row.player_id !== target.row.player_id && !x.row.team).map((x) => x.player);
  await sendDraftPickPrompt(series.queue_channel_id, series.formation_message_id, seriesId, captainARow.player, captainBRow.player, remaining, nextTurn);

  await autoAdvanceDraftIfFake(supabase, guildId, seriesId);
}

function draftPickButtonRows(seriesId: string, remaining: PlayerRow[]) {
  const buttonRows = [];
  for (let i = 0; i < remaining.length; i += 5) {
    buttonRows.push({
      type: MessageComponentTypes.ACTION_ROW,
      components: remaining.slice(i, i + 5).map((p) => ({
        type: MessageComponentTypes.BUTTON,
        style: ButtonStyleTypes.SECONDARY,
        label: p.display_name.slice(0, 80),
        custom_id: `draft_pick:${seriesId}:${p.id}`,
      })),
    });
  }
  return buttonRows;
}

// A STRING_SELECT with min_values === max_values === pickCount collapses what would otherwise
// be `pickCount` separate round-trips into one interaction — Discord auto-submits once exactly
// that many options are selected. Used for Captain B's turn (2 picks at once) instead of the
// button flow above. Discord caps select option label/description at 100 chars each.
function draftPickSelectRow(seriesId: string, remaining: PlayerRow[], pickCount: number, descriptions: Map<string, string>) {
  return [
    {
      type: MessageComponentTypes.ACTION_ROW,
      components: [
        {
          type: MessageComponentTypes.STRING_SELECT,
          custom_id: `draft_pick_multi:${seriesId}`,
          placeholder: `Choose ${pickCount} players`,
          min_values: pickCount,
          max_values: pickCount,
          options: remaining.map((p) => ({
            label: p.display_name.slice(0, 100),
            value: p.id,
            description: (descriptions.get(p.id) ?? "").slice(0, 100),
          })),
        },
      ],
    },
  ];
}

// How many players the captain whose turn it is needs to pick right now. Captain A always
// picks 1; Captain B picks however many are left minus 1 (the last one auto-assigns to A —
// see CLAUDE.md, "Team formation (on pop)"). Normally that's 2 (6 players - 2 captains - A's 1
// pick = 3 remaining, B picks 2), computed from `remainingCount` rather than hardcoded so an
// in-flight draft mid-deploy (e.g. B already picked 1 under the old one-at-a-time flow) still
// resolves correctly with a 1-pick button prompt instead of a stale 2-pick expectation.
function expectedPickCount(turnCaptain: Team, remainingCount: number): number {
  return turnCaptain === "B" ? Math.max(1, remainingCount - 1) : 1;
}

function captainsDraftEmbed(captainA: PlayerRow, captainB: PlayerRow, turnCaptain: Team, status: string, streaks: StreakIds, supercharged: boolean) {
  const turnName = turnCaptain === "A" ? "Captain A" : "Captain B";
  return {
    color: supercharged ? SUPERCHARGED_COLOR : BRAND_COLOR,
    title: "Captains Draft",
    fields: [
      { name: "Captain A", value: mention(captainA.discord_id, { onFire: streaks.onFireIds.has(captainA.id), cold: streaks.coldIds.has(captainA.id) }), inline: true },
      { name: "Captain B", value: mention(captainB.discord_id, { onFire: streaks.onFireIds.has(captainB.id), cold: streaks.coldIds.has(captainB.id) }), inline: true },
      { name: "Status", value: status, inline: false },
    ],
  };
}

// Picks are made via DM to whichever captain currently has the turn (not channel buttons —
// see CLAUDE.md, "Other user commands"/pop-to-report flow: "The bot will send a DM to the
// first captain... Then a message for the second captain..."). Discord gives bots no way to
// force-open a DM to a user who has DMs closed to non-friends — sendDirectMessage's boolean
// return is how we detect that and fall back to posting the same pick buttons directly in the
// match channel instead, @-mentioning the captain so it's obvious the fallback happened. A
// synthetic test-data captain (/test-rank-match etc.) has no real Discord account to DM, so its
// turn is rendered as a channel status line with no buttons — autoAdvanceDraftIfFake resolves
// it immediately after this call, without any interaction.
async function sendDraftPickPrompt(
  textChannelId: string,
  messageId: string,
  seriesId: string,
  captainA: PlayerRow,
  captainB: PlayerRow,
  remaining: PlayerRow[],
  turnCaptain: Team,
) {
  const turnPlayer = turnCaptain === "A" ? captainA : captainB;
  const supabase = createAdminClient();
  const streaks = await getStreakIds(supabase, [captainA.id, captainB.id, ...remaining.map((p) => p.id)]);
  const turnPlayerDecoration = { onFire: streaks.onFireIds.has(turnPlayer.id), cold: streaks.coldIds.has(turnPlayer.id) };
  const supercharged = await isSuperchargedSeries(supabase, seriesId);

  if (turnPlayer.is_test_data) {
    const statusText = `Waiting on ${mention(turnPlayer.discord_id, turnPlayerDecoration)} (test bot)...`;
    await discordFetch(`/channels/${textChannelId}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({
        content: "",
        embeds: [captainsDraftEmbed(captainA, captainB, turnCaptain, statusText, streaks, supercharged)],
        components: [],
      }),
    });
    return;
  }

  const pickCount = expectedPickCount(turnCaptain, remaining.length);
  const dmContent = pickCount > 1 ? `**Captains Draft — pick ${pickCount} players**` : `**Captains Draft — your pick**`;

  // Create embed with player information, and in parallel a short "MMR | W-L" description
  // per player reused by the multi-select's option descriptions below.
  const embedFields = [];
  const descriptions = new Map<string, string>();

  for (const player of remaining) {
    // Prism is a live top-N overlay (see CLAUDE.md, "Bands / ranks"), not a `band` column value.
    const emoji = await getRankEmoji(player.is_prism ? "Prism" : player.band);
    const displayMMR = await getDisplayMMR(player.mmr);
    const { data: seriesPlayerRows } = await supabase
      .from("crl6mansqueuebot_series_players")
      .select("team, series_id")
      .eq("player_id", player.id);

    if (!seriesPlayerRows || seriesPlayerRows.length === 0) {
      embedFields.push({
        name: player.display_name,
        value: `${displayMMR.toFixed(0)} MMR ${emoji} | **W:** 0 | **L:** 0`,
        inline: false,
      });
      descriptions.set(player.id, `${displayMMR.toFixed(0)} MMR | W: 0 | L: 0`);
      continue;
    }

    const seriesIds = seriesPlayerRows.map((sp) => sp.series_id);
    const { data: seriesRows } = await supabase.from("crl6mansqueuebot_series").select("id, winner_team").in("id", seriesIds);

    let wins = 0;
    if (seriesRows) {
      for (const sp of seriesPlayerRows) {
        const series = seriesRows.find((s) => s.id === sp.series_id);
        if (series && series.winner_team === sp.team) {
          wins++;
        }
      }
    }

    const losses = seriesPlayerRows.length - wins;
    embedFields.push({
      name: player.display_name,
      value: `${displayMMR.toFixed(0)} MMR ${emoji} | **W:** ${wins} | **L:** ${losses}`,
      inline: false,
    });
    descriptions.set(player.id, `${displayMMR.toFixed(0)} MMR | W: ${wins} | L: ${losses}`);
  }

  const embed = {
    title: pickCount > 1 ? `Choose ${pickCount} Players` : "Choose a Player",
    color: supercharged ? SUPERCHARGED_COLOR : BRAND_COLOR,
    fields: embedFields,
  };

  const componentRows = pickCount > 1 ? draftPickSelectRow(seriesId, remaining, pickCount, descriptions) : draftPickButtonRows(seriesId, remaining);

  const dmSent = await sendDirectMessage(turnPlayer.discord_id, dmContent, componentRows, [embed]);

  if (dmSent) {
    const statusText = `${mention(turnPlayer.discord_id, turnPlayerDecoration)} your picking - check your DMs!`;
    await discordFetch(`/channels/${textChannelId}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({
        content: "",
        embeds: [captainsDraftEmbed(captainA, captainB, turnCaptain, statusText, streaks, supercharged)],
        components: [],
      }),
    });
  } else {
    const statusText = `${mention(turnPlayer.discord_id, turnPlayerDecoration)} - Your DMs are closed. Pick from the ${pickCount > 1 ? "menu" : "buttons"} below:`;
    await discordFetch(`/channels/${textChannelId}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({
        content: "",
        embeds: [captainsDraftEmbed(captainA, captainB, turnCaptain, statusText, streaks, supercharged)],
        components: componentRows,
      }),
    });
  }
}

export function handleDraftPickButton(interaction: DiscordInteraction, seriesId: string, pickedPlayerId: string) {
  after(() => processDraftPick(interaction, seriesId, pickedPlayerId));
  return {
    type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE,
  };
}

async function processDraftPick(interaction: DiscordInteraction, seriesId: string, pickedPlayerId: string) {
  const supabase = createAdminClient();
  const discordId = interactionUserId(interaction);
  if (!discordId) {
    await replyError(interaction, "Couldn't identify you — try again.");
    return;
  }
  // Draft picks are DM-driven now (see sendDraftPickPrompt) — a DM interaction has no guild_id
  // of its own, so this resolves the bot's single guild the same way background jobs without
  // an interaction payload do (getGuildId, rest.ts). The channel-fallback pick case (DMs
  // closed) still arrives with a real guild_id and just short-circuits to it below.
  const guildId = interaction.guild_id ?? (await getGuildId());

  const { data: series } = await supabase.from("crl6mansqueuebot_series").select("*").eq("id", seriesId).maybeSingle();
  if (!series || series.vote_result !== "captains" || series.status !== "forming" || !series.queue_channel_id || !series.formation_message_id) {
    await replyError(interaction, "The draft isn't active for this match.");
    return;
  }

  const lobby = await fetchLobbyRowsWithPlayers(supabase, seriesId);
  const captainARow = lobby.find((x) => x.row.is_captain && x.row.team === "A");
  const captainBRow = lobby.find((x) => x.row.is_captain && x.row.team === "B");
  if (!captainARow || !captainBRow) {
    await replyError(interaction, "Something's wrong with this draft — ask an admin to check it.");
    return;
  }

  const nonCaptainRows = lobby.filter((x) => !x.row.is_captain);
  const assignedCount = nonCaptainRows.filter((x) => x.row.team).length;
  const turnCaptain = deriveTurnCaptain(assignedCount);
  if (!turnCaptain) {
    await replyError(interaction, "The draft has already finished.");
    return;
  }

  const turnCaptainPlayer = turnCaptain === "A" ? captainARow.player : captainBRow.player;
  if (turnCaptainPlayer.discord_id !== discordId) {
    await replyError(interaction, "It's not your pick.");
    return;
  }

  const target = nonCaptainRows.find((x) => x.row.player_id === pickedPlayerId);
  if (!target || target.row.team) {
    await replyError(interaction, "That player isn't available to pick.");
    return;
  }

  const { data: claimed } = await supabase
    .from("crl6mansqueuebot_series_lobby")
    .update({ team: turnCaptain })
    .eq("series_id", seriesId)
    .eq("player_id", pickedPlayerId)
    .is("team", null)
    .select("player_id");
  if (!claimed || claimed.length === 0) {
    await replyError(interaction, "That pick already happened.");
    return;
  }

  // Best-effort pick confirmation — mirrors sendDraftPickPrompt's is_test_data guard, since a
  // synthetic test captain has no real Discord account to DM (sendDirectMessage would just fail).
  if (!turnCaptainPlayer.is_test_data) {
    await sendDirectMessage(turnCaptainPlayer.discord_id, `You picked **${target.player.display_name}**.`);
  }

  const newAssignedCount = assignedCount + 1;
  const allMembers = lobby.map((x) => x.player);

  if (newAssignedCount >= 3) {
    const lastRemaining = nonCaptainRows.find((x) => x.row.player_id !== pickedPlayerId && !x.row.team);
    const teamAssignments = new Map<string, Team>();
    for (const x of lobby) if (x.row.team) teamAssignments.set(x.row.player_id, x.row.team);
    teamAssignments.set(pickedPlayerId, turnCaptain);
    if (lastRemaining) {
      await supabase.from("crl6mansqueuebot_series_lobby").update({ team: "A" }).eq("series_id", seriesId).eq("player_id", lastRemaining.row.player_id);
      teamAssignments.set(lastRemaining.row.player_id, "A");
    }
    await finalizeTeams(supabase, guildId, seriesId, series.queue_channel_id, series.formation_message_id, allMembers, teamAssignments);
  } else {
    const nextTurn = deriveTurnCaptain(newAssignedCount)!;
    const remaining = nonCaptainRows.filter((x) => x.row.player_id !== pickedPlayerId && !x.row.team).map((x) => x.player);
    await sendDraftPickPrompt(series.queue_channel_id, series.formation_message_id, seriesId, captainARow.player, captainBRow.player, remaining, nextTurn);
    await autoAdvanceDraftIfFake(supabase, guildId, seriesId);
  }
}

// Multi-select entry point for Captain B's pick (normally 2 players in one interaction — see
// draftPickSelectRow/expectedPickCount above). Mirrors processDraftPick's validation, but
// claims every selected player in one UPDATE...WHERE-IN...IS-NULL call so a partial race (some
// of the selected players already claimed by the time this lands) can't split-brain the draft:
// if the claim comes back short, everything it did manage to claim is reverted and the captain
// is asked to retry rather than leaving the draft in a half-assigned state.
export function handleDraftPickMultiButton(interaction: DiscordInteraction, seriesId: string, pickedPlayerIds: string[]) {
  after(() => processDraftPickMulti(interaction, seriesId, pickedPlayerIds));
  return {
    type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE,
  };
}

async function processDraftPickMulti(interaction: DiscordInteraction, seriesId: string, pickedPlayerIds: string[]) {
  const supabase = createAdminClient();
  const discordId = interactionUserId(interaction);
  if (!discordId) {
    await replyError(interaction, "Couldn't identify you — try again.");
    return;
  }
  const guildId = interaction.guild_id ?? (await getGuildId());

  const { data: series } = await supabase.from("crl6mansqueuebot_series").select("*").eq("id", seriesId).maybeSingle();
  if (!series || series.vote_result !== "captains" || series.status !== "forming" || !series.queue_channel_id || !series.formation_message_id) {
    await replyError(interaction, "The draft isn't active for this match.");
    return;
  }

  const lobby = await fetchLobbyRowsWithPlayers(supabase, seriesId);
  const captainARow = lobby.find((x) => x.row.is_captain && x.row.team === "A");
  const captainBRow = lobby.find((x) => x.row.is_captain && x.row.team === "B");
  if (!captainARow || !captainBRow) {
    await replyError(interaction, "Something's wrong with this draft — ask an admin to check it.");
    return;
  }

  const nonCaptainRows = lobby.filter((x) => !x.row.is_captain);
  const assignedCount = nonCaptainRows.filter((x) => x.row.team).length;
  const turnCaptain = deriveTurnCaptain(assignedCount);
  if (!turnCaptain) {
    await replyError(interaction, "The draft has already finished.");
    return;
  }

  const turnCaptainPlayer = turnCaptain === "A" ? captainARow.player : captainBRow.player;
  if (turnCaptainPlayer.discord_id !== discordId) {
    await replyError(interaction, "It's not your pick.");
    return;
  }

  const available = nonCaptainRows.filter((x) => !x.row.team);
  const availableIds = new Set(available.map((x) => x.row.player_id));
  const uniquePickedIds = [...new Set(pickedPlayerIds)];
  const requiredCount = expectedPickCount(turnCaptain, available.length);
  if (uniquePickedIds.length !== requiredCount || !uniquePickedIds.every((id) => availableIds.has(id))) {
    await replyError(interaction, "That selection isn't valid anymore — the draft may have moved on.");
    return;
  }

  const { data: claimed } = await supabase
    .from("crl6mansqueuebot_series_lobby")
    .update({ team: turnCaptain })
    .eq("series_id", seriesId)
    .in("player_id", uniquePickedIds)
    .is("team", null)
    .select("player_id");
  const claimedIds = (claimed ?? []).map((c) => c.player_id);

  if (claimedIds.length === 0) {
    await replyError(interaction, "Those picks already happened.");
    return;
  }

  if (claimedIds.length < uniquePickedIds.length) {
    // Partial race — someone else claimed one of the selected players first. Revert what we
    // did manage to claim rather than leaving the draft in a half-assigned state.
    await supabase.from("crl6mansqueuebot_series_lobby").update({ team: null }).eq("series_id", seriesId).in("player_id", claimedIds);
    await replyError(interaction, "One of those players was just picked — try again.");
    return;
  }

  // Best-effort pick confirmation — same is_test_data guard as the single-pick path above.
  if (!turnCaptainPlayer.is_test_data) {
    const pickedNames = claimedIds
      .map((id) => nonCaptainRows.find((x) => x.row.player_id === id)?.player.display_name)
      .filter((n): n is string => Boolean(n));
    await sendDirectMessage(turnCaptainPlayer.discord_id, `You picked **${pickedNames.join(", ")}**.`);
  }

  const newAssignedCount = assignedCount + claimedIds.length;
  const allMembers = lobby.map((x) => x.player);
  const claimedIdSet = new Set(claimedIds);

  if (newAssignedCount >= 3) {
    const lastRemaining = nonCaptainRows.find((x) => !claimedIdSet.has(x.row.player_id) && !x.row.team);
    const teamAssignments = new Map<string, Team>();
    for (const x of lobby) if (x.row.team) teamAssignments.set(x.row.player_id, x.row.team);
    for (const id of claimedIds) teamAssignments.set(id, turnCaptain);
    if (lastRemaining) {
      await supabase.from("crl6mansqueuebot_series_lobby").update({ team: "A" }).eq("series_id", seriesId).eq("player_id", lastRemaining.row.player_id);
      teamAssignments.set(lastRemaining.row.player_id, "A");
    }
    await finalizeTeams(supabase, guildId, seriesId, series.queue_channel_id, series.formation_message_id, allMembers, teamAssignments);
  } else {
    const nextTurn = deriveTurnCaptain(newAssignedCount)!;
    const remaining = nonCaptainRows.filter((x) => !claimedIdSet.has(x.row.player_id) && !x.row.team).map((x) => x.player);
    await sendDraftPickPrompt(series.queue_channel_id, series.formation_message_id, seriesId, captainARow.player, captainBRow.player, remaining, nextTurn);
    await autoAdvanceDraftIfFake(supabase, guildId, seriesId);
  }
}

// Live "preview" number for voice-channel naming while a match is still being played — the real
// match_number isn't assigned until the series actually reports (crl6mansqueuebot_assign_match_
// number, called from report.ts), so no genuine number exists yet at team-formation time. This
// estimates "what number would this match get if every currently in-flight match reported in the
// order it was created": the count of already-reported real matches, plus how many other
// in-flight real matches were created at or before this one. That second term is what makes
// multiple concurrent matches each get a distinct, increasing preview instead of every one of
// them showing the same "current max + 1" — but since matches don't necessarily *report* in pop
// order, a given match's preview can still end up different from its actual final match_number.
// Display-only and never persisted anywhere, so there's nothing to keep in sync when that happens.
async function computePreviewMatchNumber(supabase: AdminClient, seriesCreatedAt: string): Promise<number> {
  const [maxReportedResult, aheadCountResult] = await Promise.all([
    supabase
      .from("crl6mansqueuebot_series")
      .select("match_number")
      .eq("status", "reported")
      .eq("is_test_data", false)
      .not("match_number", "is", null)
      .order("match_number", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("crl6mansqueuebot_series")
      .select("*", { count: "exact", head: true })
      .in("status", ["forming", "active"])
      .eq("is_test_data", false)
      .lte("created_at", seriesCreatedAt),
  ]);
  const maxReported = (maxReportedResult.data as { match_number: number } | null)?.match_number ?? 0;
  const aheadCount = aheadCountResult.count ?? 0;
  return maxReported + aheadCount;
}

// ---------------------------------------------------------------------------
// Finalize: write series_players, drop the lobby, flip the series to 'active', create the
// two team voice channels, unlock the text channel's message lock, post a summary.
// See CLAUDE.md, "Match channels (created per series on pop)".
// ---------------------------------------------------------------------------

async function finalizeTeams(
  supabase: AdminClient,
  guildId: string,
  seriesId: string,
  queueChannelId: string,
  messageId: string,
  members: PlayerRow[],
  teamAssignments: Map<string, Team>,
) {
  await supabase.from("crl6mansqueuebot_series_players").insert(members.map((m) => ({ series_id: seriesId, player_id: m.id, team: teamAssignments.get(m.id)! })));
  await supabase.from("crl6mansqueuebot_series_lobby").delete().eq("series_id", seriesId);

  // Private match credentials — see CLAUDE.md, "Team formation (on pop)". Name is a fixed
  // constant, password is 4 random digits (leading zeros allowed) generated fresh per series.
  // teams_formed_at also backs the /report cooldown (see report.ts) — stamped here since this is
  // the single point both the balanced and captains-draft paths funnel through.
  const privateMatchPassword = Array.from({ length: 4 }, () => Math.floor(Math.random() * 10)).join("");
  const teamsFormedAt = new Date().toISOString();
  await supabase
    .from("crl6mansqueuebot_series")
    .update({ status: "active", teams_formed_at: teamsFormedAt, private_match_password: privateMatchPassword })
    .eq("id", seriesId);

  const teamA = members.filter((m) => teamAssignments.get(m.id) === "A");
  const teamB = members.filter((m) => teamAssignments.get(m.id) === "B");

  // Fetch created_at (for the voice-channel preview number below) plus the two fields
  // matchTimeStats.ts needs. match_number itself isn't fetched here — it's null at this point
  // and stays null until the series is actually reported (see report.ts).
  const { data: seriesData } = await supabase
    .from("crl6mansqueuebot_series")
    .select("created_at, bonus_day_multiplier, is_test_data")
    .eq("id", seriesId)
    .single();
  const fetchedSeriesData = seriesData as { created_at?: string; bonus_day_multiplier?: number; is_test_data?: boolean } | null;
  const supercharged = (fetchedSeriesData?.bonus_day_multiplier ?? 1) > 1;
  const formationColor = supercharged ? SUPERCHARGED_COLOR : BRAND_COLOR;

  // Live "preview" number for the voice channels, since the real match_number isn't assigned
  // until report time (see report.ts) — no genuine number exists yet while the match is still
  // being played.
  const previewMatchNumber = fetchedSeriesData?.created_at
    ? await computePreviewMatchNumber(supabase, fetchedSeriesData.created_at)
    : undefined;

  // Create voice channels now that teams are finalized
  await createVoiceChannels(supabase, seriesId, guildId, teamA, teamB, previewMatchNumber);

  // Match-time stats — see CLAUDE.md, "Match time stats". Best-effort, never blocks formation.
  await recordMatchTimeStats(supabase, Boolean(fetchedSeriesData?.is_test_data), (fetchedSeriesData?.bonus_day_multiplier ?? 1) > 1);

  // DM each real player their private match credentials (see CLAUDE.md, "Team formation (on
  // pop)") — best-effort, same is_test_data guard as the draft-pick confirmation DM, since
  // synthetic test bots have no real Discord account to DM.
  await Promise.all(
    members
      .filter((m) => !m.is_test_data)
      .map((m) =>
        sendDirectMessage(m.discord_id, "Your teams are formed — join the private match with the credentials below.", undefined, [
          {
            color: formationColor,
            title: "Private Match Credentials",
            fields: [
              { name: "Name", value: "crlw6m", inline: true },
              { name: "Password", value: privateMatchPassword, inline: true },
            ],
          },
        ]),
      ),
  );

  const streaks = await getStreakIds(supabase, members.map((m) => m.id));
  const memberMention = (m: PlayerRow) => mention(m.discord_id, { onFire: streaks.onFireIds.has(m.id), cold: streaks.coldIds.has(m.id) });
  const teamALine = teamA.map(memberMention).join(" ");
  const teamBLine = teamB.map(memberMention).join(" ");

  // Delete all non-permanent messages, then post the "Teams formed!" message
  const { data: trackedMessages } = await supabase
    .from("crl6mansqueuebot_queue_channel_messages")
    .select("message_id, keep_permanently")
    .eq("channel_id", queueChannelId) as any;

  if (trackedMessages) {
    for (const msg of trackedMessages) {
      if (!(msg as any).keep_permanently) {
        await discordFetch(`/channels/${queueChannelId}/messages/${msg.message_id}`, { method: "DELETE" }).catch(() => {});
      }
    }
  }

  await supabase
    .from("crl6mansqueuebot_queue_channel_messages")
    .delete()
    .eq("channel_id", queueChannelId)
    .eq("keep_permanently", false);

  // Post the "Teams formed!" message. Mentions in `content` (not just embed fields) are what
  // actually trigger a Discord notification — see CLAUDE.md, "Queue channels" for the same
  // content-vs-embed distinction on the first-join role ping.
  const allMentions = members.map(memberMention).join(" ");
  const message = (await discordFetch(`/channels/${queueChannelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: `${allMentions} — teams are formed!`,
      embeds: [
        {
          color: formationColor,
          title: "Teams formed!",
          fields: [
            { name: "Team Blue", value: teamALine, inline: true },
            { name: "Team Orange", value: teamBLine, inline: true },
          ],
          footer: { text: "Teams are ready. Join your team's voice channel to start playing. Run /report in the report channel when done." },
        },
      ],
    }),
  })) as { id: string };

  // Track it as permanent
  await supabase
    .from("crl6mansqueuebot_queue_channel_messages")
    .insert({
      channel_id: queueChannelId,
      message_id: message.id,
      message_type: "teams_formed",
      keep_permanently: true,
    } as any);
}
