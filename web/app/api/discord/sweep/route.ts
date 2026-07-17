import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { discordFetch, sendDirectMessage } from "@/lib/discord/rest";
import { getConfigNumber } from "@/lib/discord/config";
import { deleteMatchChannels, clearPendingSeriesState } from "@/lib/discord/matchChannels";
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

  // Vote silence: nobody voted at all within vote_timeout_seconds -> cancel outright rather
  // than defaulting to a mode. Checked separately (and first) since it's a much shorter
  // window than the general series timeout below, and only applies pre-resolution (a series
  // where the draft is mid-progress already has >=3 votes, so it's naturally excluded here
  // and left to the general timeout instead). See CLAUDE.md, "Team formation, in the match
  // channel".
  const voteTimeoutSeconds = await getConfigNumber("vote_timeout_seconds", 180);
  const voteCutoff = new Date(Date.now() - voteTimeoutSeconds * 1000).toISOString();

  const { data: silentSeries, error: silentError } = await supabase
    .from("crl6mansqueuebot_series")
    .select("*")
    .eq("status", "forming")
    .is("vote_result", null)
    .lt("created_at", voteCutoff);

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
      .select("id, discord_id")
      .in("id", playerIds);

    const { data: deleted } = await supabase
      .from("crl6mansqueuebot_queue_members")
      .delete()
      .eq("queue_type", queueType)
      .in("player_id", playerIds)
      .select("player_id");

    if (deleted) {
      queueMembersRemoved += deleted.length;
      const queueLabel = queueType === "rank" ? "Rank Queue" : "Universal Queue";
      await Promise.all(
        (players ?? []).map((p) =>
          sendDirectMessage(
            p.discord_id,
            `You've been auto-removed from the ${queueLabel} after ${queueTimeoutMinutes} minutes without a match. You can rejoin anytime.`,
          ),
        ),
      );
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

  return NextResponse.json({ ok: true, voided, voidedForSilence, orphansCleaned, queueMembersRemoved, subRequestsExpired });
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

  // Post message to the queue channel
  if (series.queue_channel_id) {
    await discordFetch(`/channels/${series.queue_channel_id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: message }),
    }).catch((err) => console.error(`Failed to post series void message to queue channel`, err));
  }

  await clearPendingSeriesState(supabase, series.id);
  await deleteMatchChannels(supabase, series);
}
