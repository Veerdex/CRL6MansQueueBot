import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags, MessageComponentTypes, ButtonStyleTypes, TextStyleTypes } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import type { MafiaGameMode, MafiaGameRow, MafiaPlayerRow } from "@/lib/supabase/types";
import { discordFetch, editOriginalResponse, deleteOriginalResponse, sendFollowupMessage, sendDirectMessage, BRAND_COLOR, AMBER_COLOR, GOLD_COLOR, RICH_LEAVE_COLOR } from "./rest";
import { getConfigNumber } from "./config";
import { interactionUserId, interactionDisplayName, modalFieldValue, type DiscordInteraction } from "./types";

const MAFIA_PASSWORD_MODAL_CUSTOM_ID = "password";

type AdminClient = ReturnType<typeof createAdminClient>;

const MAFIA_MAX_SIZE = 6;

// Hidden Objective mode's sabotage goals. A fixed list rather than a config row: CLAUDE.md sends
// admin-tunable runtime behaviour to the config table "unless the design explicitly defines a
// constant", and these six were specified exactly.
//
// There is now exactly one objective per lobby seat, so even an all-mafia game deals six distinct
// goals — the list was deliberately padded to six for that reason, replacing an earlier five-item
// version where a 6-mafia game had to repeat one.
export const MAFIA_OBJECTIVES = [
  "Lowest points on your team",
  "Can't score",
  "Minimum of 5 demos",
  "Own goal",
  "Lose the game",
  "Go to Overtime",
] as const;

function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// The host's requested count is 0-6, but 0 is a special case rather than a literal zero: it means
// "coin flip between one mafia and none", so nobody — the host included — knows whether there is
// actually a mafia in play. Resolved here, at finalize time, and never written back to the game
// row, which keeps recording the request.
export function resolveMafiaCount(requested: number): number {
  if (requested === 0) return Math.random() < 0.5 ? 1 : 0;
  return Math.min(Math.max(requested, 0), MAFIA_MAX_SIZE);
}

// One objective per mafia, dealt without replacement so no two ever share a goal. resolveMafiaCount
// clamps to MAFIA_MAX_SIZE and the deck is that same length, so the deck can no longer run out —
// the repeat-draw fallback this used to need is gone with the sixth objective.
export function assignObjectives(count: number): string[] {
  return shuffled(MAFIA_OBJECTIVES).slice(0, count);
}

// What the lobby is told publicly once the game starts. A requested count of 0 stays deliberately
// vague: printing the resolved number would give away the coin flip and defeat the whole setting.
function mafiaCountLabel(requested: number): string {
  if (requested === 0) return "0 or 1 — nobody knows";
  return `${requested} of ${MAFIA_MAX_SIZE}`;
}

function mafiaModeLabel(mode: MafiaGameMode): string {
  return mode === "hidden_objective" ? "Hidden Objective" : "Classic";
}

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

function mafiaStartedEmbed(players: { discord_id: string }[], mode: MafiaGameMode, requestedCount: number) {
  return {
    color: GOLD_COLOR,
    title: "🔪 Mafia — Game Started!",
    description: "Roles have been sent to each player by DM — check your messages. Good luck!\nThink you know who it is? Hit **Make your guess** below — you can change it until `/reveal`.",
    fields: [
      { name: "Mode", value: mafiaModeLabel(mode), inline: true },
      { name: "Mafia", value: mafiaCountLabel(requestedCount), inline: true },
      { name: "Players", value: mafiaRoster(players) },
    ],
    footer: { text: "Run /reveal once when you're done to see who the Mafia was." },
  };
}

