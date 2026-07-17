import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PlayerRow, QueueType } from "@/lib/supabase/types";
import { editOriginalResponse } from "./rest";
import { hasAdminAccess, logAdminAction } from "./admin";
import { interactionUserId, interactionDisplayName, type DiscordInteraction } from "./types";
import { getOrCreatePlayer, isPlayerLockedInActiveSeries, createMatchChannels } from "./queue";
import { castVote } from "./teamFormation";
import { deleteMatchChannels } from "./matchChannels";

type AdminClient = ReturnType<typeof createAdminClient>;

const QUEUE_LABELS: Record<QueueType, string> = { rank: "Rank Queue", universal: "Universal Queue" };

// ---------------------------------------------------------------------------
// /test-rank-match, /test-universal-match, /end-test — admin-only commands that spin up a
// simulated 6-player match (the admin + 5 synthetic "test bot" players) so an admin can try the
// real team-formation/report flow without needing 5 other Discord users to queue up with them.
// See CLAUDE.md's "Open items" — no dedicated section exists yet for this feature.
//
// Fake players get real, numeric-snowflake-shaped discord_ids (Discord's permission-overwrite
// API rejects non-numeric ids) and is_test_data=true, matching the dev panel's convention so
// they're excluded from bands/season-close/leaderboard pools. Any draft pick or vote that would
// require a fake player to click a real Discord button is auto-resolved instead — see
// autoAdvanceDraftIfFake in teamFormation.ts and the auto-cast votes below.
// ---------------------------------------------------------------------------

