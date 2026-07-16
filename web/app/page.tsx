import LeaderboardTable, { type MainBoardRow } from "@/components/LeaderboardTable";
import { SEASON_RANK_DISPLAY_MIN_GAMES } from "@/lib/leaderboard/constants";
import {
  getActiveSeason,
  getAllPlayersWithGames,
  getPreviousSeason,
  getSeasonHistoryMap,
} from "@/lib/leaderboard/queries";
import { bandRank, computeStats, filterGames } from "@/lib/leaderboard/stats";
import type { SeasonHistoryRow } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [activeSeason, players] = await Promise.all([getActiveSeason(), getAllPlayersWithGames()]);

  const previousSeason = activeSeason ? await getPreviousSeason(activeSeason.season_number) : null;
  const previousSeasonHistory = previousSeason
    ? await getSeasonHistoryMap(previousSeason.id)
    : new Map<string, SeasonHistoryRow>();

  const rows: MainBoardRow[] = players
    .filter(({ player }) => player.total_games_played >= 1)
    .sort((a, b) => {
      const bandDiff = bandRank(b.player.band) - bandRank(a.player.band);
      if (bandDiff !== 0) return bandDiff;
      if (!a.player.is_placed) return b.player.total_games_played - a.player.total_games_played;
      return b.player.mmr - a.player.mmr;
    })
    .map(({ player, games }) => {
      const rankStats = computeStats(filterGames(games, { queueType: "rank" }));
      const history = previousSeasonHistory.get(player.id);
      const lastSeasonRank =
        history && history.season_games_played >= SEASON_RANK_DISPLAY_MIN_GAMES
          ? history.season_rank
          : null;
      return {
        playerId: player.id,
        displayName: player.display_name,
        band: player.is_placed ? player.band : null,
        mmr: player.is_placed ? player.mmr : null,
        wins: rankStats.wins,
        losses: rankStats.losses,
        winRate: rankStats.winRate,
        lastSeasonRank,
      };
    });

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10">
      <h1 className="mb-1 text-2xl font-bold text-brand-blue dark:text-white">Main Leaderboard</h1>
      <p className="mb-6 text-sm text-zinc-500">
        Rank Queue standing — Universal Queue games don&apos;t affect MMR or this board. Top 10
        rows are the live projected Prism cut. Players still in placement show NA until their band
        is assigned.
      </p>

      <div className="rounded-2xl border border-zinc-800 bg-black p-4 shadow-sm sm:p-6">
        <LeaderboardTable rows={rows} topCount={10} />
      </div>
    </div>
  );
}
