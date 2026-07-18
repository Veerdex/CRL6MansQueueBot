import "server-only";
import { after } from "next/server";
import {
  InteractionResponseType,
  InteractionResponseFlags,
  MessageComponentTypes,
  ButtonStyleTypes,
} from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PlayerRow, SeriesLobbyRow, Team, VoteChoice } from "@/lib/supabase/types";
import { discordFetch, sendDirectMessage, getGuildId, BRAND_COLOR, getRankEmoji } from "./rest";
import { getAdminRoleIds } from "./admin";
import { getConfigNumber } from "./config";
import { VIEW_CHANNEL, CONNECT, ROLE_TYPE, MEMBER_TYPE, type PermissionOverwrite } from "./permissions";
import { interactionUserId, type DiscordInteraction } from "./types";
import { createVoiceChannels, postTrackedQueueMessage } from "./queue";

type AdminClient = ReturnType<typeof createAdminClient>;

// ---------------------------------------------------------------------------
// Vote message: Balanced vs Captains, first to 3/6 wins, exact 3-3 tie -> Captains.
// See CLAUDE.md, "Team formation (on pop)" / "Team formation, in the match channel".
// ---------------------------------------------------------------------------

function voteEmbed(balancedCount: number, captainsCount: number, cancelCount: number, timeoutSeconds: number) {
  const minutes = Math.round(timeoutSeconds / 60);
  return {
    color: BRAND_COLOR,
    description:
      `**You have ${minutes} minute${minutes === 1 ? "" : "s"} to vote. Vote by clicking the buttons below.**\n` +
      `This message needs **3 player interactions** to proceed! An exact 3-3 tie resolves to Captains.`,
    fields: [
      { name: "Balanced Teams", value: `${balancedCount} / 3`, inline: true },
      { name: "Captains", value: `${captainsCount} / 3`, inline: true },
      { name: "Cancel", value: `${cancelCount} / 4`, inline: true },
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
    {
      type: MessageComponentTypes.ACTION_ROW,
      components: [
        { type: MessageComponentTypes.BUTTON, style: ButtonStyleTypes.SECONDARY, label: "Cancel", custom_id: `cancel:${seriesId}` },
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

// Entry point called by queue.ts once the series is created — posts the vote message in
// the queue channel, then auto-casts any player's saved /vote-default preference (still
// overridable per game by clicking a button). Cast sequentially so a mid-loop resolution's
// follow-on writes (draft/balanced setup) can't interleave with a not-yet-processed auto-cast.
export async function startTeamFormation(supabase: AdminClient, guildId: string, seriesId: string, queueChannelId: string, members: PlayerRow[]) {
  const timeoutSeconds = await getConfigNumber("vote_timeout_seconds", 180);
  const mentions = members.map((m) => `<@${m.discord_id}>`).join(" ");
  const message = (await discordFetch(`/channels/${queueChannelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: mentions, embeds: [voteEmbed(0, 0, 0, timeoutSeconds)], components: voteButtons(seriesId) }),
  })) as { id: string };

  await supabase.from("crl6mansqueuebot_series").update({ formation_message_id: message.id }).eq("id", seriesId);

  for (const member of members) {
    if (member.vote_default) {
      await castVote(supabase, guildId, seriesId, queueChannelId, message.id, members, member.id, member.vote_default);
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
  const { data: cancelVotes } = await supabase.from("crl6mansqueuebot_cancel_votes").select("player_id").eq("series_id", seriesId);

  const balancedCount = (votes ?? []).filter((v) => v.choice === "balanced").length;
  const captainsCount = (votes ?? []).filter((v) => v.choice === "captains").length;
  const cancelCount = (cancelVotes ?? []).length;

  let winner: VoteChoice | null = null;
  if (balancedCount >= 3) winner = "balanced";
  else if (captainsCount >= 3) winner = "captains";
  else if (balancedCount + captainsCount >= 6) winner = "captains"; // exact 3-3 tie

  if (!winner) {
    const timeoutSeconds = await getConfigNumber("vote_timeout_seconds", 180);
    await discordFetch(`/channels/${queueChannelId}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ embeds: [voteEmbed(balancedCount, captainsCount, cancelCount, timeoutSeconds)], components: voteButtons(seriesId) }),
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

  if (winner === "balanced") {
    await resolveBalanced(supabase, guildId, seriesId, queueChannelId, messageId, members);
  } else {
    await beginCaptainsDraft(supabase, guildId, seriesId, queueChannelId, messageId, members);
  }
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
    await discordFetch(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      body: JSON.stringify({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "Couldn't identify you — try again.", flags: InteractionResponseFlags.EPHEMERAL },
      }),
    }).catch(() => {});
    return;
  }

  const { data: player } = await supabase.from("crl6mansqueuebot_players").select("*").eq("discord_id", discordId).maybeSingle();
  const { data: lobbyRow } = player
    ? await supabase.from("crl6mansqueuebot_series_lobby").select("player_id").eq("series_id", seriesId).eq("player_id", player.id).maybeSingle()
    : { data: null };
  if (!player || !lobbyRow) {
    await discordFetch(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      body: JSON.stringify({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "You're not part of this match.", flags: InteractionResponseFlags.EPHEMERAL },
      }),
    }).catch(() => {});
    return;
  }

  const { data: series } = await supabase.from("crl6mansqueuebot_series").select("*").eq("id", seriesId).maybeSingle();
  if (!series || series.vote_result || !series.formation_message_id) {
    await discordFetch(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      body: JSON.stringify({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "Voting isn't open for this match anymore.", flags: InteractionResponseFlags.EPHEMERAL },
      }),
    }).catch(() => {});
    return;
  }

  const members = await fetchLobbyMembers(supabase, seriesId);
  await castVote(supabase, interaction.guild_id, seriesId, interaction.channel_id, series.formation_message_id, members, player.id, choice);
}

