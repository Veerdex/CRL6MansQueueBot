import Link from "next/link";
import { getMatchTimeStats, getMMRDistributionStats } from "@/lib/leaderboard/queries";
import { getConfigNumber, getConfigValue } from "@/lib/discord/config";
import { computeDayTrackingTotals } from "@/lib/discord/bonusDay";
import LineChart from "@/components/LineChart";
import MMRDistributionPanel from "@/components/MMRDistributionPanel";

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
    mmrScale,
    mmrShift,
    statsStartedAtRaw,
    bonusDayEnabled,
    bonusDayStart,
    bonusDayEnd,
  ] = await Promise.all([
    getMatchTimeStats(),
    getMMRDistributionStats(),
    getConfigNumber("mmr_scale", 1),
    getConfigNumber("mmr_shift", 0),
    getConfigValue("match_time_stats_started_at"),
    getConfigNumber("bonus_day_enabled", 1),
    getConfigNumber("bonus_day_start", 6),
    getConfigNumber("bonus_day_end", 6),
  ]);

  const rawOverall = timeOfDay.map((row) => row.supercharged_count + row.non_supercharged_count);
  const hasAnyMatches = rawOverall.some((v) => v > 0);

  // Raw counts are cumulative since match_time_stats_started_at (see the migration that
  // introduced it) with no notion of how many days that represents — dividing by how many of
  // each day "kind" have actually elapsed since then is what makes segments/days proportional
  // and comparable, rather than just reflecting how long the counters have been running.
  const statsStartedAt = statsStartedAtRaw ? new Date(statsStartedAtRaw) : new Date();
  const totals = computeDayTrackingTotals(statsStartedAt, new Date(), bonusDayEnabled === 1, bonusDayStart, bonusDayEnd);

  const supercharged = timeOfDay.map((row) => (totals.superchargedDays > 0 ? row.supercharged_count / totals.superchargedDays : 0));
  const nonSupercharged = timeOfDay.map((row) =>
    totals.nonSuperchargedDays > 0 ? row.non_supercharged_count / totals.nonSuperchargedDays : 0,
  );
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
          per non-Supercharged day — based on {totals.totalDays} day{totals.totalDays === 1 ? "" : "s"} tracked (
          {totals.superchargedDays} supercharged, {totals.nonSuperchargedDays} non-supercharged).
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
