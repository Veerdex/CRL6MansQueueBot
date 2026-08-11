import PlayerAvatar from "./PlayerAvatar";
import { getRankIconPath, getRankLabel, type DisplayBand } from "@/lib/leaderboard/rankIcon";
import { formatDisplayName } from "@/lib/leaderboard/formatName";
import type { HallOfFameSlot } from "@/lib/leaderboard/hallOfFame";

function applyMMRTransform(mmr: number, scale: number, shift: number): number {
  return mmr * scale + shift;
}

// Gold/silver/bronze podium colors for the top 3, grey for "most games played" / "highest win
// streak" — literal request. The active season's whole section is desaturated via a `grayscale`
// filter one level up (HallOfFameSeasonSection), which also greys these out for "not confirmed".
const SLOT_BG: Record<string, string> = {
  rank1: "bg-gold",
  rank2: "bg-silver",
  rank3: "bg-bronze",
  games: "bg-slot-grey",
  streak: "bg-slot-grey",
};

function slotKey(slot: HallOfFameSlot): string {
  return slot.kind === "rank" ? `rank${slot.position}` : slot.kind;
}

function slotLabel(slot: HallOfFameSlot): string {
  if (slot.kind === "rank") return slot.position === 1 ? "1st Place" : slot.position === 2 ? "2nd Place" : "3rd Place";
  if (slot.kind === "games") return "Most Games Played";
  return "Highest Win Streak";
}

function slotValue(slot: HallOfFameSlot, mmrScale: number, mmrShift: number): string {
  if (slot.kind === "rank") return `${Math.round(applyMMRTransform(slot.mmr, mmrScale, mmrShift))} MMR`;
  if (slot.kind === "games") return `${slot.gamesPlayed} game${slot.gamesPlayed === 1 ? "" : "s"} played`;
  return `${slot.streak} game win streak`;
}

export default function HallOfFameSlotCard({
  slot,
  mmrScale,
  mmrShift,
}: {
  slot: HallOfFameSlot;
  mmrScale: number;
  mmrShift: number;
}) {
  const displayBand: DisplayBand | null = slot.player ? (slot.player.isPrism ? "Prism" : slot.player.band) : null;

  return (
    <div
      className={`flex w-40 flex-col items-center gap-1.5 rounded-xl p-4 text-center text-[#161616] shadow-lg ${SLOT_BG[slotKey(slot)]}`}
    >
      <span className="text-[10px] font-bold uppercase tracking-wide opacity-70">{slotLabel(slot)}</span>
      {slot.player ? (
        <>
          <PlayerAvatar avatarUrl={slot.player.avatarUrl} alt={slot.player.displayName} />
          <span className="max-w-full truncate text-sm font-semibold">{formatDisplayName(slot.player.displayName)}</span>
          {displayBand && (
            <img
              src={getRankIconPath(displayBand)}
              alt={getRankLabel(displayBand)}
              title={getRankLabel(displayBand)}
              className="h-6 w-6 object-contain"
            />
          )}
          <span className="text-xs font-medium opacity-80">{slotValue(slot, mmrScale, mmrShift)}</span>
        </>
      ) : (
        <span className="py-4 text-xs font-medium opacity-70">No data yet</span>
      )}
    </div>
  );
}
