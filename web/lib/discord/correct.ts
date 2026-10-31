import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import { discordFetch, editOriginalResponse, BRAND_COLOR, getRankEmoji } from "./rest";
import { getConfigNumber, getDisplayMMR } from "./config";
import { getOrCreatePlayer } from "./queue";
import { recomputeBands } from "./bands";
import { computeEloDeltas, type EloResult } from "@/lib/mmr/elo";
import { getPriorRankWinStreak, getStreakIds, mention } from "./streaks";
import { encodeMatchId } from "./matchId";
import { reportResultEmbed, winnerLoserOddsPct } from "./report";
import { expectedWinProbabilityA } from "@/lib/mmr/teamStrength";
import { flippedSeriesResult, formatSeriesResult, sameSeriesResult, seriesResultMultiplier, seriesScoreChanged, validateSeriesScore, type SeriesResult } from "@/lib/mmr/seriesScore";
import { interactionUserId, interactionDisplayName, type DiscordInteraction } from "./types";
import type { SeriesRow, SeriesPlayerRow, Team } from "@/lib/supabase/types";

type AdminClient = ReturnType<typeof createAdminClient>;

// Votes for the *same* corrected result required to apply it — "4 of 6" per the user's spec
// (was 5 of 6). All 6 participants including the requester can vote, since nobody is being
// blamed. At 4 of 6, two different proposals can never both reach it.
export const CORRECT_VOTE_THRESHOLD = 4;

// ---------------------------------------------------------------------------
// /correct — always targets the caller's own most-recently-reported, non-test match (the one
// the report embed's "Wrong result? Run /correct" footer pointed them at — see report.ts's
// reportResultEmbed). In win/loss mode it takes no options and each vote proposes flipping the
// winner (any stored score's margin carries over). In score mode (/admin report-mode) it takes
// `my-games:`/`opponent-games:` like /report, so a wrong score can be fixed even when the
// winner was right. Once 4 of the match's 6 participants vote for the same result, it's
// applied: MMR/bands/streaks recompute exactly like /admin correct-report and a fresh report
// summary posts. A re-vote replaces the caller's earlier one. One-time only per match — see
// migrations 0045_correct_votes.sql and 0056_correct_vote_score.sql.
// ---------------------------------------------------------------------------

type CorrectInput = { myGames: number | null; opponentGames: number | null };

