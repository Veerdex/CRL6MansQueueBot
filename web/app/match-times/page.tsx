import Link from "next/link";
import { getMatchTimeStats, getMMRDistributionStats } from "@/lib/leaderboard/queries";
import { getConfigNumber } from "@/lib/discord/config";
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
  const [{ timeOfDay, dayOfWeek }, distribution, mmrScale, mmrShift] = await Promise.all([
    getMatchTimeStats(),
    getMMRDistributionStats(),
    getConfigNumber("mmr_scale", 1),
    getConfigNumber("mmr_shift", 0),
  ]);

  const overall = timeOfDay.map((row) => row.supercharged_count + row.non_supercharged_count);
  const supercharged = timeOfDay.map((row) => row.supercharged_count);
  const nonSupercharged = timeOfDay.map((row) => row.non_supercharged_count);
  const segmentLabels = timeOfDay.map((row) => segmentLabel(row.segment_index));

  const weeklyLabels = dayOfWeek.map((row) => DAY_NAMES[row.day_of_week]);
  const weeklyValues = dayOfWeek.map((row) => row.count);

  const hasAnyMatches = overall.some((v) => v > 0);

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
          Matches formed per 30-minute segment (Pacific time), overall vs. Supercharged (Bonus Day) vs. non-Supercharged.
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
        <p className="mb-4 text-sm text-muted">Matches formed per day of week (Pacific time).</p>
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
