import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { editOriginalResponse, getRankEmoji, BRAND_COLOR } from "./rest";
import { getDisplayMMR } from "./config";
import { getRankLabel, type DisplayBand } from "@/lib/leaderboard/rankIcon";
import { getAllPlayersWithGames, type PlayerWithGames } from "@/lib/leaderboard/queries";
import { computeStats, filterGames, FLAME_THRESHOLD, COLD_THRESHOLD } from "@/lib/leaderboard/stats";
import { mention, ON_FIRE_EMOJI, COLD_EMOJI } from "./streaks";
import { interactionUserId, type DiscordInteraction } from "./types";

// ---------------------------------------------------------------------------
// /profile [target:<@user>] — public, ephemeral. Shows another player's (or, with no target:,
// your own) name, band, MMR, current Rank Queue streak, wins, losses, and live Main Leaderboard
// position. Defaults to the caller so this also covers the self-profile lookup CLAUDE.md's
// "Other user commands" already described under /rank|/profile but which was never actually
// registered/implemented — one command serves both rather than building two nearly-identical
// ones. Deliberately simple: a single embed, no interactivity, no admin gate.
// ---------------------------------------------------------------------------

export function handleProfileCommand(interaction: DiscordInteraction) {
  const targetOption = interaction.data?.options?.find((o) => o.name === "target")?.value;
  const targetDiscordId = typeof targetOption === "string" ? targetOption : null;
  after(() => processProfile(interaction, targetDiscordId));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

// Mirrors UnifiedLeaderboard.tsx's compareLeaderboardRank exactly (placed players first, then
// MMR descending, then player id as a final tiebreak) — duplicated rather than imported since
// that component is a "use client" file this server-only module can't pull in. Keep in sync if
// the Main Leaderboard's own sort ever changes.
function compareLeaderboardRank(a: PlayerWithGames, b: PlayerWithGames): number {
  const placedDiff = Number(b.player.is_placed) - Number(a.player.is_placed);
  if (placedDiff !== 0) return placedDiff;
  const mmrDiff = b.player.mmr - a.player.mmr;
  if (mmrDiff !== 0) return mmrDiff;
  return a.player.id.localeCompare(b.player.id);
}

async function processProfile(interaction: DiscordInteraction, targetDiscordIdOption: string | null) {
  const callerDiscordId = interactionUserId(interaction);
  if (!callerDiscordId) {
    await editOriginalResponse(interaction.token, { content: "Couldn't identify you — try again." });
    return;
  }
  const targetDiscordId = targetDiscordIdOption ?? callerDiscordId;

  const allPlayers = await getAllPlayersWithGames();
  const entry = allPlayers.find((p) => p.player.discord_id === targetDiscordId);

  if (!entry) {
    await editOriginalResponse(interaction.token, {
      content: targetDiscordIdOption ? "That player hasn't queued yet." : "You haven't queued yet.",
    });
    return;
  }
  if (entry.player.total_games_played < 1) {
    await editOriginalResponse(interaction.token, {
      content: targetDiscordIdOption ? "That player hasn't completed a match yet." : "You haven't completed a match yet.",
    });
    return;
  }

  // Same eligibility (>=1 game, any queue) and ordering the Main Leaderboard uses, so this rank
  // number always matches what that player would see on the website.
  const eligible = allPlayers.filter((p) => p.player.total_games_played >= 1).sort(compareLeaderboardRank);
  const rank = eligible.findIndex((p) => p.player.id === entry.player.id) + 1;

  const rankStats = computeStats(filterGames(entry.games, { queueType: "rank" }));
  const { player } = entry;
  const band: DisplayBand | null = player.is_placed ? player.band : null;

  const [rankEmoji, displayMmr] = await Promise.all([getRankEmoji(band), getDisplayMMR(player.mmr)]);

  const streakText =
    rankStats.currentStreak.type === "W"
      ? `${rankStats.currentStreak.count} Win Streak${rankStats.currentStreak.count >= FLAME_THRESHOLD ? ` ${ON_FIRE_EMOJI}` : ""}`
      : rankStats.currentStreak.type === "L"
        ? `${rankStats.currentStreak.count} Loss Streak${rankStats.currentStreak.count >= COLD_THRESHOLD ? ` ${COLD_EMOJI}` : ""}`
        : "No Rank Queue games yet";

  const playerMention = mention(player.discord_id, {
    onFire: rankStats.currentStreak.type === "W" && rankStats.currentStreak.count >= FLAME_THRESHOLD,
    cold: rankStats.currentStreak.type === "L" && rankStats.currentStreak.count >= COLD_THRESHOLD,
    prism: player.is_prism,
  });

  await editOriginalResponse(interaction.token, {
    embeds: [
      {
        color: BRAND_COLOR,
        description: `**${playerMention}**`,
        fields: [
          { name: "Band", value: `${rankEmoji} ${getRankLabel(band)}`, inline: true },
          { name: "MMR", value: `${Math.round(displayMmr)}`, inline: true },
          { name: "Rank", value: `#${rank}`, inline: true },
          { name: "Streak", value: streakText, inline: true },
          { name: "Wins", value: `${rankStats.wins}`, inline: true },
          { name: "Losses", value: `${rankStats.losses}`, inline: true },
        ],
      },
    ],
  });
}
