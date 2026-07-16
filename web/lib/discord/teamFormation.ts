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
import { discordFetch, editOriginalResponse } from "./rest";
import { getAdminRoleIds } from "./admin";
import { VIEW_CHANNEL, CONNECT, ROLE_TYPE, MEMBER_TYPE, type PermissionOverwrite } from "./permissions";
import { interactionUserId, type DiscordInteraction } from "./types";

type AdminClient = ReturnType<typeof createAdminClient>;

// ---------------------------------------------------------------------------
// Vote message: Balanced vs Captains, first to 3/6 wins, exact 3-3 tie -> Captains.
// See CLAUDE.md, "Team formation (on pop)" / "Team formation, in the match channel".
// ---------------------------------------------------------------------------

function voteMessageContent(balancedCount: number, captainsCount: number) {
  return (
    `**Vote: team formation mode**\n` +
    `First to 3/6 votes wins (an exact 3-3 tie resolves to Captains).\n` +
    `Balanced: ${balancedCount}   Captains: ${captainsCount}`
  );
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

// Entry point called by queue.ts once the match text channel exists — posts the vote
// message, then auto-casts any player's saved /vote-default preference (still overridable
// per game by clicking a button). Cast sequentially so a mid-loop resolution's follow-on
// writes (draft/balanced setup) can't interleave with a not-yet-processed auto-cast.
export async function startTeamFormation(supabase: AdminClient, guildId: string, seriesId: string, textChannelId: string, members: PlayerRow[]) {
  const message = (await discordFetch(`/channels/${textChannelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: voteMessageContent(0, 0), components: voteButtons(seriesId) }),
  })) as { id: string };

  await supabase.from("crl6mansqueuebot_series").update({ formation_message_id: message.id }).eq("id", seriesId);

  for (const member of members) {
    if (member.vote_default) {
      await castVote(supabase, guildId, seriesId, textChannelId, message.id, members, member.id, member.vote_default);
    }
  }
}

async function castVote(
  supabase: AdminClient,
  guildId: string,
  seriesId: string,
  textChannelId: string,
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
    await discordFetch(`/channels/${textChannelId}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ content: voteMessageContent(balancedCount, captainsCount), components: voteButtons(seriesId) }),
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
    await resolveBalanced(supabase, guildId, seriesId, textChannelId, messageId, members);
  } else {
    await beginCaptainsDraft(supabase, guildId, seriesId, textChannelId, messageId, members);
  }
}

// ---------------------------------------------------------------------------
// Vote button entry point
// ---------------------------------------------------------------------------