export function handleCorrectCommand(interaction: DiscordInteraction) {
  const option = (name: string) => interaction.data?.options?.find((o) => o.name === name)?.value;
  const myGamesOption = option("my-games");
  const opponentGamesOption = option("opponent-games");
  const input: CorrectInput = {
    myGames: typeof myGamesOption === "number" ? myGamesOption : null,
    opponentGames: typeof opponentGamesOption === "number" ? opponentGamesOption : null,
  };
  after(() => processCorrectCommand(interaction, input));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function getReportChannelId(supabase: AdminClient): Promise<string | null> {
  const { data } = await supabase.from("crl6mansqueuebot_config").select("value").eq("key", "report_channel_id").maybeSingle();
  return data?.value ?? null;
}

async function processCorrectCommand(interaction: DiscordInteraction, input: CorrectInput) {
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
  const callerTeam = seriesPlayers.find((sp) => sp.player_id === caller.id)!.team;
  const current: SeriesResult = { winner: series.winner_team as Team, winnerGames: series.winner_games, loserGames: series.loser_games };

  // Same rule as report.ts: the config decides the mode, and a stale command shape is still
  // accepted rather than leaving nobody able to vote — a scoreless /correct in score mode is a
  // plain flip vote, and stray score options in win/loss mode are ignored.
  const scoreMode = (await getConfigNumber("report_score_mode_enabled", 0)) === 1;
  let proposal: SeriesResult;
  if (scoreMode && input.myGames !== null && input.opponentGames !== null) {
    const validation = validateSeriesScore(input.myGames, input.opponentGames, series.series_length);
    if (!validation.ok) {
      await editOriginalResponse(interaction.token, { content: validation.error });
      return;
    }
    const otherTeam: Team = callerTeam === "A" ? "B" : "A";
    proposal = { winner: validation.reporterWon ? callerTeam : otherTeam, winnerGames: validation.winnerGames, loserGames: validation.loserGames };
    if (sameSeriesResult(proposal, current)) {
      await editOriginalResponse(interaction.token, { content: `That's already the reported result for Match #${matchId} (${formatSeriesResult(current)}).` });
      return;
    }
  } else {
    proposal = flippedSeriesResult(current);
  }

  // Upsert on (series_id, player_id), so a re-vote replaces the caller's earlier proposal. The
  // proposed_* columns are migration 0056's — without it every vote fails here, so say so
  // rather than reporting a vote that was never recorded.
  const { error: voteError } = await supabase.from("crl6mansqueuebot_correct_votes").upsert({
    series_id: series.id,
    player_id: caller.id,
    proposed_winner: proposal.winner,
    proposed_winner_games: proposal.winnerGames,
    proposed_loser_games: proposal.loserGames,
    voted_at: new Date().toISOString(),
  });
  if (voteError) {
    console.error(`Failed to record correct vote for series ${series.id}`, voteError);
    await editOriginalResponse(interaction.token, { content: "Couldn't record your vote — ask an admin to check that migration 0056_correct_vote_score.sql is applied." });
    return;
  }
  const { data: correctVotes } = await supabase
    .from("crl6mansqueuebot_correct_votes")
    .select("proposed_winner, proposed_winner_games, proposed_loser_games")
    .eq("series_id", series.id);
  const voteCount = (correctVotes ?? []).filter((v) =>
    sameSeriesResult({ winner: v.proposed_winner, winnerGames: v.proposed_winner_games, loserGames: v.proposed_loser_games }, proposal),
  ).length;
  const proposalLabel = formatSeriesResult(proposal);

  if (voteCount < CORRECT_VOTE_THRESHOLD) {
    await editOriginalResponse(interaction.token, {
      content: `Vote recorded — ${voteCount}/${CORRECT_VOTE_THRESHOLD} needed to correct Match #${matchId} to ${proposalLabel}.`,
    });
    const reportChannelId = await getReportChannelId(supabase);
    if (reportChannelId) {
      await discordFetch(`/channels/${reportChannelId}/messages`, {
        method: "POST",
        body: JSON.stringify({
          embeds: [{ description: `<@${discordId}> wants to correct Match #${matchId} to **${proposalLabel}** — ${voteCount}/${CORRECT_VOTE_THRESHOLD}`, color: BRAND_COLOR }],
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
  await applyCorrection(supabase, series, seriesPlayers, matchId, proposal);
  await editOriginalResponse(interaction.token, { content: `Match #${matchId} corrected — ${proposalLabel}.` });
}

// Applies the corrected result (which may keep the winner and change only the score) and
// reverses each player's old MMR delta, reapplying a freshly-computed one — same "reverse old,
// apply new" shape as adminTools.ts's processCorrectReport, the admin equivalent this mirrors.
// Unlike that admin path, this also posts a fresh public report embed (reportResultEmbed,
// report.ts), since the whole point is giving the community a corrected result to look at, not
// just fixing the DB silently.
async function applyCorrection(supabase: AdminClient, series: SeriesRow, seriesPlayers: SeriesPlayerRow[], matchId: string, result: SeriesResult) {
  const newWinner = result.winner;
  // A flip keeps the report-time score_multiplier snapshot (migration 0055); only a changed score
  // gets a fresh one. The score columns are written only then too, so a win/loss-mode flip's
  // update is exactly what it was before 0055 existed — same precedent as report.ts's claim.
  const scoreChanged = seriesScoreChanged({ winner: series.winner_team as Team, winnerGames: series.winner_games, loserGames: series.loser_games }, result);
  const scoreMultiplier = scoreChanged ? seriesResultMultiplier(result, series.series_length) : Number(series.score_multiplier ?? 1);
  await supabase
    .from("crl6mansqueuebot_series")
    .update({
      winner_team: newWinner,
      ...(scoreChanged ? { winner_games: result.winnerGames, loser_games: result.loserGames, score_multiplier: scoreMultiplier } : {}),
    })
    .eq("id", series.id);

  const { data: playerRows } = await supabase.from("crl6mansqueuebot_players").select("*").in("id", seriesPlayers.map((sp) => sp.player_id));
  const playersById = new Map((playerRows ?? []).map((p) => [p.id, p]));

  const emojiByBand = new Map<string | null, string>();
  for (const band of [null, "Iron", "Garnet", "Emerald", "Sapphire", "Prism"]) {
    emojiByBand.set(band, await getRankEmoji(band));
  }

  const winnerLines: string[] = [];
  const loserLines: string[] = [];
  const pushLine = (sp: SeriesPlayerRow, line: string) => (sp.team === newWinner ? winnerLines : loserLines).push(line);

  const [kFactor, sScale, provisionalGames, provisionalKMultiplier, mmrScale, skewFactor, minDeltaFloor, streakBonusEnabledRaw, confidenceMultiplier, streakMaxMultiplierRaw] = await Promise.all([
    getConfigNumber("k_factor", 32),
    getConfigNumber("s_scale", 400),
    getConfigNumber("provisional_games", 10),
    getConfigNumber("provisional_k_multiplier", 1.75),
    getConfigNumber("mmr_scale", 1),
    getConfigNumber("mmr_skew_factor", 0.5),
    getConfigNumber("mmr_min_delta", 2),
    getConfigNumber("streak_bonus_enabled", 1),
    getConfigNumber("mmr_confidence_multiplier", 1),
    getConfigNumber("streak_bonus_max_multiplier", 1.5),
  ]);
  // 1x is computeEloDeltas's documented no-op — see report.ts for why the toggle gates only the
  // extra MMR and not streak tracking itself.
  const streakMaxMultiplier = streakBonusEnabledRaw === 1 ? streakMaxMultiplierRaw : 1;
  // Same locked-in-at-pop/vote-resolution multipliers the original report used.
  // series_length_k_multiplier is passed as seriesLengthMultiplier below, not folded into
  // effectiveKFactor — see EloConfig.seriesLengthMultiplier's comment.
  const effectiveKFactor = kFactor * series.bonus_day_multiplier;

  // getPriorRankWinStreak/getPriorRankLossStreak always exclude this series by id (see
  // streaks.ts), so it doesn't matter that winner_team above was already corrected — this
  // series is filtered out of the history entirely either way. Read before the Elo call because
  // the streak multiplier is applied inside it now rather than folded onto its output.
  const priorStreakById = new Map<string, number>();
  await Promise.all(
    seriesPlayers.map(async (sp) => {
      if (sp.team !== newWinner) return;
      priorStreakById.set(sp.player_id, await getPriorRankWinStreak(supabase, sp.player_id, series.id));
    }),
  );

  const eloInputs = seriesPlayers.map((sp) => {
    const p = playersById.get(sp.player_id)!;
    return {
      playerId: p.id,
      mmr: p.mmr,
      team: sp.team,
      priorRankGamesPlayed: p.rank_games_played,
      priorRankWinStreak: priorStreakById.get(p.id) ?? 0,
    };
  });
  // scoreMultiplier: the report-time snapshot for a flip, a fresh one for a corrected score (above).
  const newResults = computeEloDeltas(eloInputs, newWinner, { kFactor: effectiveKFactor, sScale, provisionalGames, provisionalKMultiplier, skewFactor, minDeltaFloor, confidenceMultiplier, seriesLengthMultiplier: series.series_length_k_multiplier, scoreMarginMultiplier: scoreMultiplier, streakMaxMultiplier });
  const newResultsById = new Map<string, EloResult>(newResults.map((r) => [r.playerId, r]));

  const finalDeltaByPlayer = new Map<string, number>();
  const correctedMmrByPlayer = new Map<string, number>();
  for (const sp of seriesPlayers) {
    const p = playersById.get(sp.player_id)!;
    const oldDelta = sp.mmr_delta ?? 0;
    const newResult = newResultsById.get(sp.player_id)!;
    const newDelta = newResult.delta;
    finalDeltaByPlayer.set(sp.player_id, newDelta);
    correctedMmrByPlayer.set(sp.player_id, p.mmr - oldDelta + newDelta);
  }

  // peak_mmr normally only ever rises (Math.max against the stored value), but a correction is
  // exactly the moment a stored peak might be provably wrong: if it drops a currently-placed
  // player's mmr below their recorded peak, that peak may have been set by the very result now
  // being corrected. For just those candidates, a full history replay determines each player's
  // true lifetime peak from current data and is allowed to lower the stored value — see
  // lib/mmr/peakMmrRecompute.ts's header for why the full player population is required.
  const peakCandidates = seriesPlayers.filter((sp) => {
    const p = playersById.get(sp.player_id)!;
    return p.is_placed && correctedMmrByPlayer.get(sp.player_id)! < p.peak_mmr;
  });
  let reconstructedPeaks: Map<string, number> | null = null;
  if (peakCandidates.length > 0) {
    const { recomputeTruePeakMmr } = await import("@/lib/mmr/peakMmrRecompute");
    reconstructedPeaks = (await recomputeTruePeakMmr(supabase)).peakMmrByPlayer;
  }

  await Promise.all(
    seriesPlayers.map(async (sp) => {
      const p = playersById.get(sp.player_id)!;
      const correctedMmr = correctedMmrByPlayer.get(sp.player_id)!;
      const newDelta = finalDeltaByPlayer.get(sp.player_id)!;
      const isCandidate = reconstructedPeaks !== null && peakCandidates.includes(sp);
      const peakMmr = isCandidate
        ? Math.max(reconstructedPeaks!.get(p.id) ?? 0, correctedMmr, 0)
        : p.is_placed
          ? Math.max(p.peak_mmr, correctedMmr)
          : p.peak_mmr;

      await supabase
        .from("crl6mansqueuebot_players")
        .update({ mmr: correctedMmr, peak_mmr: peakMmr })
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

  // winner_team is already corrected in the DB (top of this function), so this now reflects
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

  // Mirrors /admin correct-report's own prediction-record update.
  const newActualWinner = newWinner === "A" ? "blue" : "orange";
  // The same pre-match odds the original report embed showed, read from the mmr_before
  // snapshot rather than recomputed from current MMR — those have already moved by the original
  // report's deltas, so recomputing would quote a different number for the same match. The
  // percentages belong to the teams, not to the result, so flipping the winner only relabels
  // which side each one sits on. A match reported before migration 0032 has no snapshot and
  // simply gets no odds.
  const mmrBeforeForTeam = (team: Team) =>
    seriesPlayers.filter((sp) => sp.team === team).map((sp) => sp.mmr_before).filter((m): m is number => m !== null);
  const correctedExpectedA = expectedWinProbabilityA(mmrBeforeForTeam("A"), mmrBeforeForTeam("B"), sScale);
  const winOdds = correctedExpectedA === null ? null : winnerLoserOddsPct(correctedExpectedA, newWinner);

  await (supabase as any).from("crl6mansqueuebot_rank_game_predictions").update({ actual_winner: newActualWinner }).eq("series_id", series.id);

  const reportChannelId = await getReportChannelId(supabase);
  if (reportChannelId) {
    const score = result.winnerGames !== null && result.loserGames !== null ? { winnerGames: result.winnerGames, loserGames: result.loserGames } : null;
    const embed = reportResultEmbed(newWinner, matchId, winnerLines, loserLines, series.bonus_day_multiplier > 1, series.series_length, winOdds, score);
    await discordFetch(`/channels/${reportChannelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ embeds: [embed] }),
    }).catch((err) => console.error(`Failed to post correction summary for series ${series.id}`, err));
  }
}
