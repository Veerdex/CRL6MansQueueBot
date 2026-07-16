import StatsBoard from "@/components/StatsBoard";
import { getActiveSeason, getAllPlayersWithGames, getPreviousSeason } from "@/lib/leaderboard/queries";

export const dynamic = "force-dynamic";

export default async function SeasonStatsPage() {
  const [activeSeason, players] = await Promise.all([getActiveSeason(), getAllPlayersWithGames()]);

  if (!activeSeason) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-10">
        <h1 className="mb-1 text-2xl font-bold text-brand-blue dark:text-white">Season Stats</h1>
        <p className="text-zinc-500">No active season yet.</p>
      </div>
    );
  }

  const previousSeason = await getPreviousSeason(activeSeason.season_number);

  const eligiblePlayers = players
    .filter(({ player }) => player.total_games_played >= 1)
    .map(({ player, games }) => ({
      playerId: player.id,
      displayName: player.display_name,
      games,
    }));

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10">
      <h1 className="mb-1 text-2xl font-bold text-brand-blue dark:text-white">Season Stats</h1>
      <p className="mb-6 text-sm text-zinc-500">
        Stats for the selected season and queue scope. Click a column header to sort.
      </p>
      <div className="rounded-2xl border border-zinc-800 bg-black p-4 shadow-sm sm:p-6">
        <StatsBoard
          players={eligiblePlayers}
          mode="season"
          currentSeason={{ id: activeSeason.id, seasonNumber: activeSeason.season_number }}
          previousSeason={
            previousSeason ? { id: previousSeason.id, seasonNumber: previousSeason.season_number } : null
          }
        />
      </div>
    </div>
  );
}
