import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags, MessageComponentTypes, ButtonStyleTypes, TextStyleTypes } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import type { MafiaGameRow, MafiaPlayerRow } from "@/lib/supabase/types";
import { discordFetch, editOriginalResponse, deleteOriginalResponse, sendFollowupMessage, BRAND_COLOR, AMBER_COLOR, GOLD_COLOR, RICH_LEAVE_COLOR } from "./rest";
import { getConfigNumber } from "./config";
import { interactionUserId, interactionDisplayName, modalFieldValue, type DiscordInteraction } from "./types";

const MAFIA_PASSWORD_MODAL_CUSTOM_ID = "password";

type AdminClient = ReturnType<typeof createAdminClient>;

const MAFIA_MAX_SIZE = 6;

function mafiaRoster(players: { discord_id: string }[]): string {
  return players.length ? players.map((p, i) => `${i + 1}. <@${p.discord_id}>`).join("\n") : "_nobody yet_";
}

function mafiaWaitingEmbed(players: { discord_id: string }[], timeoutSeconds: number, hasPassword: boolean) {
  const timeoutMinutes = Math.round(timeoutSeconds / 60);
  return {
    color: BRAND_COLOR,
    title: `🔪 Mafia — Lobby Open${hasPassword ? " 🔒" : ""}`,
    description: `Waiting for players — **${players.length}/${MAFIA_MAX_SIZE}** joined.\nClick **Join** to hop in, or **Leave** to back out.${
      hasPassword ? "\n🔒 This lobby is password-protected." : ""
    }`,
    fields: [{ name: "Players", value: mafiaRoster(players) }],
    footer: { text: `Auto-cancels if it doesn't fill within ${timeoutMinutes} minute${timeoutMinutes === 1 ? "" : "s"}.` },
  };
}

function mafiaStartingEmbed(players: { discord_id: string }[], graceSeconds: number) {
  return {
    color: AMBER_COLOR,
    title: "🔪 Mafia — Lobby Full!",
    description: `All ${MAFIA_MAX_SIZE} players have joined! Starting in **${graceSeconds}** seconds...`,
    fields: [{ name: "Players", value: mafiaRoster(players) }],
  };
}

function mafiaStartedEmbed(players: { discord_id: string }[]) {
  return {
    color: GOLD_COLOR,
    title: "🔪 Mafia — Game Started!",
    description: "Roles have been sent to each player privately. Good luck!",
    fields: [{ name: "Players", value: mafiaRoster(players) }],
  };
}

function mafiaCancelledEmbed(reason: string, players: { discord_id: string }[]) {
  return {
    color: RICH_LEAVE_COLOR,
    title: "🔪 Mafia — Cancelled",
    description: reason,
    fields: players.length ? [{ name: "Players", value: mafiaRoster(players) }] : undefined,
  };
}

function mafiaButtons(gameId: string) {
  return [
    {
      type: MessageComponentTypes.ACTION_ROW,
      components: [
        { type: MessageComponentTypes.BUTTON, style: ButtonStyleTypes.SUCCESS, label: "Join", custom_id: `mafia_join:${gameId}` },
        { type: MessageComponentTypes.BUTTON, style: ButtonStyleTypes.DANGER, label: "Leave", custom_id: `mafia_leave:${gameId}` },
      ],
    },
  ];
}

// processMafiaJoin/processMafiaLeave both run via after() scheduling, *after* their button click
// has already been synchronously acknowledged (DEFERRED_UPDATE_MESSAGE) by route.ts — Discord's
// one-shot interaction-callback endpoint only accepts one ack, so a private error from here has
// to go out via the interaction's webhook token (sendFollowupMessage), not another callback POST.
async function replyError(interaction: DiscordInteraction, content: string) {
  await sendFollowupMessage(interaction.token, { content }).catch(() => {});
}

async function fetchMafiaPlayers(supabase: AdminClient, gameId: string): Promise<MafiaPlayerRow[]> {
  const { data } = await supabase
    .from("crl6mansqueuebot_mafia_players")
    .select("*")
    .eq("game_id", gameId)
    .order("joined_at", { ascending: true });
  return data ?? [];
}

