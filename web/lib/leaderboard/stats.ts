import type { Band } from "../supabase/types";
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
}

export function filterGames(games: CompletedGame[], filter: GameFilter): CompletedGame[] {
  return games.filter((game) => {
    if (filter.seasonId && game.seasonId !== filter.seasonId) return false;
    return true;
  });
}

// `games` must be in chronological order (oldest first) — streaks depend on it.
//
// `currentSeasonId`, when passed, makes `currentStreak` reset at every season boundary — a
// season close always zeroes a player's current streak (see CLAUDE.md, "Seasons"), so it can
// never bridge from a prior (now-closed) season into whatever's been played since, even between
// two wins. This is the one thing UnifiedLeaderboard/profile.ts/streaks.ts's own season-id
// filtering (see CLAUDE.md, "Current streak always resets...") doesn't cover: the All-Time Stats
// board (StatsBoard.tsx's "all-time" mode) deliberately passes every game a player has ever
// played to computeStats, since wins/losses/gamesPlayed/longestWinStreak are meant to be lifetime
// totals there — but "current streak" isn't a total, it's a live "on a streak right now"
// indicator, so it needs this narrower reset even inside an otherwise-lifetime view. Omit it (or
// pass undefined) to keep the old unrestricted behavior for a caller with no season id on hand.
export function computeStats(games: CompletedGame[], currentSeasonId?: string | null): GameStats {
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

    if (currentSeasonId !== undefined && currentSeasonId !== null && game.seasonId !== currentSeasonId) {
      currentStreakType = null;
      currentStreakCount = 0;
    } else if (currentStreakType === (game.won ? "W" : "L")) {
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
