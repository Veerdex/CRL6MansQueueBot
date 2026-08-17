import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import { discordFetch, editOriginalResponse, BRAND_COLOR, getRankEmoji } from "./rest";
import { getConfigNumber, getDisplayMMR } from "./config";
import { getOrCreatePlayer } from "./queue";
import { recomputeBands } from "./bands";
import { computeEloDeltas, computeStreakBonus, type EloResult } from "@/lib/mmr/elo";
import { getPriorRankWinStreak, getStreakIds, mention } from "./streaks";
import { encodeMatchId } from "./matchId";
import { reportResultEmbed } from "./report";
import { interactionUserId, interactionDisplayName, type DiscordInteraction } from "./types";
import type { SeriesRow, SeriesPlayerRow, Team } from "@/lib/supabase/types";

type AdminClient = ReturnType<typeof createAdminClient>;

// Votes required to flip a mis-reported match — "5 of 6" per the user's spec. Unlike
// /abandon's "3 of the remaining 5" (a target can't vote for themself), all 6 participants
// including the requester can vote here, since nobody is being blamed.
const CORRECT_VOTE_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// /correct — no options. Always targets the caller's own most-recently-reported, non-test
// match (the one the report embed's "Wrong result? Run /correct" footer pointed them at — see
// report.ts's reportResultEmbed). Once 5 of that match's 6 participants have each run /correct,
// the winner flips, MMR/bands/streaks recompute exactly like /admin correct-report, and a fresh
// report summary posts. One-time only per match — see migration 0045_correct_votes.sql.
// ---------------------------------------------------------------------------

