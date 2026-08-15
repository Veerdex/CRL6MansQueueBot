import { NextResponse } from "next/server";
import { InteractionType, InteractionResponseType } from "discord-interactions";
import { verifyDiscordRequest } from "@/lib/discord/verify";
import { getConfigNumber } from "@/lib/discord/config";
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
export async function POST(request: Request) {
  const verified = await verifyDiscordRequest(request);
  if (!verified.valid) {
    return new NextResponse("Invalid request signature", { status: 401 });
  }

  const interaction = JSON.parse(verified.body) as DiscordInteraction;

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

    if (action === "sub_accept" && arg1 && arg2) {
      return NextResponse.json(handleSubAcceptButton(interaction, arg1, arg2));
    }

    if (action === "vote" && arg1 && (arg2 === "balanced" || arg2 === "captains")) {
      return NextResponse.json(handleVoteButton(interaction, arg1, arg2 as VoteChoice));
    }

    if (action === "series_length_vote" && arg1 && (arg2 === "bo3" || arg2 === "bo5" || arg2 === "bo7")) {
      return NextResponse.json(handleSeriesLengthVoteButton(interaction, arg1, arg2 as SeriesLength));
    }

    if (action === "draft_pick" && arg1 && arg2) {
      return NextResponse.json(handleDraftPickButton(interaction, arg1, arg2));
    }

    if (action === "draft_pick_multi" && arg1) {
      return NextResponse.json(handleDraftPickMultiButton(interaction, arg1, interaction.data?.values ?? []));
    }

    if (action === "notification" && (arg1 === "rank" || arg1 === "universal")) {
      return NextResponse.json(handleNotificationButton(interaction, arg1));
    }

    if (action === "mafia_join" && arg1) {
      return NextResponse.json(await handleMafiaJoinButton(interaction, arg1));
    }

    if (action === "mafia_leave" && arg1) {
      return NextResponse.json(handleMafiaLeaveButton(interaction, arg1));
    }

    return NextResponse.json({
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