// Posted publicly by /reveal — the whole lobby finding out together is the point, so this is a
// channel message rather than an ephemeral reply to whoever ran the command.
function mafiaRevealEmbed(game: MafiaGameRow, players: MafiaPlayerRow[]) {
  const mafia = players.filter((p) => p.is_mafia);
  const fields = [{ name: "Mode", value: mafiaModeLabel(game.mode), inline: true }];

  if (!mafia.length && game.mafia_count === 0) {
    // The coin flip landed on "none" — worth spelling out, since otherwise an empty mafia list
    // reads like something went wrong.
    fields.push({ name: "Result", value: "**Nobody was the Mafia.** Everyone was innocent all along.", inline: false });
  } else if (!mafia.length) {
    // The host asked for at least one mafia, so an empty list means the finalize-time write never
    // landed (migration 0050 not applied, most likely) rather than an innocent lobby. Saying so is
    // the honest answer — asserting innocence here would be a lie.
    fields.push({
      name: "Result",
      value: "Role data is missing for this game — the assignments weren't recorded, so there's nothing to reveal.",
      inline: false,
    });
  } else {
    fields.push({
      name: mafia.length === 1 ? "The Mafia" : `The Mafia (${mafia.length})`,
      value: mafia
        .map((p) => {
          const namedBy = players.filter((v) => v.discord_id !== p.discord_id && v.guess?.includes(p.discord_id)).length;
          return `🔪 <@${p.discord_id}>${p.objective ? ` — _${p.objective}_` : ""} · named by ${namedBy}/${players.length - 1}`;
        })
        .join("\n"),
      inline: false,
    });
    // Only the mafia are named. Everyone in the lobby already knows who played, so listing the
    // innocents adds nothing the mafia list doesn't already imply.
  }

  // Skipped when role data is missing (the branch above): every guess would read ❌ against an
  // empty mafia list that isn't the real answer.
  const mafiaIds = new Set(mafia.map((p) => p.discord_id));
  if (mafia.length || game.mafia_count === 0) fields.push({ name: "Guesses", value: players.map((p) => mafiaGuessLine(p, mafiaIds)).join("\n"), inline: false });

  return { color: GOLD_COLOR, title: "🔎 Mafia — Revealed", fields };
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

function mafiaGuessButton(gameId: string) {
  return [
    {
      type: MessageComponentTypes.ACTION_ROW,
      components: [
        { type: MessageComponentTypes.BUTTON, style: ButtonStyleTypes.PRIMARY, label: "Make your guess", emoji: { name: "🔎" }, custom_id: `mafia_guess:${gameId}` },
      ],
    },
  ];
}

// The private picker a player gets from "Make your guess": a multi-select of everyone but
// themselves (any number, so it works for every mafia count), plus a "No Mafia" button only in a
// 0-or-1 coin-flip lobby — anywhere else the host asked for at least one mafia, so "nobody" is
// publicly known to be wrong. A select can't be submitted empty, which is why "No Mafia" is a
// separate button rather than an empty selection.
export function mafiaGuessComponents(gameId: string, players: MafiaPlayerRow[], voterId: string, requestedCount: number) {
  const suspects = players.filter((p) => p.discord_id !== voterId);
  const rows: unknown[] = [
    {
      type: MessageComponentTypes.ACTION_ROW,
      components: [
        {
          type: MessageComponentTypes.STRING_SELECT,
          custom_id: `mafia_guess_pick:${gameId}`,
          placeholder: "Pick who you think the Mafia is",
          min_values: 1,
          max_values: suspects.length,
          options: suspects.map((p) => ({ label: p.display_name.slice(0, 100), value: p.discord_id })),
        },
      ],
    },
  ];
  if (requestedCount === 0) {
    rows.push({
      type: MessageComponentTypes.ACTION_ROW,
      components: [
        { type: MessageComponentTypes.BUTTON, style: ButtonStyleTypes.SECONDARY, label: "No Mafia", custom_id: `mafia_guess_none:${gameId}` },
      ],
    });
  }
  return rows;
}

function describeGuess(guess: string[] | null): string {
  if (guess === null) return "_no guess yet_";
  if (guess.length === 0) return "**No Mafia**";
  return guess.map((id) => `<@${id}>`).join(", ");
}

// One /reveal line per player: their picks, each marked ✅ (was mafia) or ❌ (wasn't). A "No Mafia"
// guess is ✅ only when nobody drew mafia.
export function mafiaGuessLine(player: MafiaPlayerRow, mafiaIds: Set<string>): string {
  const guess = player.guess;
  let picks: string;
  if (guess === null) picks = "_no guess_";
  else if (guess.length === 0) picks = `No Mafia ${mafiaIds.size === 0 ? "✅" : "❌"}`;
  else picks = guess.map((id) => `<@${id}> ${mafiaIds.has(id) ? "✅" : "❌"}`).join(", ");
  return `<@${player.discord_id}> → ${picks}`;
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

  const modeOption = interaction.data?.options?.find((o) => o.name === "mode")?.value;
  const mode: MafiaGameMode = modeOption === "hidden_objective" ? "hidden_objective" : "classic";

  // Discord enforces the 0-6 range via min_value/max_value on the option, but the clamp keeps the
  // column's check constraint from being the thing that rejects a malformed payload.
  const countOption = interaction.data?.options?.find((o) => o.name === "count")?.value;
  const mafiaCount =
    typeof countOption === "number" ? Math.min(Math.max(Math.trunc(countOption), 0), MAFIA_MAX_SIZE) : 1;

  const { data: game, error: insertError } = await supabase
    .from("crl6mansqueuebot_mafia_games")
    .insert({ channel_id: channelId, guild_id: guildId, host_discord_id: discordId, password, mode, mafia_count: mafiaCount })
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

// Roles go out by DM. A player with DMs closed falls back to an ephemeral followup on the join
// click's cached interaction token (well inside its 15-minute window, since the lobby times out
// long before that), so nobody is left without a role.
async function deliverRole(player: MafiaPlayerRow, content: string) {
  if (await sendDirectMessage(player.discord_id, content)) return;
  await sendFollowupMessage(player.interaction_token, { content }).catch((err) =>
    console.error(`Mafia: failed to deliver role reveal to ${player.discord_id}`, err),
  );
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

  const mafiaTotal = resolveMafiaCount(game.mafia_count);
  const objectives = game.mode === "hidden_objective" ? assignObjectives(mafiaTotal) : [];

  // Shuffle the seats, then take the first N — picking N distinct indices out of a shuffle rather
  // than sampling repeatedly, so the same player can never be drawn twice.
  const mafiaIds = new Set(shuffled(players).slice(0, mafiaTotal).map((p) => p.discord_id));

  // Persisted so /reveal can name them afterwards — nothing about the assignment survived the
  // interaction before this. Only the mafia rows are written: the join RPC already inserts every
  // player as non-mafia with a null objective, which is exactly the innocent case.
  const objectiveFor = new Map<string, string | null>();
  let dealt = 0;
  for (const p of players) {
    if (!mafiaIds.has(p.discord_id)) continue;
    const objective = objectives[dealt++] ?? null;
    objectiveFor.set(p.discord_id, objective);
    // .select() so a zero-row match is visible: PostgREST reports no error when an UPDATE's WHERE
    // simply matches nothing, and the DM goes out either way, so without this a player could be privately told they're the mafia while /reveal
    // publicly reports nobody was.
    const { data: saved, error } = await supabase
      .from("crl6mansqueuebot_mafia_players")
      .update({ is_mafia: true, objective })
      .eq("game_id", game.id)
      .eq("discord_id", p.discord_id)
      .select("discord_id");
    if (error || !saved?.length) {
      console.error(`Mafia: failed to persist role for ${p.discord_id}`, error ?? "no matching player row");
    }
  }

  await Promise.all(
    players.map((p) => {
      const objective = objectiveFor.get(p.discord_id);
      let content: string;
      if (!mafiaIds.has(p.discord_id)) {
        content = "🕵️ **You are Innocent.** Work with the group to figure out who the Mafia is!";
      } else if (objective) {
        content = `🔪 **You are the Mafia!** Your hidden objective: **${objective}**\nPull it off without the others working out it was you.`;
      } else {
        content = "🔪 **You are the Mafia!** Blend in and don't get caught.";
      }
      content += "\n\nLock in your guess with **Make your guess** on the game message in the channel.";
      return deliverRole(p, content);
    }),
  );

  if (game.channel_id && game.message_id) {
    await discordFetch(`/channels/${game.channel_id}/messages/${game.message_id}`, {
      method: "PATCH",
      body: JSON.stringify({ embeds: [mafiaStartedEmbed(players, game.mode, game.mafia_count)], components: mafiaGuessButton(game.id) }),
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

export function handleRevealCommand(interaction: DiscordInteraction) {
  after(() => processReveal(interaction));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

// Reveals the most recently *started* game in this channel. Deliberately not restricted to the
// newest game of any status: a lobby that filled and then had a fresh one opened alongside it
// shouldn't make the finished game unrevealable. **One reveal per game** — revealed_at doubles as
// the record and the atomic claim, exactly as series_length does for the series-length vote, so
// two people running /reveal at once still only post once. The reveal is public, so anyone who
// missed it can scroll to the original message.
async function processReveal(interaction: DiscordInteraction) {
  const supabase = createAdminClient();
  const discordId = interactionUserId(interaction);
  const channelId = interaction.channel_id;

  if (!discordId || !channelId) {
    await editOriginalResponse(interaction.token, { content: "Couldn't identify you or this channel — try again." });
    return;
  }

  const { data: game } = await supabase
    .from("crl6mansqueuebot_mafia_games")
    .select("*")
    .eq("channel_id", channelId)
    .eq("status", "started")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!game) {
    await editOriginalResponse(interaction.token, {
      content: "No Mafia game has been played in this channel yet — nothing to reveal.",
    });
    return;
  }

  const players = await fetchMafiaPlayers(supabase, game.id);
  if (!players.some((p) => p.discord_id === discordId)) {
    await editOriginalResponse(interaction.token, {
      content: "Only the players from that game can reveal it.",
    });
    return;
  }

  // Claim before posting, not after: the same "atomic claim, then act" ordering every settlement
  // path in this codebase uses. A second /reveal — or a simultaneous one from another player —
  // finds revealed_at already set and never reaches the POST.
  const { data: claimed } = await supabase
    .from("crl6mansqueuebot_mafia_games")
    .update({ revealed_at: new Date().toISOString() })
    .eq("id", game.id)
    .is("revealed_at", null)
    .select("id");

  if (!claimed || claimed.length === 0) {
    await editOriginalResponse(interaction.token, {
      content: "That game has already been revealed — scroll up for the results.",
    });
    return;
  }

  await discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ embeds: [mafiaRevealEmbed(game, players)] }),
  }).catch((err) => console.error("Mafia: failed to post reveal", err));

  // Guessing is over once revealed, so drop the "Make your guess" button. Late clicks on a stale
  // client are still refused by the revealed_at check in the guess handlers.
  if (game.message_id) {
    await discordFetch(`/channels/${channelId}/messages/${game.message_id}`, {
      method: "PATCH",
      body: JSON.stringify({ components: [] }),
    }).catch((err) => console.error("Mafia: failed to remove guess button", err));
  }

  await deleteOriginalResponse(interaction.token);
}

// ---------------------------------------------------------------------------
// Guessing. "Make your guess" on the Game Started message opens a private picker
// (mafiaGuessComponents); picking players or "No Mafia" saves the guess to the player's own row,
// overwriting any earlier one. Everyone in the game can guess, the mafia included — the picker
// looks identical for every role. Guesses lock once /reveal sets revealed_at.
// ---------------------------------------------------------------------------

type GuessContext = { game: MafiaGameRow; players: MafiaPlayerRow[]; voterId: string };

// Shared checks for all three guess interactions. Returns an error message for the player, or the
// loaded game.
async function loadGuessContext(supabase: AdminClient, interaction: DiscordInteraction, gameId: string): Promise<GuessContext | string> {
  const voterId = interactionUserId(interaction);
  if (!voterId) return "Couldn't identify you — try again.";

  const { data: game } = await supabase.from("crl6mansqueuebot_mafia_games").select("*").eq("id", gameId).maybeSingle();
  if (!game || game.status !== "started") return "This game isn't running.";
  if (game.revealed_at) return "This game has already been revealed — guessing is closed.";

  const players = await fetchMafiaPlayers(supabase, gameId);
  if (!players.some((p) => p.discord_id === voterId)) return "Only the players in this game can guess.";

  return { game: game as MafiaGameRow, players, voterId };
}

function guessPrompt(guess: string[] | null): string {
  return `🔎 **Who's the Mafia?**\nYour current guess: ${describeGuess(guess)}\nPick below — you can change it any time until \`/reveal\`.`;
}

export function handleMafiaGuessButton(interaction: DiscordInteraction, gameId: string) {
  after(() => processMafiaGuessButton(interaction, gameId));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function processMafiaGuessButton(interaction: DiscordInteraction, gameId: string) {
  const supabase = createAdminClient();
  const ctx = await loadGuessContext(supabase, interaction, gameId);
  if (typeof ctx === "string") {
    await editOriginalResponse(interaction.token, { content: ctx }).catch(() => {});
    return;
  }
  const me = ctx.players.find((p) => p.discord_id === ctx.voterId)!;
  await editOriginalResponse(interaction.token, {
    content: guessPrompt(me.guess),
    components: mafiaGuessComponents(gameId, ctx.players, ctx.voterId, ctx.game.mafia_count),
  }).catch((err) => console.error("Mafia: failed to show guess picker", err));
}

// Both submit paths ack with DEFERRED_UPDATE_MESSAGE, so editOriginalResponse below rewrites the
// private picker message itself with the saved guess.
export function handleMafiaGuessSubmit(interaction: DiscordInteraction, gameId: string, suspects: string[] | null) {
  after(() => processMafiaGuessSubmit(interaction, gameId, suspects ?? []));
  return { type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE };
}

async function processMafiaGuessSubmit(interaction: DiscordInteraction, gameId: string, suspects: string[]) {
  const supabase = createAdminClient();
  const ctx = await loadGuessContext(supabase, interaction, gameId);
  if (typeof ctx === "string") {
    await editOriginalResponse(interaction.token, { content: ctx, components: [] }).catch(() => {});
    return;
  }

  // Only ids of other players in this game survive — a crafted payload can't slip in yourself or
  // an outsider. "No Mafia" (empty) is only accepted in a coin-flip lobby, same as the button.
  const valid = new Set(ctx.players.filter((p) => p.discord_id !== ctx.voterId).map((p) => p.discord_id));
  const guess = [...new Set(suspects)].filter((id) => valid.has(id));
  if (guess.length === 0 && (suspects.length > 0 || ctx.game.mafia_count !== 0)) {
    await editOriginalResponse(interaction.token, { content: "That's not a valid guess — try again." }).catch(() => {});
    return;
  }

  const { error } = await supabase
    .from("crl6mansqueuebot_mafia_players")
    .update({ guess })
    .eq("game_id", gameId)
    .eq("discord_id", ctx.voterId);
  if (error) {
    console.error("Mafia: failed to save guess", error);
    await editOriginalResponse(interaction.token, { content: "Something went wrong saving your guess — try again." }).catch(() => {});
    return;
  }

  await editOriginalResponse(interaction.token, {
    content: `✅ Guess saved.\n${guessPrompt(guess)}`,
    components: mafiaGuessComponents(gameId, ctx.players, ctx.voterId, ctx.game.mafia_count),
  }).catch((err) => console.error("Mafia: failed to confirm guess", err));
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
