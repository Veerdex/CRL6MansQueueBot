import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags, MessageComponentTypes, ButtonStyleTypes } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import { discordFetch, editOriginalResponse } from "./rest";
import { getOrCreatePlayer, isPlayerLockedInActiveSeries, getLockedSeriesForPlayer } from "./queue";
import { hasAdminAccess } from "./admin";
import { VIEW_CHANNEL, CONNECT, MEMBER_TYPE } from "./permissions";
import { interactionUserId, interactionDisplayName, type DiscordInteraction } from "./types";
import type { SeriesRow, Team } from "@/lib/supabase/types";

type AdminClient = ReturnType<typeof createAdminClient>;

// ---------------------------------------------------------------------------
// /sub nominee:<@user> — run inside a match text channel; series is inferred from the
// channel. `id:` is an optional admin-gated override, same pattern as /report. Nominates a
// specific replacement, who must accept via a button before the swap happens. See CLAUDE.md,
// "Substitutes".
// ---------------------------------------------------------------------------

export function handleSubCommand(interaction: DiscordInteraction) {
  const idOption = interaction.data?.options?.find((o) => o.name === "id")?.value;
  const seriesIdOverride = typeof idOption === "string" && idOption.length > 0 ? idOption : null;
  const nomineeOption = interaction.data?.options?.find((o) => o.name === "nominee")?.value;
  const nomineeDiscordId = typeof nomineeOption === "string" ? nomineeOption : null;
  after(() => processSub(interaction, seriesIdOverride, nomineeDiscordId));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function resolveSeriesForCommand(
  supabase: AdminClient,
  interaction: DiscordInteraction,
  seriesIdOverride: string | null,
  playerId: string,
): Promise<SeriesRow | null | "forbidden"> {
  if (seriesIdOverride) {
    if (!(await hasAdminAccess(interaction))) return "forbidden";
    const { data } = await supabase.from("crl6mansqueuebot_series").select("*").eq("id", seriesIdOverride).maybeSingle();
    return data;
  }
  // Resolved by the caller's own membership, not the channel — queue_channel_id is a shared
  // rank/universal queue channel, so multiple concurrently active series can share it. See
  // CLAUDE.md, "Queue channels".
  return getLockedSeriesForPlayer(supabase, playerId);
}

async function processSub(interaction: DiscordInteraction, seriesIdOverride: string | null, nomineeDiscordId: string | null) {
  const supabase = createAdminClient();
  const discordId = interactionUserId(interaction);
  if (!discordId) {
    await editOriginalResponse(interaction.token, { content: "Couldn't identify you — try again." });
    return;
  }
  if (!nomineeDiscordId) {
    await editOriginalResponse(interaction.token, { content: "Missing nominee." });
    return;
  }

  const player = await getOrCreatePlayer(supabase, discordId, interactionDisplayName(interaction));
  const series = await resolveSeriesForCommand(supabase, interaction, seriesIdOverride, player.id);
  if (series === "forbidden") {
    await editOriginalResponse(interaction.token, { content: "Only admins can sub by id: from outside the match channel." });
    return;
  }
  if (!series) {
    await editOriginalResponse(interaction.token, { content: seriesIdOverride ? "Series not found." : "You're not part of an active match." });
    return;
  }
  if (series.status === "forming") {
    await editOriginalResponse(interaction.token, { content: "Teams haven't been finalized yet." });
    return;
  }
  if (series.status !== "active") {
    await editOriginalResponse(interaction.token, { content: "This match has already been settled." });
    return;
  }
  if (!series.queue_channel_id) {
    await editOriginalResponse(interaction.token, { content: "This match's channel is missing — ask an admin to check it." });
    return;
  }

  const { data: seriesPlayers } = await supabase.from("crl6mansqueuebot_series_players").select("*").eq("series_id", series.id);
  if (!seriesPlayers || seriesPlayers.length !== 6) {
    await editOriginalResponse(interaction.token, { content: "Something's wrong with this match's roster — ask an admin to check it." });
    return;
  }

  const leavingRow = seriesPlayers.find((sp) => sp.player_id === player.id);
  if (!leavingRow) {
    await editOriginalResponse(interaction.token, { content: "You're not part of this match." });
    return;
  }

  if (nomineeDiscordId === discordId) {
    await editOriginalResponse(interaction.token, { content: "You can't nominate yourself." });
    return;
  }
  const { data: participants } = await supabase.from("crl6mansqueuebot_players").select("id, discord_id").in(
    "id",
    seriesPlayers.map((sp) => sp.player_id),
  );
  if ((participants ?? []).some((p) => p.discord_id === nomineeDiscordId)) {
    await editOriginalResponse(interaction.token, { content: "That player is already in this match." });
    return;
  }

  // Check if nominee is locked into another active series
  const { data: nomineePlayer } = await supabase.from("crl6mansqueuebot_players").select("id").eq("discord_id", nomineeDiscordId).maybeSingle();
  if (nomineePlayer && (await isPlayerLockedInActiveSeries(supabase, nomineePlayer.id))) {
    await editOriginalResponse(interaction.token, { content: "That player is currently locked in another match and can't be nominated." });
    return;
  }

  const { data: existingRequest } = await supabase
    .from("crl6mansqueuebot_sub_requests")
    .select("series_id")
    .eq("series_id", series.id)
    .eq("leaving_player_id", player.id)
    .maybeSingle();
  if (existingRequest) {
    await editOriginalResponse(interaction.token, { content: "You already have a pending sub request out." });
    return;
  }

  const message = (await discordFetch(`/channels/${series.queue_channel_id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: `<@${nomineeDiscordId}> — <@${discordId}> wants to sub out and nominated you to take their seat (Team ${leavingRow.team}). Accept to join the match.`,
      components: [
        {
          type: MessageComponentTypes.ACTION_ROW,
          components: [
            {
              type: MessageComponentTypes.BUTTON,
              style: ButtonStyleTypes.SUCCESS,
              label: "Accept",
              custom_id: `sub_accept:${series.id}:${player.id}`,
            },
          ],
        },
      ],
    }),
  })) as { id: string };

  const { error: insertError } = await supabase.from("crl6mansqueuebot_sub_requests").insert({
    series_id: series.id,
    leaving_player_id: player.id,
    nominee_discord_id: nomineeDiscordId,
    team: leavingRow.team,
    message_id: message.id,
  });
  if (insertError) {
    console.error(`Failed to create sub request for series ${series.id}`, insertError);
    await editOriginalResponse(interaction.token, { content: "Something went wrong — try again." });
    return;
  }

  await editOriginalResponse(interaction.token, { content: `Sub request sent to <@${nomineeDiscordId}>.` });
}

// ---------------------------------------------------------------------------
// Accept button — only the nominated user can click it. Atomic claim via the row delete
// (existence = pending, same convention as series_lobby/queue_members) so a double-click
// or a request that already expired can't be double-accepted.
// ---------------------------------------------------------------------------

export function handleSubAcceptButton(interaction: DiscordInteraction, seriesId: string, leavingPlayerId: string) {
  after(() => processSubAccept(interaction, seriesId, leavingPlayerId));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processSubAccept(interaction: DiscordInteraction, seriesId: string, leavingPlayerId: string) {
  const supabase = createAdminClient();
  const discordId = interactionUserId(interaction);
  if (!discordId || !interaction.guild_id) {
    await editOriginalResponse(interaction.token, { content: "Couldn't identify you — try again." });
    return;
  }

  const { data: subRequest } = await supabase
    .from("crl6mansqueuebot_sub_requests")
    .select("*")
    .eq("series_id", seriesId)
    .eq("leaving_player_id", leavingPlayerId)
    .maybeSingle();
  if (!subRequest) {
    await editOriginalResponse(interaction.token, { content: "This sub request is no longer active." });
    return;
  }
  if (subRequest.nominee_discord_id !== discordId) {
    await editOriginalResponse(interaction.token, { content: "This sub request isn't for you." });
    return;
  }

  const { data: claimed } = await supabase
    .from("crl6mansqueuebot_sub_requests")
    .delete()
    .eq("series_id", seriesId)
    .eq("leaving_player_id", leavingPlayerId)
    .select("series_id");
  if (!claimed || claimed.length === 0) {
    await editOriginalResponse(interaction.token, { content: "This sub request was already resolved." });
    return;
  }

  const { data: series } = await supabase.from("crl6mansqueuebot_series").select("*").eq("id", seriesId).maybeSingle();
  if (!series || series.status !== "active") {
    await editOriginalResponse(interaction.token, { content: "This match has already ended." });
    return;
  }

  const { data: leavingPlayer } = await supabase.from("crl6mansqueuebot_players").select("*").eq("id", leavingPlayerId).maybeSingle();
  const nominee = await getOrCreatePlayer(supabase, discordId, interactionDisplayName(interaction));
  const team: Team = subRequest.team;

  // Mirror queue.ts's join-time lock check — without this, a player already locked into a
  // different active series could accept a sub here and end up in two series_players rows
  // at once, double-counting toward MMR. The request is already claimed at this point (the
  // delete above), so a rejected accept just leaves the original player to /sub again.
  if (await isPlayerLockedInActiveSeries(supabase, nominee.id)) {
    await editOriginalResponse(interaction.token, { content: "You're already locked into another active match — you can't sub in right now." });
    return;
  }

  await supabase.from("crl6mansqueuebot_series_players").delete().eq("series_id", seriesId).eq("player_id", leavingPlayerId);
  await supabase.from("crl6mansqueuebot_series_players").insert({ series_id: seriesId, player_id: nominee.id, team, mmr_delta: 0 });

  // The nominee is now locked into this series — pull them out of any queue they were
  // sitting in, mirroring the pop-time cross-removal in queue.ts's handlePop.
  await supabase.from("crl6mansqueuebot_queue_members").delete().eq("player_id", nominee.id);

  // Stale-vote cleanup: the leaving player is out via a legitimate sub now, so any
  // abandon_votes referencing them (as voter or target) would otherwise let a delayed 3rd
  // vote wrongly void the series after they've already been properly replaced.
  await supabase.from("crl6mansqueuebot_abandon_votes").delete().eq("series_id", seriesId).or(`voter_player_id.eq.${leavingPlayerId},target_player_id.eq.${leavingPlayerId}`);

  if (series.queue_channel_id) {
    await discordFetch(`/channels/${series.queue_channel_id}/permissions/${nominee.discord_id}`, {
      method: "PUT",
      body: JSON.stringify({ type: MEMBER_TYPE, allow: VIEW_CHANNEL.toString() }),
    }).catch((err) => console.error(`Failed to grant text channel access to sub ${nominee.discord_id}`, err));
    if (leavingPlayer) {
      await discordFetch(`/channels/${series.queue_channel_id}/permissions/${leavingPlayer.discord_id}`, { method: "DELETE" }).catch((err) =>
        console.error(`Failed to revoke text channel access from ${leavingPlayer.discord_id}`, err),
      );
    }
  }

  const teamVoiceChannelId = team === "A" ? series.voice_channel_a_id : series.voice_channel_b_id;
  if (teamVoiceChannelId) {
    await discordFetch(`/channels/${teamVoiceChannelId}/permissions/${nominee.discord_id}`, {
      method: "PUT",
      body: JSON.stringify({ type: MEMBER_TYPE, allow: (VIEW_CHANNEL | CONNECT).toString() }),
    }).catch((err) => console.error(`Failed to grant voice channel access to sub ${nominee.discord_id}`, err));
    if (leavingPlayer) {
      await discordFetch(`/channels/${teamVoiceChannelId}/permissions/${leavingPlayer.discord_id}`, { method: "DELETE" }).catch((err) =>
        console.error(`Failed to revoke voice channel access from ${leavingPlayer.discord_id}`, err),
      );
      // Permission revoke alone doesn't kick someone already connected — best-effort force
      // disconnect via a member PATCH, swallowed since it 404s harmlessly if they'd already left.
      await discordFetch(`/guilds/${interaction.guild_id}/members/${leavingPlayer.discord_id}`, {
        method: "PATCH",
        body: JSON.stringify({ channel_id: null }),
      }).catch(() => {});
    }
  }

  if (subRequest.message_id && series.queue_channel_id) {
    await discordFetch(`/channels/${series.queue_channel_id}/messages/${subRequest.message_id}`, {
      method: "PATCH",
      body: JSON.stringify({
        content: `<@${nominee.discord_id}> accepted and has subbed in for <@${leavingPlayer?.discord_id ?? "?"}> on Team ${team}.`,
        components: [],
      }),
    }).catch((err) => console.error(`Failed to update sub request message for series ${seriesId}`, err));
  }

  await editOriginalResponse(interaction.token, { content: "You're subbed in — good luck!" });
}
