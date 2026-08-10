import PlayerAvatar from "./PlayerAvatar";
import { getRankIconPath, getRankLabel, type DisplayBand } from "@/lib/leaderboard/rankIcon";
import type { MatchHistoryEntry, MatchHistoryPlayer } from "@/lib/leaderboard/history";

// Team A = the "Team Blue" voice channel, Team B = "Team Orange" (createVoiceChannels, see
// CLAUDE.md "Voice channels"). Reuses the site's existing --accent (orange) / --accent-secondary
// (blue) tokens rather than inventing new colors, so this stays visually consistent with the rest
// of the brand.
const ORANGE = "var(--accent)";
const BLUE = "var(--accent-secondary)";

function applyMMRTransform(mmr: number, scale: number, shift: number): number {
  return mmr * scale + shift;
}

function PlayerRow({
  player,
  mmrScale,
  mmrShift,
  align,
}: {
  player: MatchHistoryPlayer;
  mmrScale: number;
  mmrShift: number;
  align: "left" | "right";
}) {
  const displayBand: DisplayBand | null = player.isPrism ? "Prism" : player.band;
  const displayMmr = Math.round(applyMMRTransform(player.mmr, mmrScale, mmrShift));

  const bandBlock = (
    <div className="flex w-12 shrink-0 flex-col items-center text-center">
      <img
        src={getRankIconPath(displayBand)}
        alt={getRankLabel(displayBand)}
        title={getRankLabel(displayBand)}
        className="h-6 w-6 object-contain"
      />
      <span className="text-[11px] text-muted">{displayMmr}</span>
    </div>
  );

  const nameBlock = (
    <div className="flex min-w-0 items-center">
      <PlayerAvatar avatarUrl={player.avatarUrl} alt={player.displayName} />
      <span className="truncate text-sm font-medium text-foreground">{player.displayName}</span>
    </div>
  );

  // Band/MMR always renders on the card's outer edge — the far-left column puts it first, the
  // far-right column puts it last — with the avatar/name always staying nearest the "vs" middle.
  return (
    <div className="flex items-center justify-between gap-2">
      {align === "left" ? (
        <>
          {bandBlock}
          {nameBlock}
        </>
      ) : (
        <>
          {nameBlock}
          {bandBlock}
        </>
      )}
    </div>
  );
}

export default function MatchHistoryCard({
  match,
  mmrScale,
  mmrShift,
}: {
  match: MatchHistoryEntry;
  mmrScale: number;
  mmrShift: number;
}) {
  const pctLeft = Math.round((1 - match.expectedA) * 100);
  const pctRight = 100 - pctLeft;
  const leftWon = match.winnerTeam === "B";
  const rightWon = match.winnerTeam === "A";
  const playedAt = new Date(match.playedAt);

  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-4">
      <div className="mb-2 flex items-center justify-between text-xs text-muted">
        <span>
          {match.matchNumber !== null ? `Match #${match.matchNumber}` : "Match"} ·{" "}
          {match.queueType === "rank" ? "Rank Queue" : "Universal Queue"}
        </span>
        {/* Locale/timezone-dependent formatting can differ between server render and the
            browser's own locale — suppress the one-time hydration mismatch warning rather than
            deferring the whole date to a post-mount effect. */}
        <span suppressHydrationWarning>
          {playedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
        </span>
      </div>

      <div className="mb-1.5 flex items-center justify-between text-sm font-semibold">
        <span style={{ color: ORANGE }}>Orange</span>
        <span style={{ color: BLUE }}>Blue</span>
      </div>

      <div className="relative mb-4 h-3 w-full overflow-hidden rounded-full">
        <div className="flex h-full w-full">
          <div style={{ width: `${pctLeft}%`, background: ORANGE }} />
          <div style={{ width: `${pctRight}%`, background: BLUE }} />
        </div>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] font-semibold text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]">
          {pctLeft}%
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <div className={`space-y-2 rounded-lg border-2 p-2 ${leftWon ? "border-gold" : "border-transparent"}`}>
          {match.teamB.map((p) => (
            <PlayerRow key={p.playerId} player={p} mmrScale={mmrScale} mmrShift={mmrShift} align="left" />
          ))}
        </div>
        <div className="px-1 text-xs font-semibold text-muted">vs</div>
        <div className={`space-y-2 rounded-lg border-2 p-2 ${rightWon ? "border-gold" : "border-transparent"}`}>
          {match.teamA.map((p) => (
            <PlayerRow key={p.playerId} player={p} mmrScale={mmrScale} mmrShift={mmrShift} align="right" />
          ))}
        </div>
      </div>
    </div>
  );
}
