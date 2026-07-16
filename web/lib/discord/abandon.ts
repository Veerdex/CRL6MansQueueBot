import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import { discordFetch, editOriginalResponse } from "./rest";
import { hasAdminAccess } from "./admin";
import { deleteMatchChannels, clearPendingSeriesState } from "./matchChannels";
import { interactionUserId, type DiscordInteraction } from "./types";
import type { SeriesRow } from "@/lib/supabase/types";

type AdminClient = ReturnType<typeof createAdminClient>;

// Time between the public void message and category deletion — same window as /report's
// closing warning. See CLAUDE.md, "Match channels (created per series on pop)", "Series end".
const CLOSE_WARNING_MS = 30_000;

// Votes required to void a series for abandonment — "3 of the remaining 5 players" per
// CLAUDE.md, "Mid-series abandonment". Self-votes are rejected in application code below,
// which is what makes the "remaining 5" count correct (a target can't vote for themself).
const ABANDON_VOTE_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// /abandon target:<@user> — run inside a match text channel; series is inferred from the
// channel. `id:` is an optional admin-gated override, same pattern as /report and /sub.
// Majority-vote detection: once 3 distinct participants have named the same target, the
// series cancels immediately (void, no MMR change). See CLAUDE.md, "Mid-series abandonment".
// ---------------------------------------------------------------------------

export function handleAbandonCommand(interaction: DiscordInteraction) {
  const idOption = interaction.data?.options?.find((o) => o.name === "id")?.value;
  const seriesIdOverride = typeof idOption === "string" && idOption.length > 0 ? idOption : null;
  const targetOption = interaction.data?.options?.find((o) => o.name === "target")?.value;
  const targetDiscordId = typeof targetOption === "string" ? targetOption : null;
  after(() => processAbandon(interaction, seriesIdOverride, targetDiscordId));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function resolveSeriesForCommand(
  supabase: AdminClient,
  interaction: DiscordInteraction,
  seriesIdOverride: string | null,
): Promise<SeriesRow | null | "forbidden"> {
  if (seriesIdOverride) {
    if (!(await hasAdminAccess(interaction))) return "forbidden";
    const { data } = await supabase.from("crl6mansqueuebot_series").select("*").eq("id", seriesIdOverride).maybeSingle();
    return data;
  }
  if (!interaction.channel_id) return null;
  const { data } = await supabase
    .from("crl6mansqueuebot_series")
    .select("*")
    .eq("text_channel_id", interaction.channel_id)
    .in("status", ["forming", "active"])
    .maybeSingle();
  return data;
}

async function processAbandon(interaction: DiscordInteraction, seriesIdOverride: string | null, targetDiscordId: string | null) {
  const supabase = createAdminClient();
  const discordId = interactionUserId(interaction);
  if (!discordId) {
    await editOriginalResponse(interaction.token, { content: "Couldn't identify you — try again." });
    return;
  }
  if (!targetDiscordId) {
    await editOriginalResponse(interaction.token, { content: "Missing target." });
    return;
  }

  const series = await resolveSeriesForCommand(supabase, interaction, seriesIdOverride);
  if (series === "forbidden") {
    await editOriginalResponse(interaction.token, { content: "Only admins can report abandonment by id: from outside the match channel." });
    return;
  }
  if (!series) {
    await editOriginalResponse(interaction.token, { content: seriesIdOverride ? "Series not found." : "No active match to report abandonment in this channel." });
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

  const { data: seriesPlayers } = await supabase.from("crl6mansqueuebot_series_players").select("*").eq("series_id", series.id);
  if (!seriesPlayers || seriesPlayers.length !== 6) {
    await editOriginalResponse(interaction.token, { content: "Something's wrong with this match's roster — ask an admin to check it." });
    return;
  }

  const { data: participants } = await supabase.from("crl6mansqueuebot_players").select("*").in(
    "id",
    seriesPlayers.map((sp) => sp.player_id),
  );
  const byDiscordId = new Map((participants ?? []).map((p) => [p.discord_id, p]));

  const voter = byDiscordId.get(discordId);
  if (!voter) {
    await editOriginalResponse(interaction.token, { content: "You're not part of this match." });
    return;
  }
  const target = byDiscordId.get(targetDiscordId);
  if (!target) {
    await editOriginalResponse(interaction.token, { content: "That player isn't part of this match." });
    return;
  }
  if (target.id === voter.id) {
    await editOriginalResponse(interaction.token, { content: "You can't vote yourself as abandoned." });
    return;
  }

  await supabase.from("crl6mansqueuebot_abandon_votes").upsert({ series_id: series.id, voter_player_id: voter.id, target_player_id: target.id });

  const { data: votesForTarget } = await supabase
    .from("crl6mansqueuebot_abandon_votes")
    .select("voter_player_id")
    .eq("series_id", series.id)
    .eq("target_player_id", target.id);
  const voteCount = votesForTarget?.length ?? 0;

  if (voteCount < ABANDON_VOTE_THRESHOLD) {
    await editOriginalResponse(interaction.token, {
      content: `Vote recorded — ${voteCount}/${ABANDON_VOTE_THRESHOLD} needed to void the series over <@${targetDiscordId}>.`,
    });
    return;
  }

  // Atomic settle claim: same UPDATE...WHERE-status pattern as /report — Postgres row
  // locking means only one caller (a concurrent /abandon crossing the threshold, or a
  // simultaneous /report) can settle this series.
  const { data: claimed } = await supabase.from("crl6mansqueuebot_series").update({ status: "void" }).eq("id", series.id).eq("status", "active").select("id");
  if (!claimed || claimed.length === 0) {
    await editOriginalResponse(interaction.token, { content: "Vote recorded, but this match was already settled." });
    return;
  }

  await clearPendingSeriesState(supabase, series.id);
  await editOriginalResponse(interaction.token, { content: "Vote recorded — series cancelled." });

  if (series.text_channel_id) {
    await discordFetch(`/channels/${series.text_channel_id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content: `**Series cancelled** — <@${targetDiscordId}> was voted as abandoned by ${ABANDON_VOTE_THRESHOLD} teammates. No MMR change.\n\nThis channel will close in 30 seconds.`,
      }),
    }).catch((err) => console.error(`Failed to post abandon-void summary for series ${series.id}`, err));
  }

  await new Promise((resolve) => setTimeout(resolve, CLOSE_WARNING_MS));
  await deleteMatchChannels(supabase, series);
}
