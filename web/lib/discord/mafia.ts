import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags, MessageComponentTypes, ButtonStyleTypes, TextStyleTypes } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import type { MafiaGameMode, MafiaGameRow, MafiaPlayerRow, MafiaTeam } from "@/lib/supabase/types";
import { discordFetch, editOriginalResponse, deleteOriginalResponse, sendFollowupMessage, BRAND_COLOR, AMBER_COLOR, GOLD_COLOR, RICH_LEAVE_COLOR } from "./rest";
import { getConfigNumber } from "./config";
import { bestBalancedSplit } from "./teamFormation";
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

// Team Mafia's goals. Unlike MAFIA_OBJECTIVES these are things a team is trying to *achieve*, not
// sabotage — there is no mafia in this mode at all. Both teams are dealt one every game, so the
// list only has to be long enough to draw two distinct goals from.
export const MAFIA_TEAM_OBJECTIVES = [
  "Get 9 demos",
  "Score a team pinch",
  "Go to overtime",
  "Win by two goals",
  "Score an air team play",
] as const;

// What a team's objective and the win itself are each worth. Deliberately lopsided: the objective
// outscores the win, so a team can complete its goal, lose the match, and still finish ahead of a
// team that won without completing theirs.
const TEAM_OBJECTIVE_POINTS = 2;
const TEAM_WIN_POINTS = 1;

// The rating a lobby member with no crl6mansqueuebot_players row is balanced at. Expressed in
// *display* MMR and converted with the live mmr_scale/mmr_shift, per the spec ("default to 1100,
// not 1000") — 1000 is display-zero, i.e. raw 0, which would model a newcomer as the worst player
// in any lobby containing a single below-par regular. A player who *does* have a row uses their
// real MMR whether or not they are placed.
export const MAFIA_TEAM_FALLBACK_DISPLAY_MMR = 1100;

export function mafiaFallbackRating(scale: number, shift: number): number {
  // scale 0 would make the display transform non-invertible; raw 0 is the only sane answer, and it
  // is also what every player falls back to, so the split stays balanced rather than arbitrary.
  if (!scale) return 0;
  return (MAFIA_TEAM_FALLBACK_DISPLAY_MMR - shift) / scale;
}

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

// Two distinct goals, one per team — never the same one twice, by explicit user choice: several of
// these ("Go to overtime" especially) would otherwise be completed by both teams at once, which
// makes the objective worth nothing.
export function assignTeamObjectives(): [string, string] {
  const [blue, orange] = shuffled(MAFIA_TEAM_OBJECTIVES);
  return [blue, orange];
}

// Splits a full lobby into two MMR-balanced sides, reusing teamFormation.ts's bestBalancedSplit —
// the same brute force over all 10 unique 3v3 divisions, minimising the calculateTeamStrength gap,
// that the real six-mans Balanced vote uses. Mafia players have no players row to pass, so ratings
// come in through `ratingFor` (see mafiaFallbackRating for the no-row case).
//
// Which side gets Blue is a coin flip rather than bestBalancedSplit's teamA: its enumeration is
// `i < j < k` over the member list, so teamA always contains members[0] — without the flip the
// first player to join (the host) would be on Blue in every single game.
export function splitMafiaTeams<T extends { discord_id: string }>(
  players: T[],
  ratingFor: (discordId: string) => number,
): { blue: T[]; orange: T[] } {
  const seats = players.map((p) => ({ id: p.discord_id, mmr: ratingFor(p.discord_id), player: p }));
  const { teamA, teamB } = bestBalancedSplit(seats);
  const [first, second] = Math.random() < 0.5 ? [teamA, teamB] : [teamB, teamA];
  return { blue: first.map((s) => s.player), orange: second.map((s) => s.player) };
}

// What the lobby is told publicly once the game starts. A requested count of 0 stays deliberately
// vague: printing the resolved number would give away the coin flip and defeat the whole setting.
function mafiaCountLabel(requested: number): string {
  if (requested === 0) return "0 or 1 — nobody knows";
  return `${requested} of ${MAFIA_MAX_SIZE}`;
}

function mafiaModeLabel(mode: MafiaGameMode): string {
  if (mode === "hidden_objective") return "Hidden Objective";
  if (mode === "team_objective") return "Team Mafia";
  return "Classic";
}

