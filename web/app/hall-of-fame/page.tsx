import Link from "next/link";
import type { Metadata } from "next";
import HallOfFameSeasonSection from "@/components/HallOfFameSeasonSection";
import { getHallOfFameData } from "@/lib/leaderboard/hallOfFame";
import { getConfigNumber } from "@/lib/discord/config";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Hall of Fame — CRL West 6 Mans",
};

export default async function HallOfFamePage() {
  const [seasons, mmrScale, mmrShift] = await Promise.all([
    getHallOfFameData(),
    getConfigNumber("mmr_scale", 1),
    getConfigNumber("mmr_shift", 0),
  ]);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10">
      <Link
        href="/"
        className="animate-in mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-muted transition-opacity hover:opacity-80"
      >
        ← Back to Leaderboard
      </Link>

      <h1 className="animate-in mb-6 text-2xl font-bold text-foreground">Hall of Fame</h1>

      {seasons.length === 0 ? (
        <div className="panel animate-in-delay-1 p-6 text-center text-sm text-muted">No seasons yet.</div>
      ) : (
        <div className="space-y-6">
          {seasons.map((season, i) => (
            <div key={season.seasonId} className={i === 0 ? "animate-in-delay-1" : "animate-in-delay-2"}>
              <HallOfFameSeasonSection season={season} mmrScale={mmrScale} mmrShift={mmrShift} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
