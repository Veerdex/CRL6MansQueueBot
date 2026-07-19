import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import { discordFetch, editOriginalResponse, deleteOriginalResponse, BRAND_COLOR, getRankEmoji } from "./rest";
import { getConfigNumber, getDisplayMMR } from "./config";
import { getOrCreatePlayer } from "./queue";
import { hasAdminAccess } from "./admin";
import { computeEloDeltas, type EloResult } from "@/lib/mmr/elo";
import { deleteMatchChannels, clearPendingSeriesState } from "./matchChannels";
import { cleanupTestMatchRows } from "./testMatch";
import { getRankLabel } from "@/lib/leaderboard/rankIcon";
import { encodeMatchId } from "./matchId";
import { interactionUserId, interactionDisplayName, type DiscordInteraction } from "./types";
import type { SeriesRow, Team, PlayerRow } from "@/lib/supabase/types";

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
  const result = typeof resultOption === "string" ? resultOption : null;
  after(() => processReport(interaction, result));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processReport(interaction: DiscordInteraction, result: string | null) {
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

  const player = await getOrCreatePlayer(supabase, discordId, interactionDisplayName(interaction));
  const { data: playerSeriesIds } = await supabase
    .from("crl6mansqueuebot_series_players")
    .select("series_id")
    .eq("player_id", player.id);

  if (!playerSeriesIds || playerSeriesIds.length === 0) {
    await editOriginalResponse(interaction.token, { content: "You're not part of an active match." });
    return;
  }

  const seriesIds = playerSeriesIds.map((s) => s.series_id);
  const { data: activeSeries } = await supabase
    .from("crl6mansqueuebot_series")
    .select("*")
    .in("id", seriesIds)
    .eq("status", "active")
    .maybeSingle();
  const series = activeSeries;

  if (!series) {
    await editOriginalResponse(interaction.token, { content: "No active match to report." });
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

  const { data: allSeriesPlayers } = await supabase.from("crl6mansqueuebot_series_players").select("*").eq("series_id", series.id);
  if (!allSeriesPlayers || allSeriesPlayers.length !== 6) {
    await editOriginalResponse(interaction.token, { content: "Something's wrong with this match's roster — ask an admin to check it." });
    return;
  }

  const reporterRow = allSeriesPlayers.find((sp) => sp.player_id === player.id);
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

  // Assign match number (based on count of previously reported series)
  const { count: reportedCount } = await supabase
    .from("crl6mansqueuebot_series")
    .select("id", { count: "exact", head: true })
    .eq("status", "reported")
    .lt("reported_at", new Date().toISOString());
  const matchNumber = (reportedCount ?? 0) - 1; // -1 because we just added this series
  await supabase.from("crl6mansqueuebot_series").update({ match_number: matchNumber } as any).eq("id", series.id);

  await clearPendingSeriesState(supabase, series.id);

  const { data: players } = await supabase
    .from("crl6mansqueuebot_players")
    .select("*")
    .in("id", allSeriesPlayers.map((sp) => sp.player_id));
  const playersById = new Map((players ?? []).map((p) => [p.id, p]));

  // Report summary is split by winning/losing team (not one flat list) — each line shows the
  // player's MMR delta and their resulting MMR/band, per CLAUDE.md's "Reporting & disputes".
  // Band itself isn't recomputed live (bands.ts's recompute is a daily cron job — see
  // CLAUDE.md, "Bands / ranks"), so the band shown here is the player's last-known band as of
  // the most recent daily recompute, not necessarily reflecting this exact game's MMR change.
  const winnerLines: string[] = [];
  const loserLines: string[] = [];
  const pushLine = (sp: (typeof allSeriesPlayers)[number], line: string) => (sp.team === winner ? winnerLines : loserLines).push(line);

  // Pre-fetch all rank emoji to avoid async calls in loops
  const emojiByBand = new Map<string | null, string>();
  for (const band of [null, "Iron", "Garnet", "Emerald", "Sapphire"]) {
    emojiByBand.set(band, await getRankEmoji(band));
  }

  if (series.is_test_data) {
    // Test matches (/test-rank-match, /test-universal-match) never touch real player stats,
    // even when queue_type is "rank" — see CLAUDE.md, "Flag as test data".
    for (const sp of allSeriesPlayers) {
      const p = playersById.get(sp.player_id)!;
      const emoji = emojiByBand.get(p.band) || "❓";
      pushLine(sp, `<@${p.discord_id}> — test match, no stat changes ${emoji}`);
    }
  } else if (series.queue_type === "rank") {
    const [kFactor, sScale, provisionalGames, provisionalKMultiplier] = await Promise.all([
      getConfigNumber("k_factor", 32),
      getConfigNumber("s_scale", 400),
      getConfigNumber("provisional_games", 10),
      getConfigNumber("provisional_k_multiplier", 1.75),
    ]);

    const eloInputs = allSeriesPlayers.map((sp) => {
      const p = playersById.get(sp.player_id)!;
      return { playerId: p.id, mmr: p.mmr, team: sp.team, priorRankGamesPlayed: p.rank_games_played };
    });
    const results = computeEloDeltas(eloInputs, winner, { kFactor, sScale, provisionalGames, provisionalKMultiplier });
    const resultsById = new Map<string, EloResult>(results.map((r) => [r.playerId, r]));

    await Promise.all(
      allSeriesPlayers.map(async (sp) => {
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

    for (const sp of allSeriesPlayers) {
      const p = playersById.get(sp.player_id)!;
      const r = resultsById.get(sp.player_id)!;
      const sign = r.delta >= 0 ? "+" : "";
      const emoji = emojiByBand.get(p.band) || "❓";
      const displayNewMmr = await getDisplayMMR(r.newMmr);
      pushLine(
        sp,
        `<@${p.discord_id}> — ${sign}${r.delta.toFixed(1)} MMR → ${displayNewMmr.toFixed(1)} ${emoji}`,
      );
    }
  } else {
    // Universal Queue: still counts toward total_games_played (placement/lifetime), never
    // touches MMR — see CLAUDE.md, "Queueing".
    await Promise.all(
      allSeriesPlayers.map((sp) => {
        const p = playersById.get(sp.player_id)!;
        return supabase.from("crl6mansqueuebot_players").update({ total_games_played: p.total_games_played + 1 }).eq("id", p.id);
      }),
    );
    for (const sp of allSeriesPlayers) {
      const p = playersById.get(sp.player_id)!;
      const emoji = emojiByBand.get(p.band) || "❓";
      pushLine(sp, `<@${p.discord_id}> ${emoji}`);
    }
  }

  // Record game prediction if all players are placed (>= 10 games played)
  const allPlayersPlaced = allSeriesPlayers.every((sp) => {
    const p = playersById.get(sp.player_id)!;
    return p.total_games_played >= 10;
  });

  if (allPlayersPlaced && !series.is_test_data) {
    const teamAPlayers = allSeriesPlayers.filter((sp) => sp.team === "A").map((sp) => playersById.get(sp.player_id)!);
    const teamBPlayers = allSeriesPlayers.filter((sp) => sp.team === "B").map((sp) => playersById.get(sp.player_id)!);

    const teamAAvgMmr = teamAPlayers.reduce((sum, p) => sum + p.mmr, 0) / 3;
    const teamBAvgMmr = teamBPlayers.reduce((sum, p) => sum + p.mmr, 0) / 3;

    // Calculate Team Blue win probability (Elo formula)
    // Assume Team A is Blue, Team B is Orange
    const sPrediction = 400;
    const teamBlueWinProbability = (1 / (1 + Math.pow(10, (teamBAvgMmr - teamAAvgMmr) / sPrediction))) * 100;

    const predictionTable =
      series.queue_type === "rank"
        ? "crl6mansqueuebot_rank_game_predictions"
        : "crl6mansqueuebot_universal_game_predictions";

    const actualWinner = winner === "A" ? "blue" : "orange";

    await (supabase as any)
      .from(predictionTable)
      .insert({
        series_id: series.id,
        reported_at: new Date().toISOString(),
        team_blue_mmr_1: teamAPlayers[0]!.mmr,
        team_blue_mmr_2: teamAPlayers[1]!.mmr,
        team_blue_mmr_3: teamAPlayers[2]!.mmr,
        team_orange_mmr_1: teamBPlayers[0]!.mmr,
        team_orange_mmr_2: teamBPlayers[1]!.mmr,
        team_orange_mmr_3: teamBPlayers[2]!.mmr,
        team_blue_win_probability: Math.round(teamBlueWinProbability * 100) / 100,
        actual_winner: actualWinner,
      });
  }

  // Fetch admin-specified report channel
  const { data: reportChannelConfig } = await supabase
    .from("crl6mansqueuebot_config")
    .select("value")
    .eq("key", "report_channel_id")
    .maybeSingle();

  const reportChannelId = reportChannelConfig?.value;
  if (reportChannelId) {
    const matchId = encodeMatchId(matchNumber);
    const embed = reportResultEmbed(winner, matchId, winnerLines, loserLines);
    await discordFetch(`/channels/${reportChannelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ embeds: [embed] }),
    }).catch((err) => console.error(`Failed to post report summary for series ${series.id}`, err));
  } else {
    console.error(`Report channel not configured for series ${series.id}`);
  }

  await new Promise((resolve) => setTimeout(resolve, CLOSE_WARNING_MS));
  await deleteMatchChannels(supabase, series);

  if (series.is_test_data) {
    await cleanupTestMatchRows(supabase, series.id);
  }

  await deleteOriginalResponse(interaction.token);
}

function reportResultEmbed(winner: Team, matchId: string, winnerLines: string[], loserLines: string[]) {
  return {
    color: BRAND_COLOR,
    title: `Match Reported — Team ${winner} Wins!`,
    description:
      `**Match #${matchId}**\n\n` +
      `**Winners**\n${winnerLines.join("\n")}\n\n` +
      `**Losers**\n${loserLines.join("\n")}`,
  };
}