// ---------------------------------------------------------------------------
// Cancel button entry point
// ---------------------------------------------------------------------------

export function handleCancelButton(interaction: DiscordInteraction, seriesId: string) {
  after(() => processCancelButton(interaction, seriesId));
  return {
    type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE,
  };
}

async function processCancelButton(interaction: DiscordInteraction, seriesId: string) {
  const supabase = createAdminClient();
  const discordId = interactionUserId(interaction);
  if (!discordId || !interaction.guild_id || !interaction.channel_id) {
    await discordFetch(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      body: JSON.stringify({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "Couldn't identify you — try again.", flags: InteractionResponseFlags.EPHEMERAL },
      }),
    }).catch(() => {});
    return;
  }

  const { data: player } = await supabase.from("crl6mansqueuebot_players").select("*").eq("discord_id", discordId).maybeSingle();
  const { data: lobbyRow } = player
    ? await supabase.from("crl6mansqueuebot_series_lobby").select("player_id").eq("series_id", seriesId).eq("player_id", player.id).maybeSingle()
    : { data: null };
  if (!player || !lobbyRow) {
    await discordFetch(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      body: JSON.stringify({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "You're not part of this match.", flags: InteractionResponseFlags.EPHEMERAL },
      }),
    }).catch(() => {});
    return;
  }

  const { data: series } = await supabase.from("crl6mansqueuebot_series").select("*").eq("id", seriesId).maybeSingle();
  if (!series || series.vote_result || series.status !== "forming" || !series.formation_message_id) {
    await discordFetch(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      body: JSON.stringify({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "Match is no longer in voting phase.", flags: InteractionResponseFlags.EPHEMERAL },
      }),
    }).catch(() => {});
    return;
  }

  // Upsert cancel vote (same player can't double-vote)
  await supabase.from("crl6mansqueuebot_cancel_votes").upsert({ series_id: seriesId, player_id: player.id });

  const { data: cancelVotes } = await supabase.from("crl6mansqueuebot_cancel_votes").select("player_id").eq("series_id", seriesId);
  const cancelCount = (cancelVotes ?? []).length;

  // If 4+ players voted to cancel, void the series
  if (cancelCount >= 4) {
    // Atomic void claim
    const { data: claimed } = await supabase
      .from("crl6mansqueuebot_series")
      .update({ status: "void" })
      .eq("id", seriesId)
      .eq("status", "forming")
      .select("id");
    if (claimed && claimed.length > 0) {
      // Clear pending series state and remove message
      await supabase.from("crl6mansqueuebot_series_votes").delete().eq("series_id", seriesId);
      await supabase.from("crl6mansqueuebot_cancel_votes").delete().eq("series_id", seriesId);
      await discordFetch(`/channels/${interaction.channel_id}/messages/${series.formation_message_id}`, { method: "DELETE" }).catch(() => {});
      return;
    }
  }

  // Update the message to show new cancel count
  const { data: votes } = await supabase.from("crl6mansqueuebot_series_votes").select("choice").eq("series_id", seriesId);
  const balancedCount = (votes ?? []).filter((v) => v.choice === "balanced").length;
  const captainsCount = (votes ?? []).filter((v) => v.choice === "captains").length;
  const timeoutSeconds = await getConfigNumber("vote_timeout_seconds", 180);

  await discordFetch(`/channels/${interaction.channel_id}/messages/${series.formation_message_id}`, {
    method: "PATCH",
    body: JSON.stringify({ embeds: [voteEmbed(balancedCount, captainsCount, cancelCount, timeoutSeconds)], components: voteButtons(seriesId) }),
  });
}

