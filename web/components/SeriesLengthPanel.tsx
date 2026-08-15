import BarChart, { type BarChartBar } from "./BarChart";
import { SERIES_LENGTH_LABELS, SERIES_LENGTH_K_MULTIPLIERS } from "@/lib/discord/teamFormation";
import type { SeriesLengthStats } from "@/lib/leaderboard/queries";
import type { SeriesLength } from "@/lib/supabase/types";

interface SeriesLengthPanelProps {
  stats: SeriesLengthStats;
}

const SERIES_LENGTH_ORDER: SeriesLength[] = ["bo3", "bo5", "bo7"];

// BO3 yellow, BO5 orange, BO7 red — per direct request, distinct enough from each other and from
// the amber/blue already used by the Time of Day chart above this panel.
const SERIES_LENGTH_COLORS: Record<SeriesLength, string> = {
  bo3: "#eab308",
  bo5: "#f97316",
  bo7: "#ef4444",
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// No client state needed (unlike MMRDistributionPanel's scale/shift sliders), so this stays a
// plain server component.
export default function SeriesLengthPanel({ stats }: SeriesLengthPanelProps) {
  const { counts, total } = stats;

  return (
    <div>
      <h2 className="mb-1 text-lg font-bold text-foreground">Series Length</h2>
      <p className="mb-4 text-sm text-muted">
        Rank Queue series only. For each Best-of length: the share of series actually played at that length, and its
        weighted share once the series-length K-factor multiplier (0.6x / 1.0x / 1.4x) is applied — how much of the
        pool&apos;s overall Elo-swing weight that format accounts for, not just how often it&apos;s picked.
      </p>

      {total === 0 ? (
        <p className="mb-4 text-sm text-muted">No series-length data yet.</p>
      ) : (
        <>
          <BarChart
            bars={SERIES_LENGTH_ORDER.flatMap((length): BarChartBar[] => {
              const pct = (counts[length] / total) * 100;
              const weighted = pct * SERIES_LENGTH_K_MULTIPLIERS[length];
              const color = SERIES_LENGTH_COLORS[length];
              const label = SERIES_LENGTH_LABELS[length].replace("Best of ", "BO");
              return [
                { label: `${label} %`, value: round1(pct), color },
                { label: `${label} Wtd`, value: round1(weighted), color },
              ];
            })}
          />

          <div className="mt-4 flex flex-wrap gap-3">
            {SERIES_LENGTH_ORDER.map((length) => (
              <div
                key={length}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5"
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: SERIES_LENGTH_COLORS[length] }} />
                <span className="text-xs text-foreground">{SERIES_LENGTH_LABELS[length]}</span>
                <span className="text-xs font-semibold text-muted">
                  {counts[length]} ({round1((counts[length] / total) * 100)}%)
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
