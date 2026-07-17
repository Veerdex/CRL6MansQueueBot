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
import { cleanupTestMatchRows } from "./testMatch";
import { getRankIconPath, getRankLabel } from "@/lib/leaderboard/rankIcon";
import { interactionUserId, interactionDisplayName, type DiscordInteraction } from "./types";
import type { SeriesRow, Team } from "@/lib/supabase/types";

// Instant deletion of voice channels after report
const CLOSE_WARNING_MS = 0;

// ---------------------------------------------------------------------------
// /report — run inside a match text channel; series is inferred from the channel. `id:` is
// an optional override, gated to admins, for reporting from elsewhere. Result is inferred
// from the reporter's own team, no separate win/lose param. Settles immediately on first
// report. See CLAUDE.md, "Reporting & disputes".
// ---------------------------------------------------------------------------

export function handleReportCommand(interaction: DiscordInteraction) {
  const resultOption = interaction.data?.options?.find((o) => o.name === "result")?.value;
  const idOption = interaction.data?.options?.find((o) => o.name === "id")?.value;
  const seriesIdOverride = typeof idOption === "string" && idOption.length > 0 ? idOption : null;
  const result = typeof resultOption === "string" ? resultOption : null;
  after(() => processReport(interaction, seriesIdOverride, result));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processReport(interaction: DiscordInteraction, seriesIdOverride: string | null, result: string | null) {
  if (!result || (result !== "win" && result !== "loss")) {
    await editOriginalResponse(interaction.token, { content: "Invalid result. Use 'win' or 'loss'." });
    return;
  }

  const supabase = createAdminClient();
  const discordId = interactionUserId(interaction);
  if (!discordId) {
    await editOriginalResponse(interaction.token, { content: "Couldn't identify you — try again." });
    return;
  }

  let series: SeriesRow | null = null;
  if (seriesIdOverride) {
    if (!(await hasAdminAccess(interaction))) {
      await editOriginalResponse(interaction.token, { content: "Only admins can report by id:." });
      return;
    }
    const { data } = await supabase.from("crl6mansqueuebot_series").select("*").eq("id", seriesIdOverride).maybeSingle();
    series = data;
  } else {
    // Find which active series the player is locked into
    const player = await getOrCreatePlayer(supabase, discordId, interactionDisplayName(interaction));
    const { data: seriesPlayers } = await supabase
      .from("crl6mansqueuebot_series_players")
      .select("series_id")
      .eq("player_id", player.id);

    if (!seriesPlayers || seriesPlayers.length === 0) {
      await editOriginalResponse(interaction.token, { content: "You're not part of an active match." });
      return;
    }

    const seriesIds = seriesPlayers.map((s) => s.series_id);
    const { data: activeSeries } = await supabase
      .from("crl6mansqueuebot_series")
      .select("*")
      .in("id", seriesIds)
      .eq("status", "active")
      .maybeSingle();
    series = activeSeries;
  }

  if (!series) {
    await editOriginalResponse(interaction.token, { content: seriesIdOverride ? "Series not found." : "No active match to report." });
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
  const winner: Team = result === "win" ? reporterRow.team : (reporterRow.team === "A" ? "B" : "A");

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

  // Report summary is split by winning/losing team (not one flat list) — each line shows the
  // player's MMR delta and their resulting MMR/band, per CLAUDE.md's "Reporting & disputes".
  // Band itself isn't recomputed live (bands.ts's recompute is a daily cron job — see
  // CLAUDE.md, "Bands / ranks"), so the band shown here is the player's last-known band as of
  // the most recent daily recompute, not necessarily reflecting this exact game's MMR change.
  const winnerLines: string[] = [];
  const loserLines: string[] = [];
  const pushLine = (sp: (typeof seriesPlayers)[number], line: string) => (sp.team === winner ? winnerLines : loserLines).push(line);

  if (series.is_test_data) {
    // Test matches (/test-rank-match, /test-universal-match) never touch real player stats,
    // even when queue_type is "rank" — see CLAUDE.md, "Flag as test data".
    for (const sp of seriesPlayers) {
      const p = playersById.get(sp.player_id)!;
      const rankIconUrl = `https://crl6mans-queue-bot.vercel.app${getRankIconPath(p.band)}`;
      pushLine(sp, `<@${p.discord_id}> — test match, no stat changes ${rankIconUrl}`);
    }
  } else if (series.queue_type === "rank") {
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
      const rankLabel = getRankLabel(p.band);
      const rankIconUrl = `https://crl6mans-queue-bot.vercel.app${getRankIconPath(p.band)}`;
      pushLine(
        sp,
        `<@${p.discord_id}> — ${sign}${r.delta.toFixed(1)} MMR → ${r.newMmr.toFixed(1)} ${rankIconUrl}`,
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
      const rankIconUrl = `https://crl6mans-queue-bot.vercel.app${getRankIconPath(p.band)}`;
      pushLine(sp, `<@${p.discord_id}> — Universal Queue, no MMR change ${rankIconUrl}`);
    }
  }


  // Fetch admin-specified report channel
  const { data: reportChannelConfig } = await supabase
    .from("crl6mansqueuebot_config")
    .select("value")
    .eq("key", "report_channel_id")
    .maybeSingle();

  const reportChannelId = reportChannelConfig?.value;
  if (reportChannelId) {
    await discordFetch(`/channels/${reportChannelId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content:
          `**Match reported — Team ${winner} wins!**\n\n` +
          `**Winners**\n${winnerLines.join("\n")}\n\n` +
          `**Losers**\n${loserLines.join("\n")}`,
      }),
    }).catch((err) => console.error(`Failed to post report summary for series ${series!.id}`, err));
  } else {
    console.error(`Report channel not configured for series ${series.id}`);
  }

  await new Promise((resolve) => setTimeout(resolve, CLOSE_WARNING_MS));
  await deleteMatchChannels(supabase, series);

  if (series.is_test_data) {
    await cleanupTestMatchRows(supabase, series.id);
  }
}
