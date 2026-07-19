import UnifiedLeaderboard from "@/components/UnifiedLeaderboard";
import {
  getActiveSeason,
  getAllPlayersWithGames,
  getPreviousSeason,
  getSeasonHistoryMap,
} from "@/lib/leaderboard/queries";
import { getConfigNumber } from "@/lib/discord/config";
import type { SeasonHistoryRow } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [activeSeason, players, mmrScale, mmrShift] = await Promise.all([
    getActiveSeason(),
    getAllPlayersWithGames(),
    getConfigNumber("mmr_scale", 1),
    getConfigNumber("mmr_shift", 0),
  ]);

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
      mmrScale={mmrScale}
      mmrShift={mmrShift}
    />
  );
}