export function handleCorrectCommand(interaction: DiscordInteraction) {
  after(() => processCorrectCommand(interaction));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function getReportChannelId(supabase: AdminClient): Promise<string | null> {
  const { data } = await supabase.from("crl6mansqueuebot_config").select("value").eq("key", "report_channel_id").maybeSingle();
  return data?.value ?? null;
}

async function processCorrectCommand(interaction: DiscordInteraction) {
  const supabase = createAdminClient();
  const discordId = interactionUserId(interaction);
  if (!discordId) {
    await editOriginalResponse(interaction.token, { content: "Couldn't identify you — try again." });
    return;
  }

  const caller = await getOrCreatePlayer(supabase, discordId, interactionDisplayName(interaction));

  // Resolved purely from the caller's own membership (never a channel or an id: override —
  // the match channel is long gone by report time, and the command takes no options), so
  // whoever votes is guaranteed to have actually played the match they're voting on.
  const { data: playedSeriesIds } = await supabase.from("crl6mansqueuebot_series_players").select("series_id").eq("player_id", caller.id);
  const seriesIds = (playedSeriesIds ?? []).map((r) => r.series_id);
  if (seriesIds.length === 0) {
    await editOriginalResponse(interaction.token, { content: "You haven't played a match yet." });
    return;
  }

  const { data: seriesData } = await supabase
    .from("crl6mansqueuebot_series")
    .select("*")
    .in("id", seriesIds)
    .eq("status", "reported")
    .eq("is_test_data", false)
    .order("reported_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const series = seriesData as SeriesRow | null;

  if (!series) {
    await editOriginalResponse(interaction.token, { content: "You don't have a reported match to correct." });
    return;
  }
  if (series.correction_claimed_at) {
    await editOriginalResponse(interaction.token, { content: "Your last match has already been corrected once and can't be corrected again." });
    return;
  }

  const { data: seriesPlayers } = await supabase.from("crl6mansqueuebot_series_players").select("*").eq("series_id", series.id);
  if (!seriesPlayers || seriesPlayers.length !== 6) {
    await editOriginalResponse(interaction.token, { content: "Something's wrong with this match's roster — ask an admin to check it." });
    return;
  }

  const matchId = encodeMatchId(series.match_number ?? 0);

  await supabase.from("crl6mansqueuebot_correct_votes").upsert({ series_id: series.id, player_id: caller.id });
  const { data: correctVotes } = await supabase.from("crl6mansqueuebot_correct_votes").select("player_id").eq("series_id", series.id);
  const voteCount = correctVotes?.length ?? 0;

  if (voteCount < CORRECT_VOTE_THRESHOLD) {
    await editOriginalResponse(interaction.token, {
      content: `Vote recorded — ${voteCount}/${CORRECT_VOTE_THRESHOLD} needed to flip Match #${matchId}.`,
    });
    const reportChannelId = await getReportChannelId(supabase);
    if (reportChannelId) {
      await discordFetch(`/channels/${reportChannelId}/messages`, {
        method: "POST",
        body: JSON.stringify({
          embeds: [{ description: `<@${discordId}> wants to correct Match #${matchId} — ${voteCount}/${CORRECT_VOTE_THRESHOLD}`, color: BRAND_COLOR }],
        }),
      }).catch((err) => console.error(`Failed to post correct-vote progress for series ${series.id}`, err));
    }
    return;
  }

  // Atomic one-time claim on a dedicated sentinel column, not `status` (this series stays
  // 'reported' throughout — see migration 0045_correct_votes.sql). Guards both a race between
  // two votes crossing the threshold at once, and a second correction attempt after this one.
  const { data: claimed } = await supabase
    .from("crl6mansqueuebot_series")
    .update({ correction_claimed_at: new Date().toISOString() })
    .eq("id", series.id)
    .is("correction_claimed_at", null)
    .select("id");
  if (!claimed || claimed.length === 0) {
    await editOriginalResponse(interaction.token, { content: "Vote recorded, but this match was already corrected." });
    return;
  }

  await supabase.from("crl6mansqueuebot_correct_votes").delete().eq("series_id", series.id);
  await applyCorrection(supabase, series, seriesPlayers, matchId);
  await editOriginalResponse(interaction.token, { content: `Match #${matchId} corrected — the result has been flipped.` });
}

// Flips the winner and, for Rank Queue series, reverses each player's old MMR delta and
// reapplies a freshly-computed one — same "reverse old, apply new" shape as adminTools.ts's
// processCorrectReport, the admin equivalent this mirrors. Unlike that admin path, this also
// posts a fresh public report embed (reportResultEmbed, report.ts), since the whole point is
// giving the community a corrected result to look at, not just fixing the DB silently.
async function applyCorrection(supabase: AdminClient, series: SeriesRow, seriesPlayers: SeriesPlayerRow[], matchId: string) {
  const oldWinner = series.winner_team as Team;
  const newWinner: Team = oldWinner === "A" ? "B" : "A";
  await supabase.from("crl6mansqueuebot_series").update({ winner_team: newWinner }).eq("id", series.id);

  const { data: playerRows } = await supabase.from("crl6mansqueuebot_players").select("*").in("id", seriesPlayers.map((sp) => sp.player_id));
  const playersById = new Map((playerRows ?? []).map((p) => [p.id, p]));

  const emojiByBand = new Map<string | null, string>();
  for (const band of [null, "Iron", "Garnet", "Emerald", "Sapphire", "Prism"]) {
    emojiByBand.set(band, await getRankEmoji(band));
  }

  const winnerLines: string[] = [];
  const loserLines: string[] = [];
  const pushLine = (sp: SeriesPlayerRow, line: string) => (sp.team === newWinner ? winnerLines : loserLines).push(line);

  if (series.queue_type === "rank") {
    const [kFactor, sScale, provisionalGames, provisionalKMultiplier, mmrScale, skewFactor, minDeltaFloor, streakBonusEnabledRaw, confidenceMultiplier] = await Promise.all([
      getConfigNumber("k_factor", 32),
      getConfigNumber("s_scale", 400),
      getConfigNumber("provisional_games", 10),
      getConfigNumber("provisional_k_multiplier", 1.75),
      getConfigNumber("mmr_scale", 1),
      getConfigNumber("mmr_skew_factor", 0.5),
      getConfigNumber("mmr_min_delta", 2),
      getConfigNumber("streak_bonus_enabled", 1),
      getConfigNumber("mmr_confidence_multiplier", 1),
    ]);
    const streakBonusEnabled = streakBonusEnabledRaw === 1;
    // Same locked-in-at-pop/vote-resolution multipliers the original report used.
    const effectiveKFactor = kFactor * series.bonus_day_multiplier * series.series_length_k_multiplier;

    const eloInputs = seriesPlayers.map((sp) => {
      const p = playersById.get(sp.player_id)!;
      return { playerId: p.id, mmr: p.mmr, team: sp.team, priorRankGamesPlayed: p.rank_games_played };
    });
    const newResults = computeEloDeltas(eloInputs, newWinner, { kFactor: effectiveKFactor, sScale, provisionalGames, provisionalKMultiplier, skewFactor, minDeltaFloor, confidenceMultiplier });
    const newResultsById = new Map<string, EloResult>(newResults.map((r) => [r.playerId, r]));

    // getPriorRankWinStreak/getPriorRankLossStreak always exclude this series by id (see
    // streaks.ts), so it doesn't matter that winner_team above was already flipped — this
    // series is filtered out of the history entirely either way.
    const bonusByPlayer = new Map<string, number>();
    if (streakBonusEnabled) {
      await Promise.all(
        seriesPlayers.map(async (sp) => {
          if (sp.team !== newWinner) return;
          const priorStreak = await getPriorRankWinStreak(supabase, sp.player_id, series.id);
          const expected = newResultsById.get(sp.player_id)!.expected;
          bonusByPlayer.set(sp.player_id, computeStreakBonus(priorStreak, expected));
        }),
      );
    }

    const finalDeltaByPlayer = new Map<string, number>();
    const correctedMmrByPlayer = new Map<string, number>();
    await Promise.all(
      seriesPlayers.map(async (sp) => {
        const p = playersById.get(sp.player_id)!;
        const oldDelta = sp.mmr_delta ?? 0;
        const newResult = newResultsById.get(sp.player_id)!;
        const newDelta = newResult.delta + (bonusByPlayer.get(sp.player_id) ?? 0);
        const correctedMmr = p.mmr - oldDelta + newDelta;
        finalDeltaByPlayer.set(sp.player_id, newDelta);
        correctedMmrByPlayer.set(sp.player_id, correctedMmr);

        await supabase
          .from("crl6mansqueuebot_players")
          .update({ mmr: correctedMmr, peak_mmr: p.is_placed ? Math.max(p.peak_mmr, correctedMmr) : p.peak_mmr })
          .eq("id", p.id);
        await supabase.from("crl6mansqueuebot_series_players").update({ mmr_delta: newDelta }).eq("series_id", series.id).eq("player_id", p.id);
      }),
    );

    // Correcting the winner can push a player across a band threshold — recompute now, same
    // as report.ts's live recompute, rather than waiting for the next daily cron tick.
    await recomputeBands();
    const { data: refreshedBands } = await supabase.from("crl6mansqueuebot_players").select("id, band, is_prism").in("id", seriesPlayers.map((sp) => sp.player_id));
    for (const rb of refreshedBands ?? []) {
      const p = playersById.get(rb.id);
      if (p) {
        p.band = rb.band;
        p.is_prism = rb.is_prism;
      }
    }

    // winner_team is already flipped in the DB (top of this function), so this now reflects
    // each player's streak *as corrected* — see getStreakIds' doc comment: no exclusion param,
    // meant to be called only after the relevant series has fully settled.
    const streakIds = await getStreakIds(supabase, seriesPlayers.map((sp) => sp.player_id));

    for (const sp of seriesPlayers) {
      const p = playersById.get(sp.player_id)!;
      const delta = finalDeltaByPlayer.get(sp.player_id)!;
      const correctedMmr = correctedMmrByPlayer.get(sp.player_id)!;
      const sign = delta >= 0 ? "+" : "";
      const emoji = emojiByBand.get(p.is_prism ? "Prism" : p.band) || "❓";
      const displayNewMmr = await getDisplayMMR(correctedMmr);
      const displayDelta = delta * mmrScale;
      const onFire = streakIds.onFireIds.has(p.id);
      const cold = streakIds.coldIds.has(p.id);
      pushLine(sp, `${mention(p.discord_id, { onFire, cold })} — ${sign}${displayDelta.toFixed(1)} MMR → ${displayNewMmr.toFixed(1)} ${emoji}`);
    }
  } else {
    // Universal Queue: no MMR/streak/band effect either way — the winner flip above is
    // purely cosmetic for these, same as report.ts's own Universal Queue branch.
    for (const sp of seriesPlayers) {
      const p = playersById.get(sp.player_id)!;
      const emoji = emojiByBand.get(p.is_prism ? "Prism" : p.band) || "❓";
      pushLine(sp, `<@${p.discord_id}> ${emoji}`);
    }
  }

  // Mirrors /admin correct-report's own prediction-record update.
  const predictionTable = series.queue_type === "rank" ? "crl6mansqueuebot_rank_game_predictions" : "crl6mansqueuebot_universal_game_predictions";
  const newActualWinner = newWinner === "A" ? "blue" : "orange";
  await (supabase as any).from(predictionTable).update({ actual_winner: newActualWinner }).eq("series_id", series.id);

  const reportChannelId = await getReportChannelId(supabase);
  if (reportChannelId) {
    const embed = reportResultEmbed(newWinner, matchId, winnerLines, loserLines, series.bonus_day_multiplier > 1, series.series_length);
    await discordFetch(`/channels/${reportChannelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ embeds: [embed] }),
    }).catch((err) => console.error(`Failed to post correction summary for series ${series.id}`, err));
  }
}
