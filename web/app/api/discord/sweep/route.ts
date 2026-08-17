import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { discordFetch, sendDirectMessage, GOLD_COLOR } from "@/lib/discord/rest";
import { getConfigNumber, getConfigValue, deleteConfigValue } from "@/lib/discord/config";
import { deleteMatchChannels, clearPendingSeriesState } from "@/lib/discord/matchChannels";
import { postTrackedQueueMessage, refreshQueueMessage, fetchQueueMembers, getQueueMessageMode } from "@/lib/discord/queue";
import { performSeasonReset } from "@/lib/discord/seasons";
import { SCHEDULED_RESET_CONFIG_KEY } from "@/lib/discord/scheduledReset";
import { cancelStaleMafiaLobby } from "@/lib/discord/mafia";
import { resolveSeriesLengthByMajority } from "@/lib/discord/teamFormation";
import { advanceMatchTimeStatsDayCounters } from "@/lib/discord/bonusDay";
import type { SeriesRow } from "@/lib/supabase/types";

// Called on a schedule by Supabase pg_cron (see CLAUDE.md, "Discord bot runtime
// architecture") since there's no interaction to hang background timeout checks off of.
// Guarded by a shared secret rather than Discord signature verification — this isn't a
// Discord interaction, pg_net is the caller.
export async function POST(request: Request) {
  const secret = process.env.CRON_SWEEP_SECRET;
  if (!secret) {
    throw new Error("Missing CRON_SWEEP_SECRET");
  }
  if (request.headers.get("x-sweep-secret") !== secret) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const supabase = createAdminClient();

  const voteTimeoutSeconds = await getConfigNumber("vote_timeout_seconds", 180);
  const voteCutoff = new Date(Date.now() - voteTimeoutSeconds * 1000).toISOString();

  // Series-length vote (BO3/5/7) timeout, checked before the Balanced/Captains vote below since
  // it's the earlier phase when series_length_vote_enabled is on — resolves by majority (never
  // voids) via resolveSeriesLengthByMajority, which also hands off into the Balanced/Captains
  // vote the same way a click-resolved series-length vote does. series_length_vote_active is what
  // scopes this to series where that vote is the *currently* active phase, as opposed to a series
  // where the feature was off (never active) or already resolved (active flag cleared on
  // resolution) — see CLAUDE.md, "Team formation (on pop)".
  const { data: pendingSeriesLength, error: seriesLengthError } = await supabase
    .from("crl6mansqueuebot_series")
    .select("*")
    .eq("status", "forming")
    .eq("series_length_vote_active", true)
    .lt("vote_started_at", voteCutoff);

  if (seriesLengthError) {
    console.error("Sweep: failed to fetch pending series-length votes", seriesLengthError);
  }

  let seriesLengthResolved = 0;
  for (const series of pendingSeriesLength ?? []) {
    try {
      await resolveSeriesLengthByMajority(supabase, series);
      seriesLengthResolved += 1;
    } catch (err) {
      console.error(`Sweep: failed to resolve series-length vote for ${series.id}`, err);
    }
  }

  // Vote silence: nobody voted at all within vote_timeout_seconds -> cancel outright rather
  // than defaulting to a mode. Checked separately (and first) since it's a much shorter
  // window than the general series timeout below, and only applies pre-resolution (a series
  // where the draft is mid-progress already has >=3 votes, so it's naturally excluded here
  // and left to the general timeout instead). See CLAUDE.md, "Team formation, in the match
  // channel". Scoped to `series_length_vote_active = false` so this doesn't race the
  // series-length vote timeout above for a series still on that earlier phase — vote_started_at
  // reflects whichever phase is actually current, not the original pop time, so the
  // Balanced/Captains vote always gets its own full window once it actually begins.
  const { data: silentSeries, error: silentError } = await supabase
    .from("crl6mansqueuebot_series")
    .select("*")
    .eq("status", "forming")
    .is("vote_result", null)
    .eq("series_length_vote_active", false)
    .lt("vote_started_at", voteCutoff);

  if (silentError) {
    console.error("Sweep: failed to fetch vote-silent series", silentError);
  }

  let voidedForSilence = 0;
  for (const series of silentSeries ?? []) {
    const { count } = await supabase
      .from("crl6mansqueuebot_series_votes")
      .select("player_id", { count: "exact", head: true })
      .eq("series_id", series.id);
    if (!count) {
      await voidStaleSeries(supabase, series, "Nobody voted for a team formation mode in time — the series has been cancelled, no MMR change.");
      voidedForSilence += 1;
    }
  }

  const timeoutHours = await getConfigNumber("series_timeout_hours", 2);
  const cutoff = new Date(Date.now() - timeoutHours * 60 * 60 * 1000).toISOString();

  const { data: stale, error } = await supabase
    .from("crl6mansqueuebot_series")
    .select("*")
    .in("status", ["forming", "active"])
    .lt("created_at", cutoff);

  if (error) {
    console.error("Sweep: failed to fetch stale series", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  let voided = 0;
  for (const series of stale ?? []) {
    await voidStaleSeries(supabase, series, "Your series timed out with no report and has been cancelled — no MMR change. An admin can help re-queue if needed.");
    voided += 1;
  }

  // Backstop for reported series: report.ts deletes match channels itself after a 30s
  // closing-warning delay via `after()`, but that's a single in-function attempt with no
  // retry — if the invocation gets cut short in prod, the channels would otherwise orphan
  // forever, since a 'reported' series is outside every other sweep query above. Only sweep
  // series reported over a minute ago so this never races the in-flight deletion.
  const reportedCutoff = new Date(Date.now() - 60 * 1000).toISOString();
  const { data: orphanCandidates, error: orphanError } = await supabase
    .from("crl6mansqueuebot_series")
    .select("*")
    .eq("status", "reported")
    .lt("reported_at", reportedCutoff)
    // queue_channel_id deliberately excluded — it's the shared rank/universal queue channel,
    // always populated and never cleared, not a per-match resource deleteMatchChannels cleans
    // up. Including it here would re-match (and no-op re-sweep) every reported series forever.
    .or("category_id.not.is.null,voice_channel_a_id.not.is.null,voice_channel_b_id.not.is.null");

  if (orphanError) {
    console.error("Sweep: failed to fetch orphaned reported-series channels", orphanError);
  }

  let orphansCleaned = 0;
  for (const series of orphanCandidates ?? []) {
    await deleteMatchChannels(supabase, series);
    orphansCleaned += 1;
  }

  // Queue member timeout: auto-remove players who've been queued too long without a pop.
  // Configurable per-queue-type via `queue_member_timeout_minutes` (default 30).
  const queueTimeoutMinutes = await getConfigNumber("queue_member_timeout_minutes", 30);
  const queueCutoff = new Date(Date.now() - queueTimeoutMinutes * 60 * 1000).toISOString();

  const queueTypes = ["rank" as const, "universal" as const];
  let queueMembersRemoved = 0;

  for (const queueType of queueTypes) {
    const { data: staleMembers, error: queueError } = await supabase
      .from("crl6mansqueuebot_queue_members")
      .select("player_id")
      .eq("queue_type", queueType)
      .lt("joined_at", queueCutoff);

    if (queueError) {
      console.error(`Sweep: failed to fetch stale queue members for ${queueType}`, queueError);
      continue;
    }

    if (!staleMembers || staleMembers.length === 0) continue;

    const playerIds = staleMembers.map((m) => m.player_id);
    const { data: players } = await supabase
      .from("crl6mansqueuebot_players")
      .select("*")
      .in("id", playerIds);

    const { data: deleted } = await supabase
      .from("crl6mansqueuebot_queue_members")
      .delete()
      .eq("queue_type", queueType)
      .in("player_id", playerIds)
      .select("player_id");

    if (deleted && deleted.length > 0) {
      queueMembersRemoved += deleted.length;
      const queueLabel = queueType === "rank" ? "Rank Queue" : "Universal Queue";

      // Send DMs to all removed players
      await Promise.all(
        (players ?? []).map((p) =>
          sendDirectMessage(
            p.discord_id,
            `You've been auto-removed from the ${queueLabel} after ${queueTimeoutMinutes} minutes without a match. You can rejoin anytime.`,
          ),
        ),
      );

      const mode = await getQueueMessageMode();

      if (mode === "rich") {
        // Rich mode gets exactly one message per inactive player — a copy of the leave card's
        // shape with inactivity-specific wording/color, instead of a roster refresh plus a
        // separate plain-orange embed. Sequential (not Promise.all) so each player's refresh
        // doesn't CAS-retry against the same single tracked-message row concurrently. See
        // CLAUDE.md, "Queue channels".
        for (const p of players ?? []) {
          const queueSize = (await fetchQueueMembers(supabase, queueType)).length;
          await refreshQueueMessage(supabase, queueType, undefined, undefined, {
            action: "inactive",
            player: p,
            queueSize,
          });
        }
        continue;
      }

      // Update the queue display message
      await refreshQueueMessage(supabase, queueType);

      // Post an inactivity embed for each removed player to the queue channel
      const { data: msgRow } = await supabase
        .from("crl6mansqueuebot_queue_messages")
        .select("channel_id")
        .eq("queue_type", queueType)
        .maybeSingle();

      if (msgRow?.channel_id) {
        await Promise.all(
          (players ?? []).map((p) =>
            postTrackedQueueMessage(
              supabase,
              msgRow.channel_id,
              {
                color: 0xFFA500, // Orange
                description: `<@${p.discord_id}> has been removed from the queue because of inactivity.`,
              },
              "error",
              true,
            ),
          ),
        );
      }
    }
  }

  // Pending /sub nominations expire on their own timer (sub_request_timeout_minutes) rather
  // than riding the series timeout — a stale nomination shouldn't hang around for up to 2
  // hours just because nobody clicked Accept. See CLAUDE.md, "Substitutes".
  const subTimeoutMinutes = await getConfigNumber("sub_request_timeout_minutes", 10);
  const subCutoff = new Date(Date.now() - subTimeoutMinutes * 60 * 1000).toISOString();

  const { data: staleSubRequests, error: subError } = await supabase
    .from("crl6mansqueuebot_sub_requests")
    .select("*")
    .lt("created_at", subCutoff);

  if (subError) {
    console.error("Sweep: failed to fetch stale sub requests", subError);
  }

  let subRequestsExpired = 0;
  for (const request of staleSubRequests ?? []) {
    // Atomic claim (existence = pending, same convention as sub.ts's accept handler) so this
    // can't race a player clicking Accept in the same tick.
    const { data: claimed } = await supabase
      .from("crl6mansqueuebot_sub_requests")
      .delete()
      .eq("series_id", request.series_id)
      .eq("leaving_player_id", request.leaving_player_id)
      .select("series_id");
    if (!claimed || claimed.length === 0) continue;

    if (request.message_id) {
      const { data: series } = await supabase.from("crl6mansqueuebot_series").select("queue_channel_id").eq("id", request.series_id).maybeSingle();
      if (series?.queue_channel_id) {
        await discordFetch(`/channels/${series.queue_channel_id}/messages/${request.message_id}`, {
          method: "PATCH",
          body: JSON.stringify({
            content: `Sub request to <@${request.nominee_discord_id}> expired without a response.`,
            components: [],
          }),
        }).catch((err) => console.error(`Sweep: failed to update expired sub request message for series ${request.series_id}`, err));
      }
    }
    subRequestsExpired += 1;
  }

  // Mafia lobby timeout (/mafia — see CLAUDE.md, "Mafia"): a lobby that never fills within
  // mafia_timeout_seconds auto-cancels. Only ever targets status='waiting' — a lobby mid-grace
  // ('starting') is handled entirely in-process by the join call that triggered it, never here.
  const mafiaTimeoutSeconds = await getConfigNumber("mafia_timeout_seconds", 120);
  const mafiaCutoff = new Date(Date.now() - mafiaTimeoutSeconds * 1000).toISOString();

  const { data: staleMafiaLobbies, error: mafiaError } = await supabase
    .from("crl6mansqueuebot_mafia_games")
    .select("*")
    .eq("status", "waiting")
    .lt("created_at", mafiaCutoff);

  if (mafiaError) {
    console.error("Sweep: failed to fetch stale mafia lobbies", mafiaError);
  }

  let mafiaLobbiesCancelled = 0;
  for (const game of staleMafiaLobbies ?? []) {
    const { data: claimed } = await supabase
      .from("crl6mansqueuebot_mafia_games")
      .update({ status: "cancelled" })
      .eq("id", game.id)
      .eq("status", "waiting")
      .select("id");
    if (!claimed || claimed.length === 0) continue;
    await cancelStaleMafiaLobby(supabase, game);
    mafiaLobbiesCancelled += 1;
  }

  // Crash-safety backstop: a lobby stuck in 'starting' well past when the 5-second grace +
  // finalize sequence should ever take (e.g. the invocation running runMafiaFinalizeSequence
  // got killed mid-flight) would otherwise block its channel's unique-active-lobby index
  // forever with no player-facing recourse — mirrors this route's orphaned-voice-channel
  // backstop elsewhere in this file.
  const mafiaStartingCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: stuckStartingLobbies } = await supabase
    .from("crl6mansqueuebot_mafia_games")
    .select("*")
    .eq("status", "starting")
    .lt("created_at", mafiaStartingCutoff);

  for (const game of stuckStartingLobbies ?? []) {
    const { data: claimed } = await supabase
      .from("crl6mansqueuebot_mafia_games")
      .update({ status: "cancelled" })
      .eq("id", game.id)
      .eq("status", "starting")
      .select("id");
    if (!claimed || claimed.length === 0) continue;
    await cancelStaleMafiaLobby(supabase, game, "Something went wrong starting the game — lobby cancelled.");
    mafiaLobbiesCancelled += 1;
  }

  // Scheduled season reset (/schedule-reset — see CLAUDE.md, "Seasons"): scheduled_season_reset_at
  // is a plain ISO timestamp in the generic config table. Delete it BEFORE running the reset
  // (not after) so a slow performSeasonReset() that overruns into the next minute's sweep tick
  // can't fire twice — the same "claim first, then act" ordering used everywhere else in this
  // route, just via delete-the-key instead of an atomic status UPDATE, since there's no series
  // row here to claim against.
  let scheduledResetFired = false;
  const scheduledResetAt = await getConfigValue(SCHEDULED_RESET_CONFIG_KEY);
  if (scheduledResetAt && new Date(scheduledResetAt).getTime() <= Date.now()) {
    await deleteConfigValue(SCHEDULED_RESET_CONFIG_KEY);
    try {
      const summary = await performSeasonReset();
      scheduledResetFired = true;

      // No real Discord actor to attribute this to — bypasses logAdminAction (which always
      // renders an `Actor: <@id>` field) in favor of a dedicated announcement embed, but still
      // records a raw audit_log row for traceability. actor_discord_id is NOT NULL with no
      // "system" sentinel convention elsewhere in the schema; "system" here renders as a
      // harmless unresolved <@system> mention in /admin audit-log's plain-text listing only
      // (not a live notification).
      await supabase.from("crl6mansqueuebot_audit_log").insert({
        actor_discord_id: "system",
        action: "scheduled_reset_fire",
        details: summary.closedSeasonNumber
          ? `Closed season ${summary.closedSeasonNumber}, started season ${summary.newSeasonNumber}, ${summary.playersReset} player(s) reset to Unranked`
          : `Started season ${summary.newSeasonNumber} (no prior active season)`,
      });

      const logChannelId = await getConfigValue("log_channel_id");
      if (logChannelId) {
        await discordFetch(`/channels/${logChannelId}/messages`, {
          method: "POST",
          body: JSON.stringify({
            embeds: [
              {
                color: GOLD_COLOR,
                title: "Scheduled Season Reset",
                description: summary.closedSeasonNumber
                  ? `Closed season ${summary.closedSeasonNumber} and started season ${summary.newSeasonNumber}. ${summary.playersReset} player(s) reset to Unranked.`
                  : `Started season ${summary.newSeasonNumber} (no prior active season).`,
              },
            ],
          }),
        }).catch((err) => console.error("Sweep: failed to post scheduled-reset announcement embed", err));
      }
    } catch (err) {
      console.error("Sweep: scheduled season reset failed", err);
    }
  }

  // Match Times' supercharged/non-supercharged day counters (see CLAUDE.md, "Match time
  // stats") — advances once per Pacific calendar day, classifying that day against the bonus
  // config as of right now rather than recomputing every past day's classification on every page
  // load. Best-effort/non-fatal, same as every other block in this route.
  let matchTimeStatsDaysAdvanced = 0;
  try {
    matchTimeStatsDaysAdvanced = await advanceMatchTimeStatsDayCounters(new Date());
  } catch (err) {
    console.error("Sweep: failed to advance match-time-stats day counters", err);
  }

  return NextResponse.json({
    ok: true,
    voided,
    voidedForSilence,
    seriesLengthResolved,
    orphansCleaned,
    queueMembersRemoved,
    subRequestsExpired,
    mafiaLobbiesCancelled,
    scheduledResetFired,
    matchTimeStatsDaysAdvanced,
  });
}

async function voidStaleSeries(supabase: ReturnType<typeof createAdminClient>, series: SeriesRow, message: string) {
  const { error } = await supabase
    .from("crl6mansqueuebot_series")
    .update({ status: "void" })
    .eq("id", series.id)
    .in("status", ["forming", "active"]);
  if (error) {
    console.error(`Sweep: failed to void series ${series.id}`, error);
    return;
  }

  // Post timeout embed to the queue channel
  if (series.queue_channel_id) {
    await postTrackedQueueMessage(
      supabase,
      series.queue_channel_id,
      {
        color: 0xef476f,
        description: message,
      },
      "timeout",
      true,
    );
  }

  await clearPendingSeriesState(supabase, series.id);
  // Same staleness fix as /cancel, /abandon, /report — the queue status message is left
  // un-refreshed at pop time, so it keeps showing the pre-pop roster as "currently queued"
  // through however the series ends unless something explicitly refreshes it afterward.
  await refreshQueueMessage(supabase, series.queue_type);
  await deleteMatchChannels(supabase, series);
}