const TEAM_EMOJI: Record<MafiaTeam, string> = { blue: "🔵", orange: "🟠" };
const TEAM_LABEL: Record<MafiaTeam, string> = { blue: "Blue", orange: "Orange" };

function teamRoster(players: MafiaPlayerRow[], team: MafiaTeam): string {
  const side = players.filter((p) => p.team === team);
  return side.length ? side.map((p) => `<@${p.discord_id}>`).join("\n") : "_nobody_";
}

// Every member of a team carries the same objective string, so any one of them answers for the
// side. Null when the game predates migration 0051 or the finalize-time write didn't land.
function teamObjective(players: MafiaPlayerRow[], team: MafiaTeam): string | null {
  return players.find((p) => p.team === team)?.objective ?? null;
}

const TEAM_SCORING_LINE = `Objective **${TEAM_OBJECTIVE_POINTS} pts** · Win **${TEAM_WIN_POINTS} pt**`;

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

// Team Mafia's public start message: the team assignment, and nothing else. Each player's own
// objective goes out privately alongside it, and both objectives stay secret until /reveal.
function mafiaTeamStartedEmbed(players: MafiaPlayerRow[]) {
  return {
    color: GOLD_COLOR,
    title: "🔪 Team Mafia — Game Started!",
    description: `Each team's objective has been sent privately. ${TEAM_SCORING_LINE} — complete yours and you can still come out ahead after losing.`,
    fields: [
      { name: `${TEAM_EMOJI.blue} Blue`, value: teamRoster(players, "blue"), inline: true },
      { name: `${TEAM_EMOJI.orange} Orange`, value: teamRoster(players, "orange"), inline: true },
    ],
    footer: { text: "Run /reveal once when you're done to see both objectives." },
  };
}

function mafiaStartedEmbed(players: { discord_id: string }[], mode: MafiaGameMode, requestedCount: number) {
  return {
    color: GOLD_COLOR,
    title: "🔪 Mafia — Game Started!",
    description: "Roles have been sent to each player privately. Good luck!",
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
// Team Mafia's reveal: both objectives, side by side, so the lobby can settle the score. The bot
// never learns who won or whether either goal was actually met — that stays with the players, so
// this prints the scoring rather than a result.
function mafiaTeamRevealEmbed(players: MafiaPlayerRow[]) {
  const fields = [{ name: "Mode", value: "Team Mafia", inline: false }];

  const teams: MafiaTeam[] = ["blue", "orange"];
  if (teams.every((t) => teamObjective(players, t) === null)) {
    // Same honesty as the mafia path: no objectives on file means the finalize-time write never
    // landed (migration 0051 not applied, most likely), not that the teams had nothing to do.
    fields.push({
      name: "Result",
      value: "Objective data is missing for this game — the assignments weren't recorded, so there's nothing to reveal.",
      inline: false,
    });
  } else {
    for (const team of teams) {
      fields.push({
        name: `${TEAM_EMOJI[team]} ${TEAM_LABEL[team]}`,
        value: `**${teamObjective(players, team) ?? "_not recorded_"}**\n${teamRoster(players, team)}`,
        inline: true,
      });
    }
    fields.push({ name: "Scoring", value: `${TEAM_SCORING_LINE}\nHighest total wins.`, inline: false });
  }

  return { color: GOLD_COLOR, title: "🔎 Team Mafia — Objectives Revealed", fields };
}

function mafiaRevealEmbed(game: MafiaGameRow, players: MafiaPlayerRow[]) {
  if (game.mode === "team_objective") return mafiaTeamRevealEmbed(players);

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
        .map((p) => `🔪 <@${p.discord_id}>${p.objective ? ` — _${p.objective}_` : ""}`)
        .join("\n"),
      inline: false,
    });
    // Only the mafia are named. Everyone in the lobby already knows who played, so listing the
    // innocents adds nothing the mafia list doesn't already imply.
  }

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
  const mode: MafiaGameMode =
    modeOption === "hidden_objective" || modeOption === "team_objective" ? modeOption : "classic";

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

