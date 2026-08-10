import Link from "next/link";
import { notFound } from "next/navigation";
import HeadToHeadBoard from "@/components/HeadToHeadBoard";
import { getHeadToHeadData } from "@/lib/leaderboard/headToHead";

export const dynamic = "force-dynamic";

export default async function HeadToHeadPage({
  params,
}: {
  params: Promise<{ playerId: string }>;
}) {
  const { playerId } = await params;
  const data = await getHeadToHeadData(playerId);
  if (!data) notFound();

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10">
      <Link
        href="/"
        className="animate-in mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-muted transition-opacity hover:opacity-80"
      >
        ← Back to Leaderboard
      </Link>

      <h1 className="animate-in mb-6 text-2xl font-bold text-foreground">Head-to-Head</h1>

      <div className="panel animate-in-delay-1 p-4 sm:p-6">
        <HeadToHeadBoard target={data.target} games={data.games} players={Array.from(data.playersById.values())} />
      </div>
    </div>
  );
}
