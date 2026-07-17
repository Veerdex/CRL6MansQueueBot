import UnifiedLeaderboard from "@/components/UnifiedLeaderboard";
import {
  getActiveSeason,
  getAllPlayersWithGames,
  getPreviousSeason,
  getSeasonHistoryMap,
} from "@/lib/leaderboard/queries";
import type { SeasonHistoryRow } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [activeSeason, players] = await Promise.all([getActiveSeason(), getAllPlayersWithGames()]);

  const previousSeason = activeSeason ? await getPreviousSeason(activeSeason.season_number) : null;
  const previousSeasonHistory = previousSeason
    ? await getSeasonHistoryMap(previousSeason.id)
    : new Map<string, SeasonHistoryRow>();

  return (
    <UnifiedLeaderboard
      players={players}
      activeSeason={activeSeason}
      previousSeason={previousSeason}
      previousSeasonHistory={previousSeasonHistory}
    />
  );
}
