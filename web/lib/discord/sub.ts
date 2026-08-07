import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags, MessageComponentTypes, ButtonStyleTypes } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import { discordFetch, editOriginalResponse } from "./rest";
import { getOrCreatePlayer, isPlayerLockedInActiveSeries, getLockedSeriesForPlayer } from "./queue";
import { hasAdminAccess } from "./admin";
import { getStreakIds, mention } from "./streaks";
import { VIEW_CHANNEL, CONNECT, MEMBER_TYPE } from "./permissions";
import { interactionUserId, interactionDisplayName, type DiscordInteraction } from "./types";
import type { SeriesRow, Team } from "@/lib/supabase/types";

type AdminClient = ReturnType<typeof createAdminClient>;

// ---------------------------------------------------------------------------
// /sub nominee:<@user> — run inside a match text channel; series is inferred from the
// channel. `id:` is an optional admin-gated override, same pattern as /report. Nominates a
// specific replacement, who must accept via a button before the swap happens. See CLAUDE.md,
// "Substitutes".
//
// /nominate target:<@user> nominee:<@user> — same flow, but lets any of the 6 players in the
// match request a sub for a *different* player in that match (disconnected, wifi died, etc.,
// and can't run /sub themselves). Both commands funnel into processSubRequest below, which
// resolves "the leaving player" from either the caller (/sub) or an explicit target
// (/nominate) — everything past that point (duplicate-request check, the posted message, the
// sub_requests row, and the entire accept flow) is identical either way.
// ---------------------------------------------------------------------------