export function handleMafiaCommand(interaction: DiscordInteraction) {
  after(() => processMafiaCommand(interaction));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processMafiaCommand(interaction: DiscordInteraction) {
  const supabase = createAdminClient();
  const discordId = interactionUserId(interaction);
  const displayName = interactionDisplayName(interaction);
  const channelId = interaction.channel_id;
  const guildId = interaction.guild_id;

  if (!discordId || !channelId || !guildId) {
    await editOriginalResponse(interaction.token, { content: "Couldn't identify you or this channel — try again." });
    return;
  }

  const passwordOption = interaction.data?.options?.find((o) => o.name === "password")?.value;
  const password = typeof passwordOption === "string" && passwordOption.trim() ? passwordOption.trim() : null;

  const { data: game, error: insertError } = await supabase
    .from("crl6mansqueuebot_mafia_games")
    .insert({ channel_id: channelId, guild_id: guildId, host_discord_id: discordId, password })
    .select()
    .single();

  if (insertError || !game) {
    if (insertError?.code === "23505") {
      await editOriginalResponse(interaction.token, {
        content: "A Mafia lobby is already active in this channel — wait for it to finish or empty out first.",
      });
    } else {
      console.error("Mafia: failed to create game", insertError);
      await editOriginalResponse(interaction.token, { content: "Something went wrong starting the lobby — try again." });
    }
    return;
  }

  const { data: joinRows, error: joinError } = await supabase.rpc("crl6mansqueuebot_mafia_join", {
    p_game_id: game.id,
    p_discord_id: discordId,
    p_display_name: displayName,
    p_interaction_token: interaction.token,
  });
  if (joinError) {
    console.error("Mafia: host auto-join failed", joinError);
  }
  void joinRows;

  const timeoutSeconds = await getConfigNumber("mafia_timeout_seconds", 120);
  const players = await fetchMafiaPlayers(supabase, game.id);

  const message = (await discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ embeds: [mafiaWaitingEmbed(players, timeoutSeconds, !!game.password)], components: mafiaButtons(game.id) }),
  })) as { id: string };

  await supabase.from("crl6mansqueuebot_mafia_games").update({ message_id: message.id }).eq("id", game.id);

  await deleteOriginalResponse(interaction.token);
}

// Password-gated lobbies show a modal on Join click instead of joining immediately — the join
// RPC/state update only happens once the modal is submitted (handleMafiaJoinModalSubmit), so an
// unauthenticated click never touches crl6mansqueuebot_mafia_players at all.
export async function handleMafiaJoinButton(interaction: DiscordInteraction, gameId: string) {
  const supabase = createAdminClient();
  const { data: game } = await supabase.from("crl6mansqueuebot_mafia_games").select("status, password").eq("id", gameId).maybeSingle();

  if (game?.status === "waiting" && game.password) {
    return {
      type: InteractionResponseType.MODAL,
      data: {
        custom_id: `mafia_join_modal:${gameId}`,
        title: "Enter Lobby Password",
        components: [
          {
            type: MessageComponentTypes.ACTION_ROW,
            components: [
              {
                type: MessageComponentTypes.INPUT_TEXT,
                custom_id: MAFIA_PASSWORD_MODAL_CUSTOM_ID,
                style: TextStyleTypes.SHORT,
                label: "Password",
                required: true,
                max_length: 100,
              },
            ],
          },
        ],
      },
    };
  }

  after(() => processMafiaJoin(interaction, gameId));
  return { type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE };
}

export function handleMafiaJoinModalSubmit(interaction: DiscordInteraction, gameId: string) {
  const submittedPassword = modalFieldValue(interaction, MAFIA_PASSWORD_MODAL_CUSTOM_ID);
  after(() => processMafiaJoin(interaction, gameId, submittedPassword));
  return { type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE };
}