function deferredEphemeral(run: () => Promise<void>) {
  after(run);
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

export function handleTestMatchCommand(interaction: DiscordInteraction, queueType: QueueType) {
  return deferredEphemeral(() => processTestMatch(interaction, queueType));
}

function fakeDiscordId(index: number): string {
  return `9${Date.now()}${index}`;
}

async function createFakePlayers(supabase: AdminClient, adminPlayer: PlayerRow): Promise<PlayerRow[]> {
  const rows = [50, 100, 150, 200, 250].map((offset, i) => ({
    discord_id: fakeDiscordId(i),
    display_name: `Test Bot ${i + 1}`,
    mmr: adminPlayer.mmr - offset,
    is_test_data: true,
  }));
  const { data, error } = await supabase.from("crl6mansqueuebot_players").insert(rows).select("*");
  if (error || !data) throw new Error(`Failed to create fake test players: ${error?.message}`);
  return data;
}

async function processTestMatch(interaction: DiscordInteraction, queueType: QueueType) {
  if (!(await hasAdminAccess(interaction))) {
    await editOriginalResponse(interaction.token, { content: "You don't have admin access." });
    return;
  }
  const discordId = interactionUserId(interaction);
  if (!discordId || !interaction.guild_id) {
    await editOriginalResponse(interaction.token, { content: "Couldn't identify you — try again." });
    return;
  }

  const supabase = createAdminClient();
  const adminPlayer = await getOrCreatePlayer(supabase, discordId, interactionDisplayName(interaction));

  if (await isPlayerLockedInActiveSeries(supabase, adminPlayer.id)) {
    await editOriginalResponse(interaction.token, {
      content: "You're already locked into an active series (real or test) — finish it, /report it, or run /end-test in its channel first.",
    });
    return;
  }

  const { data: season } = await supabase.from("crl6mansqueuebot_seasons").select("id").eq("is_active", true).maybeSingle();
  if (!season) {
    await editOriginalResponse(interaction.token, { content: "No active season — run /newseason first." });
    return;
  }

  const fakePlayers = await createFakePlayers(supabase, adminPlayer);
  const members = [adminPlayer, ...fakePlayers];

  // Uses the command channel as the "queue channel" for this test series, same as handlePop
  // does with the real queue channel — see CLAUDE.md's queue_channel_id migration note.
  const { data: series, error: seriesError } = await supabase
    .from("crl6mansqueuebot_series")
    .insert({ season_id: season.id, queue_type: queueType, status: "forming", is_test_data: true, queue_channel_id: interaction.channel_id ?? null })
    .select("id")
    .single();
  if (seriesError || !series) {
    await editOriginalResponse(interaction.token, { content: "Failed to create the test series." });
    await supabase
      .from("crl6mansqueuebot_players")
      .delete()
      .in("id", fakePlayers.map((p) => p.id));
    return;
  }

  await supabase.from("crl6mansqueuebot_series_lobby").insert(members.map((m) => ({ series_id: series.id, player_id: m.id })));

  // For test matches, use the command channel as the "queue channel" for voting UI
  const channelId = interaction.channel_id || "";
  await createMatchChannels(supabase, series.id, interaction.guild_id, members, channelId);

  // Auto-cast 4 of 5 fake votes (2 Balanced, 2 Captains) — deliberately leaves the vote at 2-2
  // so the admin's own click through the real button decides the outcome, exercising both the
  // vote UI and whichever team-formation path they pick.
  const { data: seriesRow } = await supabase.from("crl6mansqueuebot_series").select("*").eq("id", series.id).maybeSingle();
  if (seriesRow?.queue_channel_id && seriesRow.formation_message_id) {
    const voteChoices: ("balanced" | "captains")[] = ["balanced", "balanced", "captains", "captains"];
    for (let i = 0; i < voteChoices.length; i++) {
      await castVote(
        supabase,
        interaction.guild_id,
        series.id,
        seriesRow.queue_channel_id,
        seriesRow.formation_message_id,
        members,
        fakePlayers[i].id,
        voteChoices[i],
      );
    }
  }

  await logAdminAction(discordId, "test_match_start", series.id, `queue_type=${queueType}`);
  await editOriginalResponse(interaction.token, {
    content: `Test ${QUEUE_LABELS[queueType]} match created — head to the new match channel. Vote is 2-2 (Balanced/Captains); your click decides it. Run /end-test in that channel when you're done.`,
  });
}

// Deletes a test series' row (cascades to series_lobby/series_players/series_votes/
// sub_requests/abandon_votes — all FK `on delete cascade`, see the migrations) and the fake
// players that were part of it. Scoped strictly to this one series' membership, never a blanket
// `is_test_data = true` delete — that would also wipe the /dev panel's unrelated synthetic
// leaderboard data. Called both by /end-test and, for a test series that gets reported for real
// rather than aborted, by report.ts after its own channel cleanup.
export async function cleanupTestMatchRows(supabase: AdminClient, seriesId: string) {
  const [{ data: lobbyRows }, { data: seriesPlayerRows }] = await Promise.all([
    supabase.from("crl6mansqueuebot_series_lobby").select("player_id").eq("series_id", seriesId),
    supabase.from("crl6mansqueuebot_series_players").select("player_id").eq("series_id", seriesId),
  ]);
  const memberIds = [...new Set([...(lobbyRows ?? []).map((r) => r.player_id), ...(seriesPlayerRows ?? []).map((r) => r.player_id)])];

  let fakePlayerIds: string[] = [];
  if (memberIds.length > 0) {
    const { data: fakePlayers } = await supabase
      .from("crl6mansqueuebot_players")
      .select("id")
      .in("id", memberIds)
      .eq("is_test_data", true);
    fakePlayerIds = (fakePlayers ?? []).map((p) => p.id);
  }

  await supabase.from("crl6mansqueuebot_series").delete().eq("id", seriesId);
  if (fakePlayerIds.length > 0) {
    await supabase.from("crl6mansqueuebot_players").delete().in("id", fakePlayerIds);
  }
}

export function handleEndTestCommand(interaction: DiscordInteraction) {
  return deferredEphemeral(() => processEndTest(interaction));
}

async function processEndTest(interaction: DiscordInteraction) {
  if (!(await hasAdminAccess(interaction))) {
    await editOriginalResponse(interaction.token, { content: "You don't have admin access." });
    return;
  }
  const discordId = interactionUserId(interaction);
  if (!discordId || !interaction.channel_id) {
    await editOriginalResponse(interaction.token, { content: "Run this inside the test match's channel." });
    return;
  }

  const supabase = createAdminClient();
  const { data: series } = await supabase
    .from("crl6mansqueuebot_series")
    .select("*")
    .eq("queue_channel_id", interaction.channel_id)
    .eq("is_test_data", true)
    .in("status", ["forming", "active"])
    .maybeSingle();
  if (!series) {
    await editOriginalResponse(interaction.token, { content: "This isn't an active test match channel." });
    return;
  }

  await editOriginalResponse(interaction.token, { content: "Test match cleaned up." });
  await deleteMatchChannels(supabase, series);
  await cleanupTestMatchRows(supabase, series.id);
  await logAdminAction(discordId, "end_test_match", series.id);
}
