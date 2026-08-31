import HallOfFameSlotCard from "./HallOfFameSlotCard";
import type { HallOfFameSeason } from "@/lib/leaderboard/hallOfFame";

// The active season's whole block is desaturated + dimmed ("greyed out") to signal its standings
// aren't final yet — the top 3 (plus games/streak) can still change as more games get reported
// this season, unlike a closed season's archival season_history snapshot.
export default function HallOfFameSeasonSection({
  season,
  mmrScale,
  mmrShift,
}: {
  season: HallOfFameSeason;
  mmrScale: number;
  mmrShift: number;
}) {
  // Fixed slot order from getHallOfFameData/buildSlots: rank1-3, games, streak — split into two
  // rows on their own lines: podium on top, the two stat slots (same smaller size tier) below.
  const podium = season.slots.slice(0, 3);
  const rest = season.slots.slice(3);

  return (
    <section className={`panel p-6 ${season.isActive ? "grayscale opacity-60" : ""}`}>
      <div className="mb-4 text-center">
        <h2 className="text-xl font-bold text-foreground">Season {season.seasonNumber}</h2>
        {season.isActive && (
          <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-muted">In progress — not yet confirmed</p>
        )}
      </div>
      <div className="flex flex-col items-center gap-4">
        {[podium, rest].map((row, rowIndex) => (
          <div key={rowIndex} className="flex flex-wrap items-start justify-center gap-4">
            {row.map((slot, i) => (
              <HallOfFameSlotCard key={i} slot={slot} mmrScale={mmrScale} mmrShift={mmrShift} />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