async function processMafiaJoin(interaction: DiscordInteraction, gameId: string, submittedPassword?: string | null) {
  const supabase = createAdminClient();
  const discordId = interactionUserId(interaction);
  const displayName = interactionDisplayName(interaction);

  if (!discordId) {
    await replyError(interaction, "Couldn't identify you — try again.");
    return;
  }

  const { data: game } = await supabase.from("crl6mansqueuebot_mafia_games").select("*").eq("id", gameId).maybeSingle();
  if (!game) {
    await replyError(interaction, "This lobby no longer exists.");
    return;
  }

  if (game.password && game.password !== (submittedPassword ?? "").trim()) {
    await replyError(interaction, "Incorrect password.");
    return;
  }

  const { data: rows, error } = await supabase.rpc("crl6mansqueuebot_mafia_join", {
    p_game_id: gameId,
    p_discord_id: discordId,
    p_display_name: displayName,
    p_interaction_token: interaction.token,
  });
  const result = rows?.[0];
  if (error || !result) {
    console.error("Mafia: join RPC failed", error);
    await replyError(interaction, "Something went wrong joining — try again.");
    return;
  }

  if (result.status === "not_open") {
    await replyError(interaction, "This lobby isn't open anymore.");
    return;
  }
  if (result.status === "already_joined") {
    await replyError(interaction, "You're already in this lobby.");
    return;
  }
  if (result.status === "full") {
    await replyError(interaction, "This lobby is already full.");
    return;
  }

  if (!game.channel_id || !game.message_id) return;

  const players = await fetchMafiaPlayers(supabase, gameId);

  if (result.player_count >= MAFIA_MAX_SIZE) {
    // The join RPC atomically flips status waiting -> starting the instant the 6th player is
    // inserted, inside the same advisory-lock transaction as the insert above — so only the one
    // join call that actually observed player_count reach 6 ever reaches this branch, with no
    // possible double-fire from a concurrent join.
    await runMafiaFinalizeSequence(supabase, game as MafiaGameRow, players);
    return;
  }

  const timeoutSeconds = await getConfigNumber("mafia_timeout_seconds", 120);
  await discordFetch(`/channels/${game.channel_id}/messages/${game.message_id}`, {
    method: "PATCH",
    body: JSON.stringify({ embeds: [mafiaWaitingEmbed(players, timeoutSeconds, !!game.password)], components: mafiaButtons(gameId) }),
  }).catch((err) => console.error("Mafia: failed to update lobby message on join", err));
}

async function runMafiaFinalizeSequence(supabase: AdminClient, game: MafiaGameRow, players: MafiaPlayerRow[]) {
  const graceSeconds = await getConfigNumber("mafia_grace_seconds", 5);

  if (game.channel_id && game.message_id) {
    await discordFetch(`/channels/${game.channel_id}/messages/${game.message_id}`, {
      method: "PATCH",
      body: JSON.stringify({ embeds: [mafiaStartingEmbed(players, graceSeconds)], components: [] }),
    }).catch((err) => console.error("Mafia: failed to post starting-countdown message", err));
  }

  await new Promise((resolve) => setTimeout(resolve, graceSeconds * 1000));

  // Defensive re-claim, mirroring the atomic-claim convention used throughout this codebase
  // (report.ts, teamFormation.ts) — extra insurance on top of the join RPC's own atomicity in
  // case this sequence is ever somehow re-entered.
  const { data: claimed } = await supabase
    .from("crl6mansqueuebot_mafia_games")
    .update({ status: "started", started_at: new Date().toISOString() })
    .eq("id", game.id)
    .eq("status", "starting")
    .select("id");
  if (!claimed || claimed.length === 0) return;

  const mafiaIndex = Math.floor(Math.random() * players.length);

  await Promise.all(
    players.map((p, i) =>
      sendFollowupMessage(p.interaction_token, {
        content:
          i === mafiaIndex
            ? "🔪 **You are the Mafia!** Blend in and don't get caught."
            : "🕵️ **You are Innocent.** Work with the group to figure out who the Mafia is!",
      }).catch((err) => console.error(`Mafia: failed to deliver role reveal to ${p.discord_id}`, err)),
    ),
  );

  if (game.channel_id && game.message_id) {
    await discordFetch(`/channels/${game.channel_id}/messages/${game.message_id}`, {
      method: "PATCH",
      body: JSON.stringify({ embeds: [mafiaStartedEmbed(players)], components: [] }),
    }).catch((err) => console.error("Mafia: failed to post game-started message", err));
  }
}

