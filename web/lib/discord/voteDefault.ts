import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import { editOriginalResponse } from "./rest";
import { getOrCreatePlayer } from "./queue";
import { interactionUserId, interactionDisplayName, type DiscordInteraction } from "./types";

// ---------------------------------------------------------------------------
// /vote-default <balanced|captains> — public, sets the caller's own personal team-
// formation preference, auto-cast on every future pop but still overridable per game via
// the vote buttons. See CLAUDE.md, "Team formation (on pop)".
// ---------------------------------------------------------------------------

export function handleVoteDefaultCommand(interaction: DiscordInteraction) {
  const choice = interaction.data?.options?.find((o) => o.name === "mode")?.value;
  after(() => processVoteDefault(interaction, choice));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processVoteDefault(interaction: DiscordInteraction, choiceRaw: string | number | boolean | undefined) {
  const discordId = interactionUserId(interaction);
  if (!discordId) {
    await editOriginalResponse(interaction.token, { content: "Couldn't identify you — try again." });
    return;
  }
  if (choiceRaw !== "balanced" && choiceRaw !== "captains" && choiceRaw !== "clear") {
    await editOriginalResponse(interaction.token, { content: "Invalid mode." });
    return;
  }

  const supabase = createAdminClient();
  const player = await getOrCreatePlayer(supabase, discordId, interactionDisplayName(interaction));

  if (choiceRaw === "clear") {
    await supabase.from("crl6mansqueuebot_players").update({ vote_default: null }).eq("id", player.id);
    await editOriginalResponse(interaction.token, { content: "Default vote cleared." });
  } else {
    await supabase.from("crl6mansqueuebot_players").update({ vote_default: choiceRaw }).eq("id", player.id);
    await editOriginalResponse(interaction.token, {
      content: `Your default team-formation vote is now **${choiceRaw === "balanced" ? "Balanced" : "Captains"}** — still overridable per game.`,
    });
  }
}
