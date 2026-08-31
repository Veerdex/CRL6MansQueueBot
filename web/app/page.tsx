import UnifiedLeaderboard from "@/components/UnifiedLeaderboard";
import HallOfFamePopup from "@/components/HallOfFamePopup";
import {
  getAllPlayersWithGames,
  getAllSeasonHistory,
  getAllSeasons,
} from "@/lib/leaderboard/queries";
import { getConfigNumber } from "@/lib/discord/config";
import { getHallOfFameData } from "@/lib/leaderboard/hallOfFame";

export const dynamic = "force-dynamic";

// Freshness window for the Hall of Fame season-close popup — after it, the popup never shows again
// for that season no matter what the visitor's browser reports. This upper bound is the real
// guarantee that it can't become a nuisance; the localStorage check inside the component only
// suppresses repeats *within* the window, and it silently degrades to "show it" whenever storage is
// blocked or cleared.
//
// Measured from UTC midnight of end_date, NOT from the moment the season actually closed — the
// close time isn't recoverable. crl6mansqueuebot_seasons.end_date is a `date`, written by
// performSeasonReset as new Date().toISOString().slice(0, 10), so all that's known is which UTC day
// the close happened on. The anchor is therefore at or before the true close instant, by up to 24h,
// which means a window of H hours shows the popup for somewhere in (H - 24, H] hours after the
// season really ended.
//
// Hence 48 rather than 24 for "the first day after the season ends": 48 guarantees a full 24h for
// every visitor and caps at two days, whereas a literal 24 would leave a season closed at 23:50 UTC
// with a ten-minute window — the feature would silently never fire. Set hof_popup_window_hours to 24
// to get strict close-day-only behavior instead, accepting that risk.
const DEFAULT_HOF_POPUP_WINDOW_HOURS = 48;

function isWithinPopupWindow(endDate: string | null, windowHours: number): boolean {
  // Only performSeasonReset writes end_date, so a closed season missing one was closed by hand or by
  // older code. Treat that as "too old to celebrate" rather than "no expiry", which would pin the
  // popup on forever.
  if (!endDate) return false;
  const anchor = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(anchor)) return false;
  return Date.now() < anchor + windowHours * 60 * 60 * 1000;
}

export default async function HomePage() {
  const [
    seasons,
    seasonHistory,
    players,
    mmrScale,
    mmrShift,
    hofPopupWindowHours,
    hallOfFameSeasons,
  ] = await Promise.all([
    getAllSeasons(),
    getAllSeasonHistory(),
    getAllPlayersWithGames(),
    getConfigNumber("mmr_scale", 1),
    getConfigNumber("mmr_shift", 0),
    getConfigNumber("hof_popup_window_hours", DEFAULT_HOF_POPUP_WINDOW_HOURS),
    getHallOfFameData(),
  ]);

  // getHallOfFameData orders seasons active-first, then closed seasons newest-first, so the first
  // non-active entry is the most recently closed season — "the season that just finished". Null
  // when no season has ever closed, which keeps the popup off entirely rather than celebrating an
  // in-progress season.
  const justFinishedSeason = hallOfFameSeasons.find((s) => !s.isActive) ?? null;

  // HallOfFameSeason carries no end_date, but its seasonId is the seasons-row id it was built from,
  // so the date comes from the rows already fetched above rather than by widening that interface for
  // this one consumer.
  const justFinishedEndDate = justFinishedSeason
    ? (seasons.find((s) => s.id === justFinishedSeason.seasonId)?.end_date ?? null)
    : null;
  const popupSeason = isWithinPopupWindow(justFinishedEndDate, hofPopupWindowHours) ? justFinishedSeason : null;

  return (
    <>
      <HallOfFamePopup season={popupSeason} mmrScale={mmrScale} mmrShift={mmrShift} />
      <UnifiedLeaderboard
        players={players}
        seasons={seasons}
        seasonHistory={seasonHistory}
        mmrScale={mmrScale}
        mmrShift={mmrShift}
      />
    </>
  );
}
