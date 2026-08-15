import { NextResponse } from "next/server";
import { after } from "next/server";
import { InteractionType, InteractionResponseType } from "discord-interactions";
import { verifyDiscordRequest } from "@/lib/discord/verify";
import { getConfigNumber, getConfigValue } from "@/lib/discord/config";
import { discordFetch } from "@/lib/discord/rest";
import type { DiscordInteraction } from "@/lib/discord/types";
import { handleQueueJoinCommand, handleQueueLeaveCommand, handleStatusCommand, handleSetQueueChannelCommand, handleSet6mansCallCategoryCommand, handleSetReportChannelCommand, handleSetLogChannelCommand, handleSetLobbyChannelCommand, handleSetQueueMentionRoleCommand } from "@/lib/discord/queue";
import { handleSetNotificationChannelCommand, handleSetNotificationRoleCommand, handleNotificationButton } from "@/lib/discord/notifications";
import {
  handleAddAdminRoleCommand,
  handleRemoveAdminRoleCommand,
  handleListAdminRolesCommand,
  handleHelpCommand,
  handleSetMentionRoleCommand,
  handleSiteCommand,
} from "@/lib/discord/adminCommands";
import { handleNewSeasonCommand } from "@/lib/discord/seasons";
import { handleScheduleResetCommand } from "@/lib/discord/scheduledReset";
import { handleVoteDefaultCommand } from "@/lib/discord/voteDefault";
import { handleReportCommand } from "@/lib/discord/report";
import { handleSubCommand, handleNominateCommand, handleSubAcceptButton } from "@/lib/discord/sub";
import { handleAbandonCommand } from "@/lib/discord/abandon";
import { handleVoteButton, handleDraftPickButton, handleDraftPickMultiButton, handleCancelCommand, handleSeriesLengthVoteButton } from "@/lib/discord/teamFormation";
import type { VoteChoice, SeriesLength } from "@/lib/supabase/types";
import { handleSetBandRoleCommand, handleRanksCommand } from "@/lib/discord/bands";
import { handleChancesCommand } from "@/lib/discord/chances";
import { handleProfileCommand } from "@/lib/discord/profile";
import { handleAdminCommand } from "@/lib/discord/adminTools";
import { handleTestMatchCommand, handleEndTestCommand } from "@/lib/discord/testMatch";
import { handleMafiaCommand, handleMafiaJoinButton, handleMafiaJoinModalSubmit, handleMafiaLeaveButton } from "@/lib/discord/mafia";

// /report posts a public result message, then sleeps 30s before deleting the match channels
// (see CLAUDE.md, "Series end") — comfortably inside this, but well past the ~10s a plain
// serverless invocation would allow.
export const maxDuration = 60;

// Discord's HTTP Interactions endpoint. Every slash command / button click for this bot
// arrives here as a POST — see CLAUDE.md, "Discord bot runtime architecture" for why this
// project uses the webhook model instead of a persistent gateway connection.
// TEMPORARY DIAGNOSTIC helper — see the call sites in POST below. Best-effort and fully
// swallowed: this must never affect the interaction response it's reporting on. No-ops when no
// log channel is configured. Runs inside after(), so it can't add latency to the response.
async function postInteractionDebug(line: string) {
  try {
    const channelId = await getConfigValue("log_channel_id");
    if (!channelId) return;
    await discordFetch(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: `\`[interaction] ${line}\``.slice(0, 1900) }),
    });
  } catch {
    // ignore — diagnostics must never break or delay a real interaction
  }
}

// TEMPORARY DIAGNOSTIC — /test-button. A minimal reproduction for the "The application did not
// respond" button failure, deliberately sharing nothing with the real handlers: no Supabase, no
// after(), no background work at all, just an immediate response. The two buttons differ in
// exactly one variable — the interaction response type:
//
//   "now"   -> type 4 (CHANNEL_MESSAGE_WITH_SOURCE), replies with a visible ephemeral message
//   "defer" -> type 6 (DEFERRED_UPDATE_MESSAGE), the same ack every real button uses
//
// Reading the result: if "now" works and "defer" fails, Discord is rejecting our type-6 acks and
// the fix is to change how buttons acknowledge. If BOTH fail, the problem is upstream of every
// handler (endpoint config, deployment, or the path between Discord and Vercel) and no amount of
// handler-level work will help. If both work, the failure is specific to what the real handlers
// do *after* acking. Remove this once resolved.
function testButtonMessage() {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: "Button diagnostic — click each one and note which (if either) errors.",
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 1, label: "Immediate reply (type 4)", custom_id: "debugbtn:now" },
            { type: 2, style: 2, label: "Deferred ack (type 6)", custom_id: "debugbtn:defer" },
          ],
        },
      ],
    },
  };
}

