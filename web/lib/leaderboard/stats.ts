import type { Band, QueueType } from "../supabase/types";
import type { CompletedGame } from "./queries";

export interface GameStats {
  gamesPlayed: number;
  wins: number;
  losses: number;
  winRate: number | null; // null when gamesPlayed === 0
  currentStreak: { type: "W" | "L" | null; count: number };
  longestWinStreak: number;
}

export interface GameFilter {
  seasonId?: string;
  queueType?: QueueType | "all";
}

export function filterGames(games: CompletedGame[], filter: GameFilter): CompletedGame[] {
  return games.filter((game) => {
    if (filter.seasonId && game.seasonId !== filter.seasonId) return false;
    if (filter.queueType && filter.queueType !== "all" && game.queueType !== filter.queueType) {
      return false;
    }
    return true;
  });
}

// `games` must be in chronological order (oldest first) — streaks depend on it.
export function computeStats(games: CompletedGame[]): GameStats {
  let wins = 0;
  let losses = 0;
  let longestWinStreak = 0;
  let runningWinStreak = 0;
  let currentStreakType: "W" | "L" | null = null;
  let currentStreakCount = 0;

  for (const game of games) {
    if (game.won) {
      wins += 1;
      runningWinStreak += 1;
      longestWinStreak = Math.max(longestWinStreak, runningWinStreak);
    } else {
      losses += 1;
      runningWinStreak = 0;
    }

    if (currentStreakType === (game.won ? "W" : "L")) {
      currentStreakCount += 1;
    } else {
      currentStreakType = game.won ? "W" : "L";
      currentStreakCount = 1;
    }
  }

  const gamesPlayed = games.length;
  return {
    gamesPlayed,
    wins,
    losses,
    winRate: gamesPlayed > 0 ? wins / gamesPlayed : null,
    currentStreak: { type: currentStreakType, count: currentStreakCount },
    longestWinStreak,
  };
}

// 🔥 win-streak decoration threshold (Main leaderboard, current Rank Queue streak) — the
// canonical definition lives here (not lib/discord/streaks.ts, which re-exports it) since that
// file is `server-only` and can't be imported into leaderboard client components.
export const FLAME_THRESHOLD = 3;

// 🥶 losing-streak decoration threshold — same mirror-of-FLAME_THRESHOLD treatment, purely
// cosmetic (no MMR effect, no separate announcement-embed threshold like ON_FIRE_THRESHOLD).
export const COLD_THRESHOLD = 3;

export const BAND_ORDER: readonly Band[] = ["Iron", "Garnet", "Emerald", "Sapphire"];

export function bandRank(band: Band | null): number {
  if (!band) return -1;
  return BAND_ORDER.indexOf(band);
}