// Every lobby member's rating for the balance, keyed by Discord id. Mafia is otherwise fully
// independent of the six-mans side, and stays so here: this is a read-only lookup, a player with
// no row simply falls back (see mafiaFallbackRating), and nothing is written back.
async function fetchTeamRatings(supabase: AdminClient, discordIds: string[]): Promise<Map<string, number>> {
  const fallback = await getConfigNumber("mmr_scale", 1).then(async (scale) =>
    mafiaFallbackRating(scale, await getConfigNumber("mmr_shift", 0)),
  );

  const { data } = await supabase
    .from("crl6mansqueuebot_players")
    .select("discord_id, mmr")
    .in("discord_id", discordIds);

  const ratings = new Map<string, number>(discordIds.map((id) => [id, fallback]));
  for (const row of data ?? []) ratings.set(row.discord_id, row.mmr);
  return ratings;
}

async function runTeamObjectiveAssignment(supabase: AdminClient, game: MafiaGameRow, players: MafiaPlayerRow[]) {
  const ratings = await fetchTeamRatings(supabase, players.map((p) => p.discord_id));
  const { blue, orange } = splitMafiaTeams(players, (id) => ratings.get(id) ?? 0);
  const [blueObjective, orangeObjective] = assignTeamObjectives();

  const assignment = new Map<string, { team: MafiaTeam; objective: string }>();
  for (const p of blue) assignment.set(p.discord_id, { team: "blue", objective: blueObjective });
  for (const p of orange) assignment.set(p.discord_id, { team: "orange", objective: orangeObjective });

  // Persisted so /reveal can print both objectives after the fact — the ephemerals below don't
  // survive the interaction. .select() so a zero-row match is visible: PostgREST reports no error
  // when an UPDATE simply matches nothing, and the private message goes out either way, so
  // without this a team could be told its objective while /reveal reports none on file.
  for (const p of players) {
    const seat = assignment.get(p.discord_id);
    if (!seat) continue;
    const { data: saved, error } = await supabase
      .from("crl6mansqueuebot_mafia_players")
      .update({ team: seat.team, objective: seat.objective })
      .eq("game_id", game.id)
      .eq("discord_id", p.discord_id)
      .select("discord_id");
    if (error || !saved?.length) {
      console.error(`Mafia: failed to persist team assignment for ${p.discord_id}`, error ?? "no matching player row");
    }
  }

  await Promise.all(
    players.map((p) => {
      const seat = assignment.get(p.discord_id);
      if (!seat) return Promise.resolve();
      const content =
        `${TEAM_EMOJI[seat.team]} **Your objective (${TEAM_LABEL[seat.team]}):** ${seat.objective}\n` +
        `${TEAM_SCORING_LINE} — keep it from ${TEAM_LABEL[seat.team === "blue" ? "orange" : "blue"]}.`;
      return sendFollowupMessage(p.interaction_token, { content }).catch((err) =>
        console.error(`Mafia: failed to deliver team objective to ${p.discord_id}`, err),
      );
    }),
  );

  if (game.channel_id && game.message_id) {
    // The rows in hand predate the UPDATE above, so carry the assignment into the copy the embed
    // renders rather than re-reading them.
    const assigned = players.map((p) => ({ ...p, team: assignment.get(p.discord_id)?.team ?? null }));
    await discordFetch(`/channels/${game.channel_id}/messages/${game.message_id}`, {
      method: "PATCH",
      body: JSON.stringify({ embeds: [mafiaTeamStartedEmbed(assigned)], components: [] }),
    }).catch((err) => console.error("Mafia: failed to post team-game-started message", err));
  }
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

  // Team Mafia has no mafia to pick and no per-player role, so it diverges completely from here:
  // two balanced teams, one shared objective each. mafia_count is ignored (and stays whatever the
  // host happened to pass, the same way it records a *request* rather than an outcome elsewhere).
  if (game.mode === "team_objective") {
    await runTeamObjectiveAssignment(supabase, game, players);
    return;
  }

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
    // simply matches nothing, and the DM goes out either way (it uses the cached interaction
    // token), so without this a player could be privately told they're the mafia while /reveal
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
      return sendFollowupMessage(p.interaction_token, { content }).catch((err) =>
        console.error(`Mafia: failed to deliver role reveal to ${p.discord_id}`, err),
      );
    }),
  );

  if (game.channel_id && game.message_id) {
    await discordFetch(`/channels/${game.channel_id}/messages/${game.message_id}`, {
      method: "PATCH",
      body: JSON.stringify({ embeds: [mafiaStartedEmbed(players, game.mode, game.mafia_count)], components: [] }),
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

  await deleteOriginalResponse(interaction.token);
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
