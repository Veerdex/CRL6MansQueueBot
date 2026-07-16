import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import { discordFetch, editOriginalResponse } from "./rest";
import { getConfigNumber } from "./config";
import { getOrCreatePlayer } from "./queue";
import { hasAdminAccess } from "./admin";
import { computeEloDeltas, type EloResult } from "@/lib/mmr/elo";
import { deleteMatchChannels, clearPendingSeriesState } from "./matchChannels";
import { interactionUserId, interactionDisplayName, type DiscordInteraction } from "./types";
import type { SeriesRow, Team } from "@/lib/supabase/types";

// Time between the public "reported" message and category deletion — see CLAUDE.md,
// "Match channels (created per series on pop)", "Series end".
const CLOSE_WARNING_MS = 30_000;

// ---------------------------------------------------------------------------
// /report — run inside a match text channel; series is inferred from the channel. `id:` is
// an optional override, gated to admins, for reporting from elsewhere. Result is inferred
// from the reporter's own team, no separate win/lose param. Settles immediately on first
// report. See CLAUDE.md, "Reporting & disputes".
// ---------------------------------------------------------------------------

export function handleReportCommand(interaction: DiscordInteraction) {
  const idOption = interaction.data?.options?.find((o) => o.name === "id")?.value;
  const seriesIdOverride = typeof idOption === "string" && idOption.length > 0 ? idOption : null;
  after(() => processReport(interaction, seriesIdOverride));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processReport(interaction: DiscordInteraction, seriesIdOverride: string | null) {
  const supabase = createAdminClient();
  const discordId = interactionUserId(interaction);
  if (!discordId) {
    await editOriginalResponse(interaction.token, { content: "Couldn't identify you — try again." });
    return;
  }

  let series: SeriesRow | null = null;
  if (seriesIdOverride) {
    if (!(await hasAdminAccess(interaction))) {
      await editOriginalResponse(interaction.token, { content: "Only admins can report by id: from outside the match channel." });
      return;
    }
    const { data } = await supabase.from("crl6mansqueuebot_series").select("*").eq("id", seriesIdOverride).maybeSingle();
    series = data;
  } else {
    if (!interaction.channel_id) {
      await editOriginalResponse(interaction.token, { content: "Run this inside a match channel, or pass id: as an admin." });
      return;
    }
    const { data } = await supabase
      .from("crl6mansqueuebot_series")
      .select("*")
      .eq("text_channel_id", interaction.channel_id)
      .in("status", ["forming", "active"])
      .maybeSingle();
    series = data;
  }

  if (!series) {
    await editOriginalResponse(interaction.token, { content: seriesIdOverride ? "Series not found." : "No active match to report in this channel." });
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

  const player = await getOrCreatePlayer(supabase, discordId, interactionDisplayName(interaction));
  const reporterRow = seriesPlayers.find((sp) => sp.player_id === player.id);
  if (!reporterRow) {
    await editOriginalResponse(interaction.token, { content: "You're not part of this match." });
    return;
  }
  const winner: Team = reporterRow.team;

  // Atomic settle claim: same UPDATE...WHERE-status pattern as the vote/draft resolution in
  // teamFormation.ts — Postgres row locking means only one concurrent /report call wins.
  const { data: claimed } = await supabase
    .from("crl6mansqueuebot_series")
    .update({ status: "reported", winner_team: winner, reported_at: new Date().toISOString() })
    .eq("id", series.id)
    .eq("status", "active")
    .select("id");
  if (!claimed || claimed.length === 0) {
    await editOriginalResponse(interaction.token, { content: "This match was already reported." });
    return;
  }

  await clearPendingSeriesState(supabase, series.id);

  const { data: players } = await supabase
    .from("crl6mansqueuebot_players")
    .select("*")
    .in("id", seriesPlayers.map((sp) => sp.player_id));
  const playersById = new Map((players ?? []).map((p) => [p.id, p]));

  const summaryLines: string[] = [];

  if (series.queue_type === "rank") {
    const [kFactor, sScale, provisionalGames, provisionalKMultiplier] = await Promise.all([
      getConfigNumber("k_factor", 32),
      getConfigNumber("s_scale", 400),
      getConfigNumber("provisional_games", 10),
      getConfigNumber("provisional_k_multiplier", 1.75),
    ]);

    const eloInputs = seriesPlayers.map((sp) => {
      const p = playersById.get(sp.player_id)!;
      return { playerId: p.id, mmr: p.mmr, team: sp.team, priorRankGamesPlayed: p.rank_games_played };
    });
    const results = computeEloDeltas(eloInputs, winner, { kFactor, sScale, provisionalGames, provisionalKMultiplier });
    const resultsById = new Map<string, EloResult>(results.map((r) => [r.playerId, r]));

    await Promise.all(
      seriesPlayers.map(async (sp) => {
        const p = playersById.get(sp.player_id)!;
        const r = resultsById.get(sp.player_id)!;
        await supabase
          .from("crl6mansqueuebot_players")
          .update({
            mmr: r.newMmr,
            total_games_played: p.total_games_played + 1,
            rank_games_played: p.rank_games_played + 1,
            band_games_played: p.band_games_played + 1,
          })
          .eq("id", p.id);
        await supabase.from("crl6mansqueuebot_series_players").update({ mmr_delta: r.delta }).eq("series_id", series!.id).eq("player_id", p.id);
      }),
    );

    for (const sp of seriesPlayers) {
      const p = playersById.get(sp.player_id)!;
      const r = resultsById.get(sp.player_id)!;
      const sign = r.delta >= 0 ? "+" : "";
      summaryLines.push(
        `<@${p.discord_id}> (Team ${sp.team}): ${sign}${r.delta.toFixed(1)} → ${r.newMmr.toFixed(1)}${r.wasProvisional ? " (provisional)" : ""}`,
      );
    }
  } else {
    // Universal Queue: still counts toward total_games_played (placement/lifetime), never
    // touches MMR — see CLAUDE.md, "Queueing".
    await Promise.all(
      seriesPlayers.map((sp) => {
        const p = playersById.get(sp.player_id)!;
        return supabase.from("crl6mansqueuebot_players").update({ total_games_played: p.total_games_played + 1 }).eq("id", p.id);
      }),
    );
    for (const sp of seriesPlayers) {
      const p = playersById.get(sp.player_id)!;
      summaryLines.push(`<@${p.discord_id}> (Team ${sp.team}) — Universal Queue, no MMR change`);
    }
  }

  await editOriginalResponse(interaction.token, { content: `Reported — Team ${winner} wins.` });

  if (series.text_channel_id) {
    await discordFetch(`/channels/${series.text_channel_id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content: `**Match reported — Team ${winner} wins!**\n${summaryLines.join("\n")}\n\nThis channel will close in 30 seconds.`,
      }),
    }).catch((err) => console.error(`Failed to post report summary for series ${series!.id}`, err));
  }

  await new Promise((resolve) => setTimeout(resolve, CLOSE_WARNING_MS));
  await deleteMatchChannels(supabase, series);
}
