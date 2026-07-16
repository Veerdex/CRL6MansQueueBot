import StatsBoard from "@/components/StatsBoard";
import { getAllPlayersWithGames } from "@/lib/leaderboard/queries";

export const dynamic = "force-dynamic";

export default async function AllTimeStatsPage() {
  const players = await getAllPlayersWithGames();

  const eligiblePlayers = players
    .filter(({ player }) => player.total_games_played >= 1)
    .map(({ player, games }) => ({
      playerId: player.id,
      displayName: player.display_name,
      games,
    }));

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10">
      <h1 className="mb-1 text-2xl font-bold text-brand-blue dark:text-white">All-Time Stats</h1>
      <p className="mb-6 text-sm text-zinc-500">
        Lifetime stats by queue scope. Click a column header to sort.
      </p>
      <div className="rounded-2xl border border-zinc-800 bg-black p-4 shadow-sm sm:p-6">
        <StatsBoard players={eligiblePlayers} mode="all-time" currentSeason={null} previousSeason={null} />
      </div>
    </div>
  );
}