export async function POST(request: Request) {
  const verified = await verifyDiscordRequest(request);
  if (!verified.valid) {
    return new NextResponse("Invalid request signature", { status: 401 });
  }

  const interaction = JSON.parse(verified.body) as DiscordInteraction;
  const receivedAt = Date.now();

  // TEMPORARY DIAGNOSTIC — mirrors the console.log diagnostics into the configured log channel
  // (/setlogchannel) so they're readable without digging through Vercel's log UI. Logged on
  // arrival for *every* interaction type, which is what makes "button clicks never reach us"
  // distinguishable from "they reach us and we answer with something Discord rejects": if
  // slash commands produce a line and button clicks produce nothing, the request never arrived.
  // Remove this (and the RESPONSE line below) once the button-interaction issue is resolved.
  after(() =>
    postInteractionDebug(
      `IN type=${interaction.type} name=${interaction.data?.name ?? "-"} custom_id=${interaction.data?.custom_id ?? "-"}`,
    ),
  );

  // Discord's handshake when (re-)registering the endpoint URL — must reply PONG with no
  // other side effects, and quickly, or the URL registration in the dev portal fails.
  if (interaction.type === InteractionType.PING) {
    return NextResponse.json({ type: InteractionResponseType.PONG });
  }

  // Check if bot is paused (unless it's an admin command)
  const commandName = interaction.data?.name;
  const isBotPaused = await getConfigNumber("bot_paused", 0);
  const isAdminCommand = commandName === "admin";
  if (isBotPaused && !isAdminCommand) {
    return NextResponse.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "The bot is currently paused for maintenance. Please try again later.", flags: 64 },
    });
  }

  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    const customId = interaction.data?.custom_id ?? "";
    const [action, arg1, arg2] = customId.split(":");

    // Diagnostic logging for the "button click -> The application did not respond" report: the
    // function was returning 200 with no error, so the failure had to be in *what* we send back
    // (or how long we take), neither of which was visible anywhere. Logs the exact serialized
    // response body and the elapsed time, so a malformed/empty body or a slow path shows up
    // directly in the Vercel log instead of having to be inferred.
    const respond = (payload: unknown) => {
      const line = `RESPONSE custom_id=${customId || "-"} body=${JSON.stringify(payload)} ms=${Date.now() - receivedAt}`;
      console.log(`[interaction] component ${line}`);
      after(() => postInteractionDebug(line));
      return NextResponse.json(payload);
    };

    // TEMPORARY DIAGNOSTIC — see testButtonMessage above. Checked first and returns directly so
    // it shares no code path with the real handlers.
    if (action === "debugbtn") {
      if (arg1 === "now") {
        return respond({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "✅ Immediate reply (type 4) worked.", flags: 64 },
        });
      }
      return respond({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
    }

    if (action === "sub_accept" && arg1 && arg2) {
      return respond(handleSubAcceptButton(interaction, arg1, arg2));
    }

    if (action === "vote" && arg1 && (arg2 === "balanced" || arg2 === "captains")) {
      return respond(handleVoteButton(interaction, arg1, arg2 as VoteChoice));
    }

    if (action === "series_length_vote" && arg1 && (arg2 === "bo3" || arg2 === "bo5" || arg2 === "bo7")) {
      return respond(handleSeriesLengthVoteButton(interaction, arg1, arg2 as SeriesLength));
    }

    if (action === "draft_pick" && arg1 && arg2) {
      return respond(handleDraftPickButton(interaction, arg1, arg2));
    }

    if (action === "draft_pick_multi" && arg1) {
      return respond(handleDraftPickMultiButton(interaction, arg1, interaction.data?.values ?? []));
    }

    if (action === "notification" && (arg1 === "rank" || arg1 === "universal")) {
      return respond(handleNotificationButton(interaction, arg1));
    }

    if (action === "mafia_join" && arg1) {
      return respond(await handleMafiaJoinButton(interaction, arg1));
    }

    if (action === "mafia_leave" && arg1) {
      return respond(handleMafiaLeaveButton(interaction, arg1));
    }

    return respond({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Unrecognized action.", flags: 64 },
    });
  }

  if (interaction.type === InteractionType.MODAL_SUBMIT) {
    const customId = interaction.data?.custom_id ?? "";
    const [action, arg1] = customId.split(":");

    if (action === "mafia_join_modal" && arg1) {
      return NextResponse.json(handleMafiaJoinModalSubmit(interaction, arg1));
    }

    return NextResponse.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Unrecognized submission.", flags: 64 },
    });
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const commandName = interaction.data?.name;

    if (commandName === "setqueuechannel") {
      return NextResponse.json(handleSetQueueChannelCommand(interaction));
    }

    if (commandName === "set6manscallcategory") {
      return NextResponse.json(handleSet6mansCallCategoryCommand(interaction));
    }

    if (commandName === "setreportchannel") {
      return NextResponse.json(handleSetReportChannelCommand(interaction));
    }

    if (commandName === "setlogchannel") {
      return NextResponse.json(handleSetLogChannelCommand(interaction));
    }

    if (commandName === "setlobbychannel") {
      return NextResponse.json(handleSetLobbyChannelCommand(interaction));
    }

    if (commandName === "setqueuementionrole") {
      return NextResponse.json(handleSetQueueMentionRoleCommand(interaction));
    }

    if (commandName === "setnotificationchannel") {
      return NextResponse.json(handleSetNotificationChannelCommand(interaction));
    }

    if (commandName === "setnotificationrole") {
      return NextResponse.json(handleSetNotificationRoleCommand(interaction));
    }

    if (commandName === "q" || commandName === "queue") {
      return NextResponse.json(handleQueueJoinCommand(interaction));
    }

    if (commandName === "l" || commandName === "leave") {
      return NextResponse.json(handleQueueLeaveCommand(interaction));
    }

    if (commandName === "status") {
      return NextResponse.json(handleStatusCommand(interaction));
    }

    if (commandName === "ranks") {
      return NextResponse.json(handleRanksCommand(interaction));
    }

    if (commandName === "chances") {
      return NextResponse.json(handleChancesCommand(interaction));
    }

    if (commandName === "profile") {
      return NextResponse.json(handleProfileCommand(interaction));
    }

    if (commandName === "add-admin-role") {
      return NextResponse.json(handleAddAdminRoleCommand(interaction));
    }

    if (commandName === "remove-admin-role") {
      return NextResponse.json(handleRemoveAdminRoleCommand(interaction));
    }

    if (commandName === "list-admin-roles") {
      return NextResponse.json(handleListAdminRolesCommand(interaction));
    }

    if (commandName === "help") {
      return NextResponse.json(handleHelpCommand(interaction));
    }

    if (commandName === "site") {
      return NextResponse.json(handleSiteCommand(interaction));
    }

    // TEMPORARY DIAGNOSTIC — see testButtonMessage above.
    if (commandName === "test-button") {
      return NextResponse.json(testButtonMessage());
    }

    if (commandName === "newseason") {
      return NextResponse.json(handleNewSeasonCommand(interaction));
    }

    if (commandName === "schedule-reset") {
      return NextResponse.json(handleScheduleResetCommand(interaction));
    }

    if (commandName === "vote-default") {
      return NextResponse.json(handleVoteDefaultCommand(interaction));
    }

    if (commandName === "report" || commandName === "r") {
      return NextResponse.json(handleReportCommand(interaction));
    }

    if (commandName === "sub") {
      return NextResponse.json(handleSubCommand(interaction));
    }

    if (commandName === "nominate") {
      return NextResponse.json(handleNominateCommand(interaction));
    }

    if (commandName === "abandon") {
      return NextResponse.json(handleAbandonCommand(interaction));
    }

    if (commandName === "cancel") {
      return NextResponse.json(handleCancelCommand(interaction));
    }

    if (commandName === "setbandrole") {
      return NextResponse.json(handleSetBandRoleCommand(interaction));
    }

    if (commandName === "setmentionrole") {
      return NextResponse.json(handleSetMentionRoleCommand(interaction));
    }

    if (commandName === "admin") {
      return NextResponse.json(handleAdminCommand(interaction));
    }

    if (commandName === "test-rank-match") {
      return NextResponse.json(handleTestMatchCommand(interaction, "rank"));
    }

    if (commandName === "test-universal-match") {
      return NextResponse.json(handleTestMatchCommand(interaction, "universal"));
    }

    if (commandName === "end-test") {
      return NextResponse.json(handleEndTestCommand(interaction));
    }

    if (commandName === "mafia") {
      return NextResponse.json(handleMafiaCommand(interaction));
    }

    return NextResponse.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Unrecognized command.", flags: 64 },
    });
  }

  return new NextResponse("Unhandled interaction type", { status: 400 });
}
