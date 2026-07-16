import { NextResponse } from "next/server";
import { InteractionType, InteractionResponseType } from "discord-interactions";
import { verifyDiscordRequest } from "@/lib/discord/verify";
import type { DiscordInteraction } from "@/lib/discord/types";
import { handleQueueButton, handleSetQueueChannelCommand } from "@/lib/discord/queue";
import {
  handleAddAdminRoleCommand,
  handleRemoveAdminRoleCommand,
  handleListAdminRolesCommand,
  handleHelpCommand,
} from "@/lib/discord/adminCommands";
import { handleNewSeasonCommand } from "@/lib/discord/seasons";
import { handleVoteDefaultCommand } from "@/lib/discord/voteDefault";
import { handleVoteButton, handleDraftPickButton } from "@/lib/discord/teamFormation";
import { handleReportCommand } from "@/lib/discord/report";
import { handleSubCommand, handleSubAcceptButton } from "@/lib/discord/sub";
import { handleAbandonCommand } from "@/lib/discord/abandon";
import { handleSetBandRoleCommand } from "@/lib/discord/bands";
import { handleAdminCommand, handleEndCommand } from "@/lib/discord/adminTools";
import type { QueueType, VoteChoice } from "@/lib/supabase/types";

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

  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    const customId = interaction.data?.custom_id ?? "";
    const [action, arg1, arg2] = customId.split(":");
    const queueType = arg1 as QueueType | undefined;

    if ((action === "queue_join" || action === "queue_leave") && (queueType === "rank" || queueType === "universal")) {
      return NextResponse.json(handleQueueButton(interaction, action === "queue_join" ? "join" : "leave", queueType));
    }

    if (action === "vote" && arg1 && (arg2 === "balanced" || arg2 === "captains")) {
      return NextResponse.json(handleVoteButton(interaction, arg1, arg2 as VoteChoice));
    }

    if (action === "draft_pick" && arg1 && arg2) {
      return NextResponse.json(handleDraftPickButton(interaction, arg1, arg2));
    }

    if (action === "sub_accept" && arg1 && arg2) {
      return NextResponse.json(handleSubAcceptButton(interaction, arg1, arg2));
    }

    return NextResponse.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Unrecognized action.", flags: 64 },
    });
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const commandName = interaction.data?.name;

    if (commandName === "setqueuechannel") {
      return NextResponse.json(handleSetQueueChannelCommand(interaction));
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

    if (commandName === "newseason") {
      return NextResponse.json(handleNewSeasonCommand(interaction));
    }

    if (commandName === "vote-default") {
      return NextResponse.json(handleVoteDefaultCommand(interaction));
    }

    if (commandName === "report") {
      return NextResponse.json(handleReportCommand(interaction));
    }

    if (commandName === "sub") {
      return NextResponse.json(handleSubCommand(interaction));
    }

    if (commandName === "abandon") {
      return NextResponse.json(handleAbandonCommand(interaction));
    }

    if (commandName === "setbandrole") {
      return NextResponse.json(handleSetBandRoleCommand(interaction));
    }

    if (commandName === "admin") {
      return NextResponse.json(handleAdminCommand(interaction));
    }

    if (commandName === "end") {
      return NextResponse.json(handleEndCommand(interaction));
    }

    return NextResponse.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Unrecognized command.", flags: 64 },
    });
  }

  return new NextResponse("Unhandled interaction type", { status: 400 });
}
