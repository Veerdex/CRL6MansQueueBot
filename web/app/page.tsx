import UnifiedLeaderboard from "@/components/UnifiedLeaderboard";
import {
  getAllPlayersWithGames,
  getAllSeasonHistory,
  getAllSeasons,
} from "@/lib/leaderboard/queries";
import { getConfigNumber } from "@/lib/discord/config";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [seasons, seasonHistory, players, mmrScale, mmrShift, prismTopN, top10MinGames] = await Promise.all([
    getAllSeasons(),
    getAllSeasonHistory(),
    getAllPlayersWithGames(),
    getConfigNumber("mmr_scale", 1),
    getConfigNumber("mmr_shift", 0),
    getConfigNumber("prism_top_n", 1),
    getConfigNumber("top10_min_games", 8),
  ]);

  return (
    <UnifiedLeaderboard
      players={players}
      seasons={seasons}
      seasonHistory={seasonHistory}
      mmrScale={mmrScale}
      mmrShift={mmrShift}
      prismTopN={prismTopN}
      top10MinGames={top10MinGames}
    />
  );
}
