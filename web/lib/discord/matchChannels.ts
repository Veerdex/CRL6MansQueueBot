import "server-only";
import { discordFetch, getGuildId } from "./rest";
import { getConfigValue } from "./config";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SeriesRow } from "@/lib/supabase/types";

type AdminClient = ReturnType<typeof createAdminClient>;

// Post-match voice redirect (see CLAUDE.md, "Voice channels"): before a series' team voice
// channels are deleted, move anyone still sitting in them into the configured lobby channel
// (`lobby_voice_channel_id`, set via /setlobbychannel) rather than letting Discord drop them out
// of voice entirely when the channel disappears. Must run BEFORE the delete loop — once a channel
// is gone there is nobody left in it to move.
//
// Deliberately narrow and fail-closed: a player is moved only if their CURRENT voice channel is
// one of THIS series' own two team channels. Anyone sitting in an unrelated call, or in no call at
// all, is left exactly where they are — same scoping rule /sub's team-channel overwrite removal
// follows. Best-effort throughout: a failed lookup or move must never block the teardown.
async function moveTeamVoiceOccupantsToLobby(supabase: AdminClient, series: SeriesRow) {
  const teamChannelIds = [series.voice_channel_a_id, series.voice_channel_b_id].filter(
    (id): id is string => Boolean(id),
  );
  if (teamChannelIds.length === 0) return;

  // Unconfigured lobby = previous behavior (Discord disconnects them on channel delete).
  const lobbyChannelId = await getConfigValue("lobby_voice_channel_id");
  if (!lobbyChannelId) return;

  const { data: seriesPlayers } = await supabase
    .from("crl6mansqueuebot_series_players")
    .select("player_id")
    .eq("series_id", series.id);
  if (!seriesPlayers || seriesPlayers.length === 0) return;

  const { data: players } = await supabase
    .from("crl6mansqueuebot_players")
    .select("discord_id, is_test_data")
    .in(
      "id",
      seriesPlayers.map((sp) => sp.player_id),
    );
  if (!players || players.length === 0) return;

  const guildId = await getGuildId().catch((err) => {
    console.error(`Lobby redirect: could not resolve guild id for series ${series.id}`, err);
    return null;
  });
  if (!guildId) return;

  await Promise.all(
    players
      // Synthetic dev-panel players have no real Discord account to look up or move.
      .filter((p) => !p.is_test_data)
      .map(async (p) => {
        // Discord has no REST endpoint listing a voice channel's occupants, so each participant's
        // own voice state is checked instead. A 404 here is the normal "not connected to voice"
        // case and stays quiet; anything else (403 for a missing permission, an API change on this
        // endpoint) is logged — otherwise a broken lookup skips every player and is indistinguishable
        // from "nobody was in a team channel," with no trace in the logs.
        const state = (await discordFetch(`/guilds/${guildId}/voice-states/${p.discord_id}`).catch(
          (err: unknown) => {
            if (!String(err).includes(" 404 ")) {
              console.error(`Lobby redirect: voice-state lookup failed for ${p.discord_id}`, err);
            }
            return null;
          },
        )) as { channel_id?: string | null } | null;
        if (!state?.channel_id || !teamChannelIds.includes(state.channel_id)) return;

        await discordFetch(`/guilds/${guildId}/members/${p.discord_id}`, {
          method: "PATCH",
          body: JSON.stringify({ channel_id: lobbyChannelId }),
        }).catch((err) =>
          console.error(`Lobby redirect: failed to move ${p.discord_id} for series ${series.id}`, err),
        );
      }),
  );
}

// Deletes a series' voice channels and clears the id columns afterward — shared by /report's
// own 30s-delayed cleanup, the sweep route's timeout-void path, and /abandon's void path.
// In the redesigned architecture, text channels and per-match categories are not created.
export async function deleteMatchChannels(supabase: AdminClient, series: SeriesRow) {
  await moveTeamVoiceOccupantsToLobby(supabase, series).catch((err) =>
    console.error(`Lobby redirect failed for series ${series.id}`, err),
  );

  for (const channelId of [series.voice_channel_a_id, series.voice_channel_b_id]) {
    if (!channelId) continue;
    await discordFetch(`/channels/${channelId}`, { method: "DELETE" }).catch((err) =>
      console.error(`Failed to delete channel ${channelId} for series ${series.id}`, err),
    );
  }
  await supabase
    .from("crl6mansqueuebot_series")
    .update({ voice_channel_a_id: null, voice_channel_b_id: null })
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

// Shared by /admin cancel-series, /end, and /admin force-leave — an admin-triggered void,
// same shape as /abandon's vote-passed path and the sweep route's timeout path: atomic claim
// (so a double-fire can't double-void) + clear pending sub/abandon state. Returns false if
// the series was already settled by the time the claim ran.
export async function claimSeriesVoid(supabase: AdminClient, series: SeriesRow, _publicMessage: string): Promise<boolean> {
  const { data: claimed } = await supabase
    .from("crl6mansqueuebot_series")
    .update({ status: "void", winner_team: null })
    .eq("id", series.id)
    .in("status", ["forming", "active"])
    .select("id");
  if (!claimed || claimed.length === 0) return false;

  await clearPendingSeriesState(supabase, series.id);

  return true;
}

// Same 30s closing-warning window as /report/`/abandon` — call after the caller has already
// replied to the triggering interaction, since this blocks on the delay before deleting.
export async function closeMatchChannelsAfterDelay(supabase: AdminClient, series: SeriesRow): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  await deleteMatchChannels(supabase, series);
}