// ---------------------------------------------------------------------------
// Balanced mode: brute-force all 10 unique 3v3 splits, pick the smallest MMR-average gap.
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

        const avgA = teamA.reduce((sum, p) => sum + p.mmr, 0) / 3;
        const avgB = teamB.reduce((sum, p) => sum + p.mmr, 0) / 3;
        const diff = Math.abs(avgA - avgB);
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
// Captains mode: top two players by MMR become captains. Draft order (Captain A picks 1,
// Captain B picks 2, last remaining player auto-assigns to Captain A) is derived purely by
// counting how many non-captain lobby rows already have a team — no separate turn column.
// See CLAUDE.md, "Team formation (on pop)".
// ---------------------------------------------------------------------------

export function deriveTurnCaptain(nonCaptainAssignedCount: number): Team | null {
  if (nonCaptainAssignedCount === 0) return "A";
  if (nonCaptainAssignedCount === 1 || nonCaptainAssignedCount === 2) return "B";
  return null; // 3 assigned -> the 4th auto-assigns, draft is complete
}

async function beginCaptainsDraft(supabase: AdminClient, guildId: string, seriesId: string, queueChannelId: string, messageId: string, members: PlayerRow[]) {
  const sorted = [...members].sort((a, b) => b.mmr - a.mmr || a.discord_id.localeCompare(b.discord_id));
  const captainA = sorted[0];
  const captainB = sorted[1];

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
  const header = `**Captains Draft**\nCaptain A: <@${captainA.discord_id}>\nCaptain B: <@${captainB.discord_id}>\n\n`;

  if (turnPlayer.is_test_data) {
    await discordFetch(`/channels/${textChannelId}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ content: `${header}Waiting on <@${turnPlayer.discord_id}> (test bot)...`, embeds: [], components: [] }),
    });
    return;
  }

  const buttonRows = draftPickButtonRows(seriesId, remaining);
  const dmContent = `**Captains Draft — your pick**`;

  // Create embed with player information
  const supabase = createAdminClient();
  const embedFields = [];

  for (const player of remaining) {
    const emoji = await getRankEmoji(player.band);
    const { data: seriesPlayerRows } = await supabase
      .from("crl6mansqueuebot_series_players")
      .select("team, series_id")
      .eq("player_id", player.id);

    if (!seriesPlayerRows || seriesPlayerRows.length === 0) {
      embedFields.push({
        name: player.display_name,
        value: `${player.mmr.toFixed(0)} MMR ${emoji} | **W:** 0 | **L:** 0`,
        inline: false,
      });
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
      value: `${player.mmr.toFixed(0)} MMR ${emoji} | **W:** ${wins} | **L:** ${losses}`,
      inline: false,
    });
  }

  const embed = {
    title: "Choose a Player",
    color: BRAND_COLOR,
    fields: embedFields,
  };

  const dmSent = await sendDirectMessage(turnPlayer.discord_id, dmContent, buttonRows, [embed]);

  if (dmSent) {
    await discordFetch(`/channels/${textChannelId}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ content: `${header}<@${turnPlayer.discord_id}> is picking — check your DMs!`, embeds: [], components: [] }),
    });
  } else {
    await discordFetch(`/channels/${textChannelId}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({
        content: `${header}<@${turnPlayer.discord_id}> — I couldn't DM you (your DMs are closed). Pick here instead:`,
        embeds: [],
        components: buttonRows,
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
    await discordFetch(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      body: JSON.stringify({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "Couldn't identify you — try again.", flags: InteractionResponseFlags.EPHEMERAL },
      }),
    }).catch(() => {});
    return;
  }
  // Draft picks are DM-driven now (see sendDraftPickPrompt) — a DM interaction has no guild_id
  // of its own, so this resolves the bot's single guild the same way background jobs without
  // an interaction payload do (getGuildId, rest.ts). The channel-fallback pick case (DMs
  // closed) still arrives with a real guild_id and just short-circuits to it below.
  const guildId = interaction.guild_id ?? (await getGuildId());

  const { data: series } = await supabase.from("crl6mansqueuebot_series").select("*").eq("id", seriesId).maybeSingle();
  if (!series || series.vote_result !== "captains" || series.status !== "forming" || !series.queue_channel_id || !series.formation_message_id) {
    await discordFetch(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      body: JSON.stringify({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "The draft isn't active for this match.", flags: InteractionResponseFlags.EPHEMERAL },
      }),
    }).catch(() => {});
    return;
  }

  const lobby = await fetchLobbyRowsWithPlayers(supabase, seriesId);
  const captainARow = lobby.find((x) => x.row.is_captain && x.row.team === "A");
  const captainBRow = lobby.find((x) => x.row.is_captain && x.row.team === "B");
  if (!captainARow || !captainBRow) {
    await discordFetch(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      body: JSON.stringify({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "Something's wrong with this draft — ask an admin to check it.", flags: InteractionResponseFlags.EPHEMERAL },
      }),
    }).catch(() => {});
    return;
  }

  const nonCaptainRows = lobby.filter((x) => !x.row.is_captain);
  const assignedCount = nonCaptainRows.filter((x) => x.row.team).length;
  const turnCaptain = deriveTurnCaptain(assignedCount);
  if (!turnCaptain) {
    await discordFetch(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      body: JSON.stringify({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "The draft has already finished.", flags: InteractionResponseFlags.EPHEMERAL },
      }),
    }).catch(() => {});
    return;
  }

  const turnCaptainPlayer = turnCaptain === "A" ? captainARow.player : captainBRow.player;
  if (turnCaptainPlayer.discord_id !== discordId) {
    await discordFetch(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      body: JSON.stringify({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "It's not your pick.", flags: InteractionResponseFlags.EPHEMERAL },
      }),
    }).catch(() => {});
    return;
  }

  const target = nonCaptainRows.find((x) => x.row.player_id === pickedPlayerId);
  if (!target || target.row.team) {
    await discordFetch(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      body: JSON.stringify({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "That player isn't available to pick.", flags: InteractionResponseFlags.EPHEMERAL },
      }),
    }).catch(() => {});
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
    await discordFetch(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      body: JSON.stringify({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "That pick already happened.", flags: InteractionResponseFlags.EPHEMERAL },
      }),
    }).catch(() => {});
    return;
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
  await supabase.from("crl6mansqueuebot_series").update({ status: "active" }).eq("id", seriesId);

  const teamA = members.filter((m) => teamAssignments.get(m.id) === "A");
  const teamB = members.filter((m) => teamAssignments.get(m.id) === "B");

  // Fetch match number for voice channel naming
  const { data: seriesData } = await supabase.from("crl6mansqueuebot_series").select("match_number").eq("id", seriesId).single();
  const matchNumber = (seriesData as any)?.match_number;

  // Create voice channels now that teams are finalized
  await createVoiceChannels(supabase, seriesId, guildId, teamA, teamB, matchNumber);

  const teamALine = teamA.map((m) => `<@${m.discord_id}>`).join(" ");
  const teamBLine = teamB.map((m) => `<@${m.discord_id}>`).join(" ");

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

  // Post the "Teams formed!" message
  const message = (await discordFetch(`/channels/${queueChannelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      embeds: [
        {
          color: BRAND_COLOR,
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
