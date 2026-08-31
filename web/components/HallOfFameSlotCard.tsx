import PlayerAvatar from "./PlayerAvatar";
import { getRankIconPath, getRankLabel, type DisplayBand } from "@/lib/leaderboard/rankIcon";
import { formatDisplayName } from "@/lib/leaderboard/formatName";
import type { HallOfFameSlot } from "@/lib/leaderboard/hallOfFame";

function applyMMRTransform(mmr: number, scale: number, shift: number): number {
  return mmr * scale + shift;
}

const PRISM_ICON_PATH = "/ranks/Prism.png";

// Gold/silver/bronze podium colors for the top 3; "most games played"/"highest win streak" share
// a neutral grey — they're a different kind of achievement than a placing, and the size-tier drop
// (see TIER_STEP) is what visually separates that second row from the podium.
const SLOT_BG: Record<string, string> = {
  rank1: "bg-gold",
  rank2: "bg-silver",
  rank3: "bg-bronze",
  games: "bg-slot-grey",
  streak: "bg-slot-grey",
};

// Two cascading size tiers, each 15% smaller than the one before: the podium (1st-3rd) at 85%,
// then games and streak on the smaller 85%-of-that tier. SIZE_BOOST bumps both tiers up 15%
// across the board (literal request), applied after the cascade so the relative 15%-smaller gap
// between the two rows is unaffected. STAT_BOOST then lifts only the games/streak pair a further
// 5% (literal request), deliberately narrowing that gap rather than preserving it.
const TIER_STEP = 0.85;
const SIZE_BOOST = 1.15;
const STAT_BOOST = 1.05;
function scaleForSlot(slot: HallOfFameSlot): number {
  if (slot.kind === "rank") return TIER_STEP * SIZE_BOOST;
  return TIER_STEP ** 2 * SIZE_BOOST * STAT_BOOST;
}

function slotKey(slot: HallOfFameSlot): string {
  return slot.kind === "rank" ? `rank${slot.position}` : slot.kind;
}

function slotLabel(slot: HallOfFameSlot): string {
  if (slot.kind === "rank") {
    switch (slot.position) {
      case 1:
        return "1st Place";
      case 2:
        return "2nd Place";
      case 3:
        return "3rd Place";
    }
  }
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
  const displayBand: DisplayBand | null = slot.player ? slot.player.band : null;
  const scale = scaleForSlot(slot);
  // A slot's player being in that season's top 3 (see hallOfFame.ts, `inTopThree`) shows the Prism
  // icon in place of their band icon, even for an Unranked (null-band) top-3 player.
  const showPrismIcon = slot.player?.inTopThree ?? false;

  return (
    <div
      className={`flex flex-col items-center rounded-xl text-center text-[#161616] shadow-lg ${SLOT_BG[slotKey(slot)]}`}
      style={{ width: `${10 * scale}rem`, padding: `${1 * scale}rem`, gap: `${0.375 * scale}rem` }}
    >
      <span className="font-bold uppercase tracking-wide opacity-70" style={{ fontSize: `${10 * scale}px` }}>
        {slotLabel(slot)}
      </span>
      {slot.player ? (
        <>
          {/* Every Hall of Fame slot is a celebrated achievement, so every avatar here — podium
              and both stat slots alike — gets the same golden halo. */}
          <PlayerAvatar avatarUrl={slot.player.avatarUrl} alt={slot.player.displayName} scale={scale} glow />
          <span className="max-w-full truncate font-semibold" style={{ fontSize: `${0.875 * scale}rem` }}>
            {formatDisplayName(slot.player.displayName)}
          </span>
          {(showPrismIcon || displayBand) && (
            <img
              src={showPrismIcon ? PRISM_ICON_PATH : getRankIconPath(displayBand)}
              alt={showPrismIcon ? "Prism" : getRankLabel(displayBand)}
              title={showPrismIcon ? "Prism — top 3 this season" : getRankLabel(displayBand)}
              className="object-contain"
              style={{ width: `${1.5 * scale}rem`, height: `${1.5 * scale}rem` }}
            />
          )}
          <span className="font-medium opacity-80" style={{ fontSize: `${0.75 * scale}rem` }}>
            {slotValue(slot, mmrScale, mmrShift)}
          </span>
        </>
      ) : (
        <span className="py-4 font-medium opacity-70" style={{ fontSize: `${0.75 * scale}rem` }}>
          No data yet
        </span>
      )}
    </div>
  );
}
