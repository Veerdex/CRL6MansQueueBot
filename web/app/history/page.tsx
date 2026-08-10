import Link from "next/link";
import type { Metadata } from "next";
import HistoryBoard from "@/components/HistoryBoard";
import { getMatchHistory } from "@/lib/leaderboard/history";
import { getConfigNumber } from "@/lib/discord/config";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Match History — CRL West 6 Mans",
};

export default async function HistoryPage() {
  const [{ matches, players }, mmrScale, mmrShift] = await Promise.all([
    getMatchHistory(),
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

      <h1 className="animate-in mb-6 text-2xl font-bold text-foreground">Match History</h1>

      <div className="panel animate-in-delay-1 p-4 sm:p-6">
        <HistoryBoard matches={matches} players={players} mmrScale={mmrScale} mmrShift={mmrShift} />
      </div>
    </div>
  );
}
