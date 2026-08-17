import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import { discordFetch, editOriginalResponse, deleteOriginalResponse, BRAND_COLOR, AMBER_COLOR, SUPERCHARGED_COLOR, getRankEmoji } from "./rest";
import { getConfigNumber, getDisplayMMR } from "./config";
import { getOrCreatePlayer, refreshQueueMessageAfterSettlement } from "./queue";
import { hasAdminAccess } from "./admin";
import { recomputeBands } from "./bands";
import { computeEloDeltas, computeStreakBonus, type EloResult } from "@/lib/mmr/elo";
import { getPriorRankWinStreak, getPriorRankLossStreak, mention, ON_FIRE_THRESHOLD, FLAME_THRESHOLD, COLD_THRESHOLD } from "./streaks";
import { deleteMatchChannels, clearPendingSeriesState } from "./matchChannels";
import { cleanupTestMatchRows } from "./testMatch";
import { getRankLabel } from "@/lib/leaderboard/rankIcon";
import { encodeMatchId } from "./matchId";
import { interactionUserId, interactionDisplayName, type DiscordInteraction } from "./types";
import { SERIES_LENGTH_LABELS, REPORT_COOLDOWN_MINUTES_BY_LENGTH } from "./teamFormation";
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

  // Report cooldown — see CLAUDE.md, "Reporting & disputes". Blocks a report right after teams
  // are formed, to prevent a false/premature report; teams_formed_at is stamped once, in
  // teamFormation.ts's finalizeTeams, regardless of which path (balanced/captains) got there. The
  // wait itself scales with series length (REPORT_COOLDOWN_MINUTES_BY_LENGTH) — a null
  // series_length (series_length_vote_enabled off) falls back to the bo3 value.
  if (series.teams_formed_at && (await getConfigNumber("report_cooldown_enabled", 1)) === 1) {
    const cooldownMinutes = REPORT_COOLDOWN_MINUTES_BY_LENGTH[series.series_length ?? "bo3"];
    const elapsedMinutes = (Date.now() - new Date(series.teams_formed_at).getTime()) / 60000;
    if (elapsedMinutes < cooldownMinutes) {
      const remaining = Math.ceil(cooldownMinutes - elapsedMinutes);
      await editOriginalResponse(interaction.token, {
        content: `You can't report yet — wait ${remaining} more minute${remaining === 1 ? "" : "s"} after teams are formed to prevent false reports.`,
      });
      return;
    }
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

  // match_number is now assigned here, at the moment a series actually settles to 'reported' —
  // revised a later session, supersedes assignment at pop time (queue.ts's handlePop). Assigning
  // at pop time meant void/cancelled/timed-out series consumed a number identically to reported
  // ones, since nothing at pop time knows a series' eventual outcome — reported live as real
  // match numbers jumping e.g. #10 straight to #17 (see migration 0042_match_number_on_report.sql
  // for the full account and the one-time cleanup of already-affected rows). Test matches never
  // call this at all, so their match_number stays permanently null, same as before.
  // crl6mansqueuebot_assign_match_number is a stored function (not a plain read-nextval-then-
  // write in application code) so the nextval()-then-update stays atomic under concurrent
  // reports — same reasoning as crl6mansqueuebot_join_queue (0002_queue_system.sql).
  let matchNumber = 0;
  if (!series.is_test_data) {
    const { data: assignedMatchNumber, error: assignError } = await supabase.rpc("crl6mansqueuebot_assign_match_number", {
      p_series_id: series.id,
    });
    if (assignError) {
      console.error(`Failed to assign match_number for series ${series.id}`, assignError);
    } else if (typeof assignedMatchNumber === "number") {
      matchNumber = assignedMatchNumber;
    }
  }

  await clearPendingSeriesState(supabase, series.id);
  // The queue status message is deliberately left un-refreshed at pop time (see handlePop's
  // comment in queue.ts) — without this it keeps showing the pre-pop 6/6 roster as "currently
  // queued" for as long as it takes some unrelated future /q or /l to replace it. See
  // refreshQueueMessageAfterSettlement's own comment for why rich/hybrid modes skip this instead.
  await refreshQueueMessageAfterSettlement(supabase, series.queue_type);

  const { data: players } = await supabase
    .from("crl6mansqueuebot_players")
    .select("*")
    .in("id", allSeriesPlayers.map((sp) => sp.player_id));
  const playersById = new Map((players ?? []).map((p) => [p.id, p]));

  // Per-match MMR snapshot (see CLAUDE.md, "Match History" and migration
  // 0032_series_players_mmr_before.sql) — captures each player's mmr as it stood right before
  // this report is applied, so History's win-odds bar/badges reflect what it actually looked
  // like at match time instead of drifting with every later game. Written unconditionally
  // (rank/universal/test) since it's just a snapshot, not stat-bearing.
  await Promise.all(
    allSeriesPlayers.map((sp) =>
      supabase
        .from("crl6mansqueuebot_series_players")
        .update({ mmr_before: playersById.get(sp.player_id)!.mmr })
        .eq("series_id", series!.id)
        .eq("player_id", sp.player_id),
    ),
  );

  // Report summary is split by winning/losing team (not one flat list) — each line shows the
  // player's MMR delta and their resulting MMR/band, per CLAUDE.md's "Reporting & disputes".
  // For Rank Queue series, bands.ts's recomputeBands() runs right below against the full placed
  // pool (not just these 6 — see bands.ts's doc comment for why), so this reflects this exact
  // game's result, not a stale daily-cron snapshot. Universal Queue lines below don't touch band
  // at all (no MMR change to recompute against).
  const winnerLines: string[] = [];
  const loserLines: string[] = [];
  const pushLine = (sp: (typeof allSeriesPlayers)[number], line: string) => (sp.team === winner ? winnerLines : loserLines).push(line);
  // Populated only for Rank Queue series — see CLAUDE.md, "MMR / Elo" (streak bonus). One line
  // per player whose win streak just reached the announcement threshold, rendered as a second,
  // amber-colored embed alongside the main report summary.
  const streakAnnounceLines: string[] = [];

  // Pre-fetch all rank emoji to avoid async calls in loops. Prism is a live top-N overlay (see
  // CLAUDE.md, "Bands / ranks"), not a `players.band` value — included here so lookups can key
  // off `p.is_prism ? "Prism" : p.band` below rather than always showing the underlying band.
  const emojiByBand = new Map<string | null, string>();
  for (const band of [null, "Iron", "Garnet", "Emerald", "Sapphire", "Prism"]) {
    emojiByBand.set(band, await getRankEmoji(band));
  }

  if (series.is_test_data) {
    // Test matches (/test-rank-match, /test-universal-match) never touch real player stats,
    // even when queue_type is "rank" — see CLAUDE.md, "Flag as test data".
    for (const sp of allSeriesPlayers) {
      const p = playersById.get(sp.player_id)!;
      const emoji = emojiByBand.get(p.is_prism ? "Prism" : p.band) || "❓";
      pushLine(sp, `<@${p.discord_id}> — test match, no stat changes ${emoji}`);
    }
  } else if (series.queue_type === "rank") {
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
    // Locked in at pop time (see bonusDay.ts) — not re-evaluated against "now", which could
    // have drifted outside the bonus window by the time a match actually gets reported.
    // series_length_k_multiplier is locked in at vote-resolution time instead (see
    // teamFormation.ts) — defaults to 1 (no-op) when the series-length vote feature is off.
    const effectiveKFactor = kFactor * series.bonus_day_multiplier * series.series_length_k_multiplier;

    const eloInputs = allSeriesPlayers.map((sp) => {
      const p = playersById.get(sp.player_id)!;
      return { playerId: p.id, mmr: p.mmr, team: sp.team, priorRankGamesPlayed: p.rank_games_played };
    });
    const eloResults = computeEloDeltas(eloInputs, winner, { kFactor: effectiveKFactor, sScale, provisionalGames, provisionalKMultiplier, skewFactor, minDeltaFloor, confidenceMultiplier });
    const eloResultsById = new Map<string, EloResult>(eloResults.map((r) => [r.playerId, r]));

    // Win-streak MMR bonus (see CLAUDE.md, "MMR / Elo" — streak bonus). The settle claim above
    // already flipped this series to status='reported', so it must be excluded from each
    // player's streak lookup here or it would double-count as its own most recent result —
    // shifting both the bonus and the announcement threshold off by one game.
    const newStreakById = new Map<string, number>();
    const priorStreakById = new Map<string, number>();
    // Mirror of newStreakById for the losing side — purely cosmetic (🥶 decoration below), no
    // MMR bonus attached, so unlike the winner branch there's no prior-streak value to stash for
    // a bonus calculation, just the resulting streak length.
    const newLossStreakById = new Map<string, number>();
    await Promise.all(
      allSeriesPlayers.map(async (sp) => {
        if (sp.team !== winner) {
          newStreakById.set(sp.player_id, 0);
          const priorLossStreak = await getPriorRankLossStreak(supabase, sp.player_id, series!.id);
          newLossStreakById.set(sp.player_id, priorLossStreak + 1);
          return;
        }
        newLossStreakById.set(sp.player_id, 0);
        const priorStreak = await getPriorRankWinStreak(supabase, sp.player_id, series!.id);
        priorStreakById.set(sp.player_id, priorStreak);
        newStreakById.set(sp.player_id, priorStreak + 1);
      }),
    );

    // Folded directly into mmr_delta (not tracked as a separate column) so /admin unreport
    // unwinds it for free — it just subtracts the stored delta, which already includes the
    // bonus — with no extra bookkeeping. streakBonusEnabled gates only this arithmetic; the
    // streak itself, the announcement embed, and the fire-emoji decoration below all still run
    // when the toggle is off, per CLAUDE.md's "this just disables the extra mmr" spec.
    const resultsById = new Map<string, EloResult>(
      allSeriesPlayers.map((sp) => {
        const base = eloResultsById.get(sp.player_id)!;
        const bonus = sp.team === winner && streakBonusEnabled ? computeStreakBonus(priorStreakById.get(sp.player_id) ?? 0, base.expected) : 0;
        const result: EloResult = bonus === 0 ? base : { ...base, delta: base.delta + bonus, newMmr: base.newMmr + bonus };
        return [sp.player_id, result];
      }),
    );

    for (const sp of allSeriesPlayers) {
      const streak = newStreakById.get(sp.player_id) ?? 0;
      if (streak >= ON_FIRE_THRESHOLD) {
        const p = playersById.get(sp.player_id)!;
        streakAnnounceLines.push(`${mention(p.discord_id, { onFire: true })} is on a ${streak} game win streak!`);
      }
    }

    await Promise.all(
      allSeriesPlayers.map(async (sp) => {
        const p = playersById.get(sp.player_id)!;
        const r = resultsById.get(sp.player_id)!;
        await supabase
          .from("crl6mansqueuebot_players")
          .update({
            mmr: r.newMmr,
            // Not tracked while unranked — an unplaced player's MMR is still bouncing around
            // during placement games, not a meaningful "peak" yet. recomputeBands() below
            // initializes peak_mmr to their placement-game MMR the moment they actually place.
            peak_mmr: p.is_placed ? Math.max(p.peak_mmr, r.newMmr) : p.peak_mmr,
            total_games_played: p.total_games_played + 1,
            rank_games_played: p.rank_games_played + 1,
            band_games_played: p.band_games_played + 1,
            last_rank_game_at: new Date().toISOString(),
          })
          .eq("id", p.id);
        await supabase.from("crl6mansqueuebot_series_players").update({ mmr_delta: r.delta }).eq("series_id", series!.id).eq("player_id", p.id);
      }),
    );

    // Bands may have just changed as a direct result of this match — recompute now (the full
    // placed pool, see bands.ts's doc comment) rather than waiting for the next daily cron tick.
    // Promotion/demotion + its role-sync/DM land immediately; refetch each player's band
    // afterward so the summary embed below reflects the post-recompute value, not the
    // pre-match snapshot in playersById.
    await recomputeBands();
    const { data: refreshedBands } = await supabase
      .from("crl6mansqueuebot_players")
      .select("id, band, is_prism")
      .in("id", allSeriesPlayers.map((sp) => sp.player_id));
    for (const rb of refreshedBands ?? []) {
      const p = playersById.get(rb.id);
      if (p) {
        p.band = rb.band;
        p.is_prism = rb.is_prism;
      }
    }

    for (const sp of allSeriesPlayers) {
      const p = playersById.get(sp.player_id)!;
      const r = resultsById.get(sp.player_id)!;
      const sign = r.delta >= 0 ? "+" : "";
      const emoji = emojiByBand.get(p.is_prism ? "Prism" : p.band) || "❓";
      const displayNewMmr = await getDisplayMMR(r.newMmr);
      const displayDelta = r.delta * mmrScale;
      const onFire = (newStreakById.get(sp.player_id) ?? 0) >= FLAME_THRESHOLD;
      const cold = (newLossStreakById.get(sp.player_id) ?? 0) >= COLD_THRESHOLD;
      pushLine(
        sp,
        `${mention(p.discord_id, { onFire, cold })} — ${sign}${displayDelta.toFixed(1)} MMR → ${displayNewMmr.toFixed(1)} ${emoji}`,
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
      const emoji = emojiByBand.get(p.is_prism ? "Prism" : p.band) || "❓";
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
    const embed = reportResultEmbed(winner, matchId, winnerLines, loserLines, series.bonus_day_multiplier > 1, series.series_length);
    const embeds: Array<Record<string, unknown>> = [embed];
    if (streakAnnounceLines.length > 0) embeds.push(streakAnnouncementEmbed(streakAnnounceLines));
    await discordFetch(`/channels/${reportChannelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ embeds }),
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

// Exported for correct.ts, which reuses this exact shape to post the new report message once a
// mis-reported match is flipped via /correct's 5-of-6 player vote.
export function reportResultEmbed(
  winner: Team,
  matchId: string,
  winnerLines: string[],
  loserLines: string[],
  bonusDayActive: boolean,
  seriesLength: SeriesRow["series_length"],
) {
  const seriesLengthMarker = seriesLength ? ` · ${SERIES_LENGTH_LABELS[seriesLength]}` : "";
  return {
    color: bonusDayActive ? SUPERCHARGED_COLOR : BRAND_COLOR,
    title: `Match Reported — Team ${winner} Wins!`,
    description:
      `**Match #${matchId}**${bonusDayActive ? " 🔥 Supercharged!" : ""}${seriesLengthMarker}\n\n` +
      `**Winners**\n${winnerLines.join("\n")}\n\n` +
      `**Losers**\n${loserLines.join("\n")}\n\n` +
      `-# Wrong result? Run /correct — 5 of the 6 players can flip it.`,
  };
}

// See CLAUDE.md, "MMR / Elo" (streak bonus) — fires alongside the main report embed whenever a
// winning player's streak just reached ON_FIRE_THRESHOLD, independent of whether the MMR bonus
// itself is currently enabled.
function streakAnnouncementEmbed(lines: string[]) {
  return { color: AMBER_COLOR, description: lines.join("\n") };
}