export function handleMafiaLeaveButton(interaction: DiscordInteraction, gameId: string) {
  after(() => processMafiaLeave(interaction, gameId));
  return { type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE };
}

async function processMafiaLeave(interaction: DiscordInteraction, gameId: string) {
  const supabase = createAdminClient();
  const discordId = interactionUserId(interaction);

  if (!discordId) {
    await replyError(interaction, "Couldn't identify you — try again.");
    return;
  }

  const { data: game } = await supabase.from("crl6mansqueuebot_mafia_games").select("*").eq("id", gameId).maybeSingle();
  if (!game) {
    await replyError(interaction, "This lobby no longer exists.");
    return;
  }

  const { data: rows, error } = await supabase.rpc("crl6mansqueuebot_mafia_leave", { p_game_id: gameId, p_discord_id: discordId });
  const result = rows?.[0];
  if (error || !result) {
    console.error("Mafia: leave RPC failed", error);
    await replyError(interaction, "Something went wrong leaving — try again.");
    return;
  }

  if (result.status === "not_open") {
    await replyError(interaction, "This lobby isn't open anymore.");
    return;
  }
  if (result.status === "not_joined") {
    await replyError(interaction, "You're not in this lobby.");
    return;
  }

  if (!game.channel_id || !game.message_id) return;

  if (result.player_count === 0) {
    // Lobby emptied out entirely (last player left) — close it quietly rather than leaving a
    // 0-player 'waiting' row blocking the unique-active-lobby-per-channel index for up to
    // mafia_timeout_seconds until the sweep's timeout check would otherwise catch it.
    const { data: claimed } = await supabase
      .from("crl6mansqueuebot_mafia_games")
      .update({ status: "cancelled" })
      .eq("id", gameId)
      .eq("status", "waiting")
      .select("id");
    if (claimed && claimed.length > 0) {
      await discordFetch(`/channels/${game.channel_id}/messages/${game.message_id}`, {
        method: "PATCH",
        body: JSON.stringify({ embeds: [mafiaCancelledEmbed("Everyone left — lobby cancelled.", [])], components: [] }),
      }).catch((err) => console.error("Mafia: failed to post empty-lobby cancellation", err));
    }
    return;
  }

  const players = await fetchMafiaPlayers(supabase, gameId);
  const timeoutSeconds = await getConfigNumber("mafia_timeout_seconds", 120);
  await discordFetch(`/channels/${game.channel_id}/messages/${game.message_id}`, {
    method: "PATCH",
    body: JSON.stringify({ embeds: [mafiaWaitingEmbed(players, timeoutSeconds, !!game.password)], components: mafiaButtons(gameId) }),
  }).catch((err) => console.error("Mafia: failed to update lobby message on leave", err));
}

// Called from the per-minute sweep (sweep/route.ts), both for lobbies that never filled within
// mafia_timeout_seconds (status='waiting') and, as a crash-safety backstop, for a lobby stuck
// mid-grace ('starting') well past when runMafiaFinalizeSequence should have completed — e.g.
// the invocation running it got killed mid-flight. The sweep is responsible for claiming the
// status transition atomically before calling this; this only handles the player-facing message.
export async function cancelStaleMafiaLobby(
  supabase: AdminClient,
  game: MafiaGameRow,
  reason: string = "Not enough players joined in time — lobby cancelled.",
) {
  const players = await fetchMafiaPlayers(supabase, game.id);
  if (!game.channel_id || !game.message_id) return;
  await discordFetch(`/channels/${game.channel_id}/messages/${game.message_id}`, {
    method: "PATCH",
    body: JSON.stringify({
      embeds: [mafiaCancelledEmbed(reason, players)],
      components: [],
    }),
  }).catch((err) => console.error("Mafia: failed to post lobby-timeout cancellation", err));
}
