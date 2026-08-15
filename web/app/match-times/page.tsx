import Link from "next/link";
import { getMatchTimeStats, getMMRDistributionStats, getSeriesLengthStats } from "@/lib/leaderboard/queries";
import { getConfigNumber, getConfigValue } from "@/lib/discord/config";
import {
  computeDayTrackingTotals,
  MATCH_TIME_STATS_SUPERCHARGED_DAYS_KEY,
  MATCH_TIME_STATS_NONSUPERCHARGED_DAYS_KEY,
} from "@/lib/discord/bonusDay";
import LineChart from "@/components/LineChart";
import MMRDistributionPanel from "@/components/MMRDistributionPanel";
import SeriesLengthPanel from "@/components/SeriesLengthPanel";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Match Times — CRL West 6 Mans",
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// segment_index 0..47 -> "0:00", "0:30", "1:00", ... "23:30" (Pacific time, matching
// matchTimeStats.ts's increment side — see CLAUDE.md, "Match time stats").
function segmentLabel(index: number): string {
  const hour = Math.floor(index / 2);
  const minute = index % 2 === 0 ? "00" : "30";
  return `${hour}:${minute}`;
}

export default async function MatchTimesPage() {
  const [
    { timeOfDay, dayOfWeek },
    distribution,
    seriesLengthStats,
    mmrScale,
    mmrShift,
    statsStartedAtRaw,
    superchargedDays,
    nonSuperchargedDays,
  ] = await Promise.all([
    getMatchTimeStats(),
    getMMRDistributionStats(),
    getSeriesLengthStats(),
    getConfigNumber("mmr_scale", 1),
    getConfigNumber("mmr_shift", 0),
    getConfigValue("match_time_stats_started_at"),
    getConfigNumber(MATCH_TIME_STATS_SUPERCHARGED_DAYS_KEY, 0),
    getConfigNumber(MATCH_TIME_STATS_NONSUPERCHARGED_DAYS_KEY, 0),
  ]);

  const rawOverall = timeOfDay.map((row) => row.supercharged_count + row.non_supercharged_count);
  const hasAnyMatches = rawOverall.some((v) => v > 0);

  // Weekday-occurrence counts (Day of Week panel's denominator) are still pure calendar math off
  // match_time_stats_started_at — a Monday is always a Monday regardless of config, so there's no
  // retroactive-reclassification risk there. The supercharged/non-supercharged split above no
  // longer comes from this — see MATCH_TIME_STATS_SUPERCHARGED_DAYS_KEY/..._NONSUPERCHARGED_...,
  // two counters advanced once per day by the sweep (web/lib/discord/bonusDay.ts) instead of
  // being recomputed against the *current* bonus range on every page load.
  const statsStartedAt = statsStartedAtRaw ? new Date(statsStartedAtRaw) : new Date();
  const totals = computeDayTrackingTotals(statsStartedAt, new Date());
  const totalDays = superchargedDays + nonSuperchargedDays;

  const supercharged = timeOfDay.map((row) => (superchargedDays > 0 ? row.supercharged_count / superchargedDays : 0));
  const nonSupercharged = timeOfDay.map((row) => (nonSuperchargedDays > 0 ? row.non_supercharged_count / nonSuperchargedDays : 0));
  // "Overall" is the sum of the two per-kind averages (not total count / total days) — an
  // average day's expected match count in this segment, whether or not that particular day
  // turns out to be supercharged.
  const overall = supercharged.map((v, i) => v + nonSupercharged[i]);
  const segmentLabels = timeOfDay.map((row) => segmentLabel(row.segment_index));

  const weeklyLabels = dayOfWeek.map((row) => DAY_NAMES[row.day_of_week]);
  const weeklyValues = dayOfWeek.map((row) => {
    const occurrences = totals.daysOccurredByWeekday[row.day_of_week];
    return occurrences > 0 ? row.count / occurrences : 0;
  });

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10">
      <Link
        href="/"
        className="animate-in mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-muted transition-opacity hover:opacity-80"
      >
        ← Back to Leaderboard
      </Link>

      <h1 className="animate-in mb-6 text-2xl font-bold text-foreground">Match Times</h1>

      <div className="panel animate-in-delay-1 mb-6 p-4 sm:p-6">
        <h2 className="mb-1 text-lg font-bold text-foreground">Time of Day</h2>
        <p className="mb-4 text-sm text-muted">
          Average matches formed per 30-minute segment (Pacific time), overall vs. per Supercharged (Bonus Range) day vs.
          per non-Supercharged day — based on {totalDays} day{totalDays === 1 ? "" : "s"} tracked ({superchargedDays}{" "}
          supercharged, {nonSuperchargedDays} non-supercharged).
        </p>
        {!hasAnyMatches && <p className="mb-4 text-sm text-muted">No matches recorded yet.</p>}
        <LineChart
          xLabelStride={4}
          series={[
            { label: "Overall", color: "#a3a3a3", values: overall },
            { label: "Supercharged", color: "#f59e0b", values: supercharged },
            { label: "Non-Supercharged", color: "#3b82f6", values: nonSupercharged },
          ]}
          xLabels={segmentLabels}
        />
      </div>

      <div className="panel animate-in-delay-2 mb-6 p-4 sm:p-6">
        <h2 className="mb-1 text-lg font-bold text-foreground">Day of Week</h2>
        <p className="mb-4 text-sm text-muted">
          Average matches formed per day of week (Pacific time) — each day divided by how many of that weekday have
          occurred since tracking began.
        </p>
        <LineChart series={[{ label: "Overall", color: "#a3a3a3", values: weeklyValues }]} xLabels={weeklyLabels} />
      </div>

      <div className="panel animate-in-delay-2 mb-6 p-4 sm:p-6">
        <SeriesLengthPanel stats={seriesLengthStats} />
      </div>

      <div className="panel animate-in-delay-2 p-4 sm:p-6">
        <MMRDistributionPanel
          players={distribution.players}
          totalMatchesPlayed={distribution.totalMatchesPlayed}
          rankMatchesPlayed={distribution.rankMatchesPlayed}
          universalMatchesPlayed={distribution.universalMatchesPlayed}
          mmrScale={mmrScale}
          mmrShift={mmrShift}
        />
      </div>
    </div>
  );
}
