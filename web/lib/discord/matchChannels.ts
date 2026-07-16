import "server-only";
import { discordFetch } from "./rest";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SeriesRow } from "@/lib/supabase/types";

type AdminClient = ReturnType<typeof createAdminClient>;

// Deletes a series' match category + text/voice channels and clears the id columns
// afterward — shared by /report's own 30s-delayed cleanup, the sweep route's timeout-void
// path, the sweep route's reported-series backstop, and /abandon's void path. Nulling the
// columns after a successful delete matters: without it, the sweep backstop (which matches
// on non-null channel ids) would keep re-attempting deletes against channels that are
// already gone, forever, on every sweep tick.
export async function deleteMatchChannels(supabase: AdminClient, series: SeriesRow) {
  for (const channelId of [
    series.voice_channel_a_id,
    series.voice_channel_b_id,
    series.text_channel_id,
    series.category_id,
  ]) {
    if (!channelId) continue;
    await discordFetch(`/channels/${channelId}`, { method: "DELETE" }).catch((err) =>
      console.error(`Failed to delete channel ${channelId} for series ${series.id}`, err),
    );
  }
  await supabase
    .from("crl6mansqueuebot_series")
    .update({ category_id: null, text_channel_id: null, voice_channel_a_id: null, voice_channel_b_id: null })
    .eq("id", series.id);
}

// Clears any pending /sub nominations and /abandon votes for a series once it leaves
// 'forming'/'active' (reported, void, or cancelled) — those rows would otherwise dangle
// forever, since neither table cascades off anything but the series row itself, which never
// gets deleted on settlement (only its status changes).
export async function clearPendingSeriesState(supabase: AdminClient, seriesId: string) {
  await supabase.from("crl6mansqueuebot_sub_requests").delete().eq("series_id", seriesId);
  await supabase.from("crl6mansqueuebot_abandon_votes").delete().eq("series_id", seriesId);
}

// Shared by /admin cancel-series, /end, and /admin force-leave (Phase 8) — an admin-triggered
// void, same shape as /abandon's vote-passed path and the sweep route's timeout path: atomic
// claim (so a double-fire can't double-void) + clear pending sub/abandon state + post a public
// closing message. Split from the delayed channel deletion (closeMatchChannelsAfterDelay)
// rather than one combined function, so callers can reply to the admin's interaction right
// after the claim succeeds instead of blocking the ephemeral response on the 30s warning —
// same ordering /report and /abandon already use. Returns false if the series was already
// settled by the time the claim ran.
export async function claimSeriesVoid(supabase: AdminClient, series: SeriesRow, publicMessage: string): Promise<boolean> {
  const { data: claimed } = await supabase
    .from("crl6mansqueuebot_series")
    .update({ status: "void", winner_team: null })
    .eq("id", series.id)
    .in("status", ["forming", "active"])
    .select("id");
  if (!claimed || claimed.length === 0) return false;

  await clearPendingSeriesState(supabase, series.id);

  if (series.text_channel_id) {
    await discordFetch(`/channels/${series.text_channel_id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: `${publicMessage}\n\nThis channel will close in 30 seconds.` }),
    }).catch((err) => console.error(`Failed to post cancellation message for series ${series.id}`, err));
  }

  return true;
}

// Same 30s closing-warning window as /report/`/abandon` — call after the caller has already
// replied to the triggering interaction, since this blocks on the delay before deleting.
export async function closeMatchChannelsAfterDelay(supabase: AdminClient, series: SeriesRow): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  await deleteMatchChannels(supabase, series);
}