export function handleSubCommand(interaction: DiscordInteraction) {
  const idOption = interaction.data?.options?.find((o) => o.name === "id")?.value;
  const seriesIdOverride = typeof idOption === "string" && idOption.length > 0 ? idOption : null;
  const nomineeOption = interaction.data?.options?.find((o) => o.name === "nominee")?.value;
  const nomineeDiscordId = typeof nomineeOption === "string" ? nomineeOption : null;
  after(() => processSubRequest(interaction, seriesIdOverride, null, nomineeDiscordId));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

export function handleNominateCommand(interaction: DiscordInteraction) {
  const idOption = interaction.data?.options?.find((o) => o.name === "id")?.value;
  const seriesIdOverride = typeof idOption === "string" && idOption.length > 0 ? idOption : null;
  const targetOption = interaction.data?.options?.find((o) => o.name === "target")?.value;
  const targetDiscordId = typeof targetOption === "string" ? targetOption : null;
  const nomineeOption = interaction.data?.options?.find((o) => o.name === "nominee")?.value;
  const nomineeDiscordId = typeof nomineeOption === "string" ? nomineeOption : null;
  after(() => processSubRequest(interaction, seriesIdOverride, targetDiscordId, nomineeDiscordId, /* requireExplicitTarget */ true));
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

// Shared core behind both /sub (targetDiscordId omitted — you're subbing yourself out) and
// /nominate (targetDiscordId explicit — requesting a sub on behalf of any of the 6, including
// yourself). The caller must be one of the 6 participants either way, since the series is
// always resolved from the caller's own membership (or the admin-gated id: override) — this
// is what keeps /nominate scoped to "the match you're in" rather than letting an outsider
// request subs for a match they have nothing to do with.
async function processSubRequest(
  interaction: DiscordInteraction,
  seriesIdOverride: string | null,
  targetDiscordId: string | null,
  nomineeDiscordId: string | null,
  requireExplicitTarget = false,
) {
  const supabase = createAdminClient();
  const discordId = interactionUserId(interaction);
  if (!discordId) {
    await editOriginalResponse(interaction.token, { content: "Couldn't identify you — try again." });
    return;
  }
  if (requireExplicitTarget && !targetDiscordId) {
    await editOriginalResponse(interaction.token, { content: "Missing target." });
    return;
  }
  if (!nomineeDiscordId) {
    await editOriginalResponse(interaction.token, { content: "Missing nominee." });
    return;
  }
  const isSelfSub = !targetDiscordId;
  const effectiveTargetDiscordId = targetDiscordId ?? discordId;

  const caller = await getOrCreatePlayer(supabase, discordId, interactionDisplayName(interaction));
  const series = await resolveSeriesForCommand(supabase, interaction, seriesIdOverride, caller.id);
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

  const { data: participants } = await supabase.from("crl6mansqueuebot_players").select("id, discord_id").in(
    "id",
    seriesPlayers.map((sp) => sp.player_id),
  );
  const byDiscordId = new Map((participants ?? []).map((p) => [p.discord_id, p]));

  // The caller resolved a series via their own membership above, so they're always in
  // byDiscordId — this check is really about the *target* when /nominate names someone else.
  const target = byDiscordId.get(effectiveTargetDiscordId);
  if (!target) {
    await editOriginalResponse(interaction.token, {
      content: isSelfSub ? "You're not part of this match." : "That player isn't part of this match.",
    });
    return;
  }
  const leavingRow = seriesPlayers.find((sp) => sp.player_id === target.id);
  if (!leavingRow) {
    await editOriginalResponse(interaction.token, { content: "Something's wrong with this match's roster — ask an admin to check it." });
    return;
  }

  if (nomineeDiscordId === effectiveTargetDiscordId) {
    await editOriginalResponse(interaction.token, {
      content: isSelfSub ? "You can't nominate yourself." : "That player can't be nominated as their own replacement.",
    });
    return;
  }
  if (byDiscordId.has(nomineeDiscordId)) {
    await editOriginalResponse(interaction.token, { content: "That player is already in this match." });
    return;
  }

  // Check if nominee is locked into another active series
  const { data: nomineePlayer } = await supabase.from("crl6mansqueuebot_players").select("id").eq("discord_id", nomineeDiscordId).maybeSingle();
  if (nomineePlayer && (await isPlayerLockedInActiveSeries(supabase, nomineePlayer.id))) {
    await editOriginalResponse(interaction.token, { content: "That player is currently locked in another match and can't be nominated." });
    return;
  }

  // Check if this nominee has already been nominated for this leaving player
  const { data: duplicateRequest } = await supabase
    .from("crl6mansqueuebot_sub_requests")
    .select("series_id")
    .eq("series_id", series.id)
    .eq("leaving_player_id", target.id)
    .eq("nominee_discord_id", nomineeDiscordId)
    .maybeSingle();
  if (duplicateRequest) {
    await editOriginalResponse(interaction.token, {
      content: isSelfSub ? "You've already nominated that player for a sub." : "That player has already been nominated as their sub.",
    });
    return;
  }

  const streaks = await getStreakIds(supabase, isSelfSub ? [target.id] : [target.id, caller.id]);
  const targetMention = mention(effectiveTargetDiscordId, { onFire: streaks.onFireIds.has(target.id), cold: streaks.coldIds.has(target.id) });
  const requestContent = isSelfSub
    ? `<@${nomineeDiscordId}> — ${targetMention} wants to sub out and nominated you to take their seat (Team ${leavingRow.team}). Accept to join the match.`
    : `<@${nomineeDiscordId}> — ${mention(discordId, { onFire: streaks.onFireIds.has(caller.id), cold: streaks.coldIds.has(caller.id) })} nominated you to sub in for ${targetMention} (Team ${leavingRow.team}). Accept to join the match.`;

  const message = (await discordFetch(`/channels/${series.queue_channel_id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: requestContent,
      components: [
        {
          type: MessageComponentTypes.ACTION_ROW,
          components: [
            {
              type: MessageComponentTypes.BUTTON,
              style: ButtonStyleTypes.SUCCESS,
              label: "Accept",
              custom_id: `sub_accept:${series.id}:${target.id}`,
            },
          ],
        },
      ],
    }),
  })) as { id: string };

  const { error: insertError } = await supabase.from("crl6mansqueuebot_sub_requests").insert({
    series_id: series.id,
    leaving_player_id: target.id,
    nominee_discord_id: nomineeDiscordId,
    team: leavingRow.team,
    message_id: message.id,
  });
  if (insertError) {
    console.error(`Failed to create sub request for series ${series.id}`, insertError);
    await editOriginalResponse(interaction.token, { content: "Something went wrong — try again." });
    return;
  }

  await editOriginalResponse(interaction.token, {
    content: isSelfSub ? `Sub request sent to <@${nomineeDiscordId}>.` : `Sub request sent to <@${nomineeDiscordId}> for <@${effectiveTargetDiscordId}>.`,
  });
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

  // Delete ALL pending sub requests from this leaving player (not just the one being accepted)
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
      // Revoking the leaving player's member-level overwrite is enough on its own — Discord
      // enforces voice-channel permission changes on already-connected users in real time, so
      // if they're actually sitting in *this* team's channel, losing CONNECT here (falling
      // back to the @everyone overwrite, which denies it — see createVoiceChannels in
      // queue.ts) disconnects them from it within seconds with no extra API call needed.
      // Deliberately not using the member PATCH `channel_id:null` endpoint here — that
      // disconnects wherever the member currently is in the *guild*, not scoped to this
      // channel, which previously kicked a leaving player out of an unrelated voice channel
      // they'd since moved to (fixed this session).
      await discordFetch(`/channels/${teamVoiceChannelId}/permissions/${leavingPlayer.discord_id}`, { method: "DELETE" }).catch((err) =>
        console.error(`Failed to revoke voice channel access from ${leavingPlayer.discord_id}`, err),
      );
    }
  }

  if (subRequest.message_id && series.queue_channel_id) {
    const streaks = await getStreakIds(supabase, leavingPlayer ? [nominee.id, leavingPlayer.id] : [nominee.id]);
    const leavingMention = leavingPlayer
      ? mention(leavingPlayer.discord_id, { onFire: streaks.onFireIds.has(leavingPlayer.id), cold: streaks.coldIds.has(leavingPlayer.id) })
      : "?";
    await discordFetch(`/channels/${series.queue_channel_id}/messages/${subRequest.message_id}`, {
      method: "PATCH",
      body: JSON.stringify({
        content: `${mention(nominee.discord_id, { onFire: streaks.onFireIds.has(nominee.id), cold: streaks.coldIds.has(nominee.id) })} accepted and has subbed in for ${leavingMention} on Team ${team}.`,
        components: [],
      }),
    }).catch((err) => console.error(`Failed to update sub request message for series ${seriesId}`, err));
  }

  await editOriginalResponse(interaction.token, { content: "You're subbed in — good luck!" });
}