export function handleVoteButton(interaction: DiscordInteraction, seriesId: string, choice: VoteChoice) {
  after(() => processVoteButton(interaction, seriesId, choice));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processVoteButton(interaction: DiscordInteraction, seriesId: string, choice: VoteChoice) {
  const supabase = createAdminClient();
  const discordId = interactionUserId(interaction);
  if (!discordId || !interaction.guild_id) {
    await editOriginalResponse(interaction.token, { content: "Couldn't identify you — try again." });
    return;
  }

  const { data: player } = await supabase.from("crl6mansqueuebot_players").select("*").eq("discord_id", discordId).maybeSingle();
  const { data: lobbyRow } = player
    ? await supabase.from("crl6mansqueuebot_series_lobby").select("player_id").eq("series_id", seriesId).eq("player_id", player.id).maybeSingle()
    : { data: null };
  if (!player || !lobbyRow) {
    await editOriginalResponse(interaction.token, { content: "You're not part of this match." });
    return;
  }

  const { data: series } = await supabase.from("crl6mansqueuebot_series").select("*").eq("id", seriesId).maybeSingle();
  if (!series || series.vote_result || !series.text_channel_id || !series.formation_message_id) {
    await editOriginalResponse(interaction.token, { content: "Voting isn't open for this match anymore." });
    return;
  }

  const members = await fetchLobbyMembers(supabase, seriesId);
  await castVote(supabase, interaction.guild_id, seriesId, series.text_channel_id, series.formation_message_id, members, player.id, choice);
  await editOriginalResponse(interaction.token, { content: `Voted ${choice === "balanced" ? "Balanced" : "Captains"}.` });
}

// ---------------------------------------------------------------------------
// Balanced mode: brute-force all 10 unique 3v3 splits, pick the smallest MMR-average gap.
// ---------------------------------------------------------------------------

function bestBalancedSplit(members: PlayerRow[]): { teamA: PlayerRow[]; teamB: PlayerRow[] } {
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

async function resolveBalanced(supabase: AdminClient, guildId: string, seriesId: string, textChannelId: string, messageId: string, members: PlayerRow[]) {
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

  await finalizeTeams(supabase, guildId, seriesId, textChannelId, messageId, members, teamAssignments);
}

// ---------------------------------------------------------------------------
// Captains mode: top two players by MMR become captains. Draft order (Captain A picks 1,
// Captain B picks 2, last remaining player auto-assigns to Captain A) is derived purely by
// counting how many non-captain lobby rows already have a team — no separate turn column.
// See CLAUDE.md, "Team formation (on pop)".
// ---------------------------------------------------------------------------

function deriveTurnCaptain(nonCaptainAssignedCount: number): Team | null {
  if (nonCaptainAssignedCount === 0) return "A";
  if (nonCaptainAssignedCount === 1 || nonCaptainAssignedCount === 2) return "B";
  return null; // 3 assigned -> the 4th auto-assigns, draft is complete
}

async function beginCaptainsDraft(supabase: AdminClient, guildId: string, seriesId: string, textChannelId: string, messageId: string, members: PlayerRow[]) {
  const sorted = [...members].sort((a, b) => b.mmr - a.mmr || a.discord_id.localeCompare(b.discord_id));
  const captainA = sorted[0];
  const captainB = sorted[1];

  await supabase.from("crl6mansqueuebot_series_lobby").update({ team: "A", is_captain: true }).eq("series_id", seriesId).eq("player_id", captainA.id);
  await supabase.from("crl6mansqueuebot_series_lobby").update({ team: "B", is_captain: true }).eq("series_id", seriesId).eq("player_id", captainB.id);

  const remaining = members.filter((m) => m.id !== captainA.id && m.id !== captainB.id);
  await renderDraftTurn(textChannelId, messageId, seriesId, captainA, captainB, remaining, "A");
}

async function renderDraftTurn(
  textChannelId: string,
  messageId: string,
  seriesId: string,
  captainA: PlayerRow,
  captainB: PlayerRow,
  remaining: PlayerRow[],
  turnCaptain: Team,
) {
  const turnPlayer = turnCaptain === "A" ? captainA : captainB;
  const content =
    `**Captains Draft**\n` +
    `Captain A: <@${captainA.discord_id}>\n` +
    `Captain B: <@${captainB.discord_id}>\n\n` +
    `<@${turnPlayer.discord_id}>'s pick.`;

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

  await discordFetch(`/channels/${textChannelId}/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify({ content, components: buttonRows }),
  });
}

export function handleDraftPickButton(interaction: DiscordInteraction, seriesId: string, pickedPlayerId: string) {
  after(() => processDraftPick(interaction, seriesId, pickedPlayerId));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processDraftPick(interaction: DiscordInteraction, seriesId: string, pickedPlayerId: string) {
  const supabase = createAdminClient();
  const discordId = interactionUserId(interaction);
  if (!discordId || !interaction.guild_id) {
    await editOriginalResponse(interaction.token, { content: "Couldn't identify you — try again." });
    return;
  }

  const { data: series } = await supabase.from("crl6mansqueuebot_series").select("*").eq("id", seriesId).maybeSingle();
  if (!series || series.vote_result !== "captains" || series.status !== "forming" || !series.text_channel_id || !series.formation_message_id) {
    await editOriginalResponse(interaction.token, { content: "The draft isn't active for this match." });
    return;
  }

  const lobby = await fetchLobbyRowsWithPlayers(supabase, seriesId);
  const captainARow = lobby.find((x) => x.row.is_captain && x.row.team === "A");
  const captainBRow = lobby.find((x) => x.row.is_captain && x.row.team === "B");
  if (!captainARow || !captainBRow) {
    await editOriginalResponse(interaction.token, { content: "Something's wrong with this draft — ask an admin to check it." });
    return;
  }

  const nonCaptainRows = lobby.filter((x) => !x.row.is_captain);
  const assignedCount = nonCaptainRows.filter((x) => x.row.team).length;
  const turnCaptain = deriveTurnCaptain(assignedCount);
  if (!turnCaptain) {
    await editOriginalResponse(interaction.token, { content: "The draft has already finished." });
    return;
  }

  const turnCaptainPlayer = turnCaptain === "A" ? captainARow.player : captainBRow.player;
  if (turnCaptainPlayer.discord_id !== discordId) {
    await editOriginalResponse(interaction.token, { content: "It's not your pick." });
    return;
  }

  const target = nonCaptainRows.find((x) => x.row.player_id === pickedPlayerId);
  if (!target || target.row.team) {
    await editOriginalResponse(interaction.token, { content: "That player isn't available to pick." });
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
    await editOriginalResponse(interaction.token, { content: "That pick already happened." });
    return;
  }

  await editOriginalResponse(interaction.token, { content: `You picked <@${target.player.discord_id}>.` });

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
    await finalizeTeams(supabase, interaction.guild_id, seriesId, series.text_channel_id, series.formation_message_id, allMembers, teamAssignments);
  } else {
    const nextTurn = deriveTurnCaptain(newAssignedCount)!;
    const remaining = nonCaptainRows.filter((x) => x.row.player_id !== pickedPlayerId && !x.row.team).map((x) => x.player);
    await renderDraftTurn(series.text_channel_id, series.formation_message_id, seriesId, captainARow.player, captainBRow.player, remaining, nextTurn);
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
  textChannelId: string,
  messageId: string,
  members: PlayerRow[],
  teamAssignments: Map<string, Team>,
) {
  await supabase.from("crl6mansqueuebot_series_players").insert(members.map((m) => ({ series_id: seriesId, player_id: m.id, team: teamAssignments.get(m.id)! })));
  await supabase.from("crl6mansqueuebot_series_lobby").delete().eq("series_id", seriesId);
  await supabase.from("crl6mansqueuebot_series").update({ status: "active" }).eq("id", seriesId);

  const teamA = members.filter((m) => teamAssignments.get(m.id) === "A");
  const teamB = members.filter((m) => teamAssignments.get(m.id) === "B");

  const { data: series } = await supabase.from("crl6mansqueuebot_series").select("category_id").eq("id", seriesId).maybeSingle();
  const adminRoleIds = await getAdminRoleIds();
  const botUserId = process.env.DISCORD_APPLICATION_ID;
  const shortId = seriesId.slice(0, 8);

  const voiceOverwrites = (teamMembers: PlayerRow[]): PermissionOverwrite[] => [
    { id: guildId, type: ROLE_TYPE, deny: VIEW_CHANNEL.toString() },
    ...teamMembers.map((m) => ({ id: m.discord_id, type: MEMBER_TYPE, allow: (VIEW_CHANNEL | CONNECT).toString() }) as PermissionOverwrite),
    ...adminRoleIds.map((roleId) => ({ id: roleId, type: ROLE_TYPE, allow: (VIEW_CHANNEL | CONNECT).toString() }) as PermissionOverwrite),
    ...(botUserId ? [{ id: botUserId, type: MEMBER_TYPE, allow: (VIEW_CHANNEL | CONNECT).toString() } as PermissionOverwrite] : []),
  ];

  const voiceA = (await discordFetch(`/guilds/${guildId}/channels`, {
    method: "POST",
    body: JSON.stringify({ name: `Team A - ${shortId}`, type: 2, parent_id: series?.category_id ?? undefined, permission_overwrites: voiceOverwrites(teamA) }),
  })) as { id: string };
  const voiceB = (await discordFetch(`/guilds/${guildId}/channels`, {
    method: "POST",
    body: JSON.stringify({ name: `Team B - ${shortId}`, type: 2, parent_id: series?.category_id ?? undefined, permission_overwrites: voiceOverwrites(teamB) }),
  })) as { id: string };

  await supabase.from("crl6mansqueuebot_series").update({ voice_channel_a_id: voiceA.id, voice_channel_b_id: voiceB.id }).eq("id", seriesId);

  // Lifts the message-lock set at channel creation (see queue.ts, createMatchChannels) by
  // replacing each of the 6 players' overwrite with a VIEW-only allow — PUT replaces the
  // whole overwrite object for that id, so this clears the earlier SEND_MESSAGES deny too.
  await Promise.all(
    members.map((m) =>
      discordFetch(`/channels/${textChannelId}/permissions/${m.discord_id}`, {
        method: "PUT",
        body: JSON.stringify({ type: MEMBER_TYPE, allow: VIEW_CHANNEL.toString() }),
      }),
    ),
  );

  const teamALine = teamA.map((m) => `<@${m.discord_id}>`).join(", ");
  const teamBLine = teamB.map((m) => `<@${m.discord_id}>`).join(", ");
  await discordFetch(`/channels/${textChannelId}/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify({
      content:
        `**Teams formed!**\nTeam A: ${teamALine}\nTeam B: ${teamBLine}\n\n` +
        `Chat and voice are unlocked. Run \`/report\` in this channel once the series is decided.`,
      components: [],
    }),
  });
}
