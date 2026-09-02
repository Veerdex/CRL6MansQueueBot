"use client";

import { useMemo, useRef, useState } from "react";
import LeaderboardTable, { type MainBoardRow } from "./LeaderboardTable";
import StatsBoard, { type StatsPlayer } from "./StatsBoard";
import PlayerAvatar from "./PlayerAvatar";
import { computeStats, filterGames, FLAME_THRESHOLD, COLD_THRESHOLD } from "@/lib/leaderboard/stats";
import { getRankIconPath, getRankLabel, type DisplayBand } from "@/lib/leaderboard/rankIcon";
import { formatDisplayName } from "@/lib/leaderboard/formatName";
import { playTap } from "@/lib/sound";
import type { CompletedGame, PlayerWithGames } from "@/lib/leaderboard/queries";
import type { SeasonHistoryRow, SeasonRow } from "@/lib/supabase/types";

// Hex, not rgb() — these get a hex alpha suffix appended below (e.g. `${color}2e`), which only
// forms a valid CSS color (#RRGGBBAA) when the base is hex; appending to `rgb(...)` is invalid
// CSS and gets silently dropped, which is why the glow wasn't rendering.
function getBandColor(band: DisplayBand | null): string {
  switch (band) {
    case "Iron":
      return "#7d7d7d";
    case "Garnet":
      return "#ff0000";
    case "Emerald":
      return "#008000";
    case "Sapphire":
      return "#0000ff";
    case "Prism":
      return "#c084fc";
    default:
      // Unranked/null: gray
      return "#464646";
  }
}

type ViewMode = "top-players" | "main" | "all-time";

// Which tabs the segmented control actually offers. "top-players" is deliberately absent — the
// view is disabled, not deleted: every piece that renders it (topPlayersRows,
// historicalTopPlayersRows, displayedTopPlayersRows and the `viewMode === "top-players"` block
// below) is left intact and simply unreachable, so re-enabling is a one-token change here rather
// than a rebuild. `useState<ViewMode>("main")` already defaults to a tab that's still listed, so
// nothing can land on the hidden view.
const ENABLED_VIEW_MODES = ["main", "all-time"] as const satisfies readonly ViewMode[];

// Keyed by the full ViewMode union rather than only the enabled ones, so the disabled tab keeps
// its label and re-enabling stays a one-token edit above.
const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  "top-players": "Top Players",
  main: "Main",
  "all-time": "All-Time Stats",
};

interface UnifiedLeaderboardProps {
  players: PlayerWithGames[];
  seasons: SeasonRow[];
  seasonHistory: SeasonHistoryRow[];
  mmrScale: number;
  mmrShift: number;
}

function applyMMRTransform(mmr: number, scale: number, shift: number): number {
  return mmr * scale + shift;
}

// Sorts purely on placement then MMR — band is not a ranking priority. All placed players
// (any band) rank strictly by MMR against each other regardless of band; unplaced players
// always group after every placed player (per CLAUDE.md: "the only separation is between
// unbanded and banded players"), then MMR breaks ties within that group too.
function compareLeaderboardRank(a: PlayerWithGames, b: PlayerWithGames): number {
  const placedDiff = Number(b.player.is_placed) - Number(a.player.is_placed);
  if (placedDiff !== 0) return placedDiff;
  const mmrDiff = b.player.mmr - a.player.mmr;
  if (mmrDiff !== 0) return mmrDiff;
  return a.player.id.localeCompare(b.player.id);
}

// compareLeaderboardRank's archived twin, for past-season boards. `season_rank` is the order
// seasonClose.ts baked in — MMR desc, then season games, then id, with no placed-first tier — so
// replaying it verbatim seats unplaced finishers above banded ones, which the live board never
// does. The column itself stays the record of record and is deliberately not rewritten: Hall of
// Fame podiums and the nickname medal sweep both read `season_rank <= 3` straight off it, and
// all-time rating re-ranks the placed players out of it. The tier is applied here at read time
// instead. Final tiebreak is `season_rank` rather than a re-derived games-played count, since it
// already encodes exactly that tiebreak from close.
function compareArchivedRank(a: SeasonHistoryRow, b: SeasonHistoryRow): number {
  const bandedDiff = Number(b.band_at_close !== null) - Number(a.band_at_close !== null);
  if (bandedDiff !== 0) return bandedDiff;
  const mmrDiff = b.mmr_at_close - a.mmr_at_close;
  if (mmrDiff !== 0) return mmrDiff;
  return a.season_rank - b.season_rank;
}

export default function UnifiedLeaderboard({
  players,
  seasons,
  seasonHistory,
  mmrScale,
  mmrShift,
}: UnifiedLeaderboardProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("main");

  const eligiblePlayers = players.filter(({ player }) => player.total_games_played >= 1);
  const playersById = useMemo(() => new Map(players.map((p) => [p.player.id, p.player])), [players]);
  // Per-season W/L is not archived (season_history carries only games played), so a past-season
  // Main board has to recompute it from the player's own game log, filtered to that season.
  const gamesById = useMemo(() => new Map(players.map((p) => [p.player.id, p.games])), [players]);

  const sortedSeasons = useMemo(
    () => [...seasons].sort((a, b) => a.season_number - b.season_number),
    [seasons],
  );
  const minSeasonNumber = sortedSeasons[0]?.season_number ?? 1;
  const maxSeasonNumber = sortedSeasons[sortedSeasons.length - 1]?.season_number ?? 1;
  const activeSeason = seasons.find((s) => s.is_active) ?? null;
  const activeSeasonNumber = activeSeason?.season_number ?? maxSeasonNumber;
  // Undefined only if no season is active at all (shouldn't happen — one always is). filterGames
  // treats an undefined seasonId as "no filter", so that degenerate case falls back to lifetime
  // totals, the same direction isCurrentSeason's own `?? true` fallback leans.
  const activeSeasonId = activeSeason?.id;

  // Prism alumni: everyone who finished the most recently *closed* season inside that season's
  // Prism cut, read straight off the archived `made_top10` flag seasonClose.ts writes. This is
  // what the avatar glow has always meant, and it has to stay archive-sourced now that Prism is
  // a live rank again — the season soft reset clears `is_prism`, so sourcing the glow from it
  // would erase every alumnus the moment a season closes. Empty until the first season closes.
  const prismAlumniIds = useMemo(() => {
    const lastClosed = [...seasons]
      .filter((s) => !s.is_active)
      .sort((a, b) => b.season_number - a.season_number)[0];
    if (!lastClosed) return new Set<string>();
    return new Set(
      seasonHistory.filter((h) => h.season_id === lastClosed.id && h.made_top10).map((h) => h.player_id),
    );
  }, [seasons, seasonHistory]);

  // Season browser: number input + arrows, defaulting to the current season. Shared by the Top
  // Players and Main views — one selection, so switching views keeps the season you were reading.
  const [selectedSeasonNumber, setSelectedSeasonNumber] = useState(activeSeasonNumber);
  const [seasonInputDraft, setSeasonInputDraft] = useState(String(activeSeasonNumber));
  const seasonInputRef = useRef<HTMLInputElement>(null);

  const selectedSeason = sortedSeasons.find((s) => s.season_number === selectedSeasonNumber) ?? null;
  // No seasons at all (shouldn't happen in practice — a season is always active) falls back to
  // the live board, same as before this feature existed.
  const isCurrentSeason = selectedSeason?.is_active ?? true;

  function flashInvalidSeasonInput() {
    const el = seasonInputRef.current;
    if (!el) return;
    // Remove-then-reflow-then-add so a rapid repeat press restarts the animation instead of
    // being a no-op (the browser otherwise treats re-adding an already-present class as nothing).
    el.classList.remove("field-invalid-flash");
    void el.offsetWidth;
    el.classList.add("field-invalid-flash");
  }

  function goToSeason(seasonNumber: number) {
    setSelectedSeasonNumber(seasonNumber);
    setSeasonInputDraft(String(seasonNumber));
  }

  function handlePrevSeason() {
    playTap();
    if (selectedSeasonNumber <= minSeasonNumber) {
      flashInvalidSeasonInput();
      return;
    }
    goToSeason(selectedSeasonNumber - 1);
  }

  function handleNextSeason() {
    playTap();
    if (selectedSeasonNumber >= maxSeasonNumber) {
      flashInvalidSeasonInput();
      return;
    }
    goToSeason(selectedSeasonNumber + 1);
  }

  function commitSeasonInput(raw: string) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      flashInvalidSeasonInput();
      setSeasonInputDraft(String(selectedSeasonNumber));
      return;
    }
    if (parsed < minSeasonNumber || parsed > maxSeasonNumber) {
      flashInvalidSeasonInput();
    }
    goToSeason(Math.min(maxSeasonNumber, Math.max(minSeasonNumber, parsed)));
  }

  // Rendered by both season-aware views. The single seasonInputRef is safe because the view
  // branches are mutually exclusive, so only one of these inputs is ever mounted.
  function renderSeasonPicker() {
    return (
      // Three columns with equal 1fr gutters so the middle one lands on the page's true center;
      // the "Season" label sits in the left gutter instead of in the centered group, and the empty
      // right gutter balances it. Centering the label and control together as one flex row (what
      // this was) pushed the input right of center by half the label's width.
      <div className="mb-4 grid grid-cols-[1fr_auto_1fr] items-center">
        <span className="justify-self-end whitespace-nowrap pr-2 text-sm font-medium text-muted">
          Season
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-icon"
            onClick={handlePrevSeason}
            aria-label="Previous season"
          >
            ‹
          </button>
          <input
            ref={seasonInputRef}
            type="number"
            inputMode="numeric"
            className="field w-16 py-1.5 text-center text-sm font-semibold"
            value={seasonInputDraft}
            onChange={(e) => setSeasonInputDraft(e.target.value)}
            onBlur={(e) => commitSeasonInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            aria-label="Season number"
          />
          <button
            type="button"
            className="btn-icon"
            onClick={handleNextSeason}
            aria-label="Next season"
          >
            ›
          </button>
        </div>
        <span aria-hidden />
      </div>
    );
  }

  // Top Players view: simplified list — unranked players are excluded, not just unbanded on
  // the Main board, since this view is specifically a ranking by band/MMR.
  const topPlayersRows = useMemo(() => {
    const sorted = eligiblePlayers
      .filter(({ player }) => player.is_placed)
      .slice()
      .sort(compareLeaderboardRank)
      .slice(0, 20);
    return sorted.map((p, idx) => ({
      position: idx + 1,
      displayName: p.player.display_name,
      avatarUrl: p.player.avatar_url,
      band: p.player.is_placed ? p.player.band : null,
      isPrism: p.player.is_prism,
      wasPrism: prismAlumniIds.has(p.player.id),
      mmr: p.player.mmr,
    }));
  }, [eligiblePlayers, prismAlumniIds]);

  // Past-season standings come from the archived season_history rows, re-tiered for display by
  // compareArchivedRank (banded first) rather than replaying the archived season_rank order.
  // Avatar and display name are the player's current live ones (same precedent as Hall of Fame —
  // they're identity, not standing). Band is the archived `band_at_close`, so a past season shows
  // the band actually held then rather than whatever the player wears today.
  // Prism itself comes from the archived `made_top10` flag — who actually held Prism at that
  // close, under the prism_top_n/top10_min_games in force then — rather than today's live
  // `is_prism` (which describes this season) or a re-cut of the list with today's config, either
  // of which would silently rewrite past seasons if an admin ever retunes those.
  const historicalTopPlayersRows = useMemo(() => {
    if (!selectedSeason) return [];
    const sorted = seasonHistory
      // Banded finishers only, mirroring the live view's `player.is_placed` filter — this view is
      // specifically a ranking by band/MMR, so an unranked finisher has no place in it.
      .filter((h) => h.season_id === selectedSeason.id && h.band_at_close !== null)
      .sort(compareArchivedRank)
      .slice(0, 20);
    return sorted
      .map((h, idx) => {
        const player = playersById.get(h.player_id);
        if (!player) return null;
        return {
          position: idx + 1,
          displayName: player.display_name,
          avatarUrl: player.avatar_url,
          band: h.band_at_close,
          isPrism: h.made_top10,
          // A past-season board glows for that season's own Prism finishers, not the current
          // alumni set — the row already *is* the archived standing.
          wasPrism: h.made_top10,
          mmr: h.mmr_at_close,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
  }, [seasonHistory, selectedSeason, playersById]);

  const displayedTopPlayersRows = isCurrentSeason ? topPlayersRows : historicalTopPlayersRows;

  // Main view: current leaderboard
  const mainBoardRows = useMemo(() => {
    const sorted = eligiblePlayers.slice().sort(compareLeaderboardRank);
    const rows: MainBoardRow[] = sorted.map(({ player, games }) => {
      // Every column here is the active season's only — W/L/win-rate and the streak flags alike.
      // Each season keeps its own record and the All-Time Stats view carries the cross-season
      // totals. The streaks are scoped for the same reason the bot's are (lib/discord/streaks.ts,
      // which counts within the active season and pays its MMR bonus off that): a lifetime flame
      // here would mark a player on-fire on the site while the bot no longer honors the streak.
      const seasonStats = computeStats(filterGames(games, { seasonId: activeSeasonId }));
      return {
        playerId: player.id,
        displayName: player.display_name,
        avatarUrl: player.avatar_url,
        band: player.is_placed ? player.band : null,
        isPrism: player.is_prism,
        wasPrism: prismAlumniIds.has(player.id),
        mmr: player.mmr,
        wins: seasonStats.wins,
        losses: seasonStats.losses,
        winRate: seasonStats.winRate,
        onFire: seasonStats.currentStreak.type === "W" && seasonStats.currentStreak.count >= FLAME_THRESHOLD,
        coldStreak: seasonStats.currentStreak.type === "L" && seasonStats.currentStreak.count >= COLD_THRESHOLD,
      };
    });
    return rows;
  }, [eligiblePlayers, prismAlumniIds, activeSeasonId]);

  // Past-season Main board: the full archived standing, on exactly the same sourcing rules as
  // historicalTopPlayersRows above — order, MMR and band from the season_history snapshot, Prism
  // from that season's own made_top10, avatar/display name from the live player row. The difference is the W/L/win-rate/streak columns, which
  // season_history doesn't carry: they're recomputed from each player's own game log filtered to
  // this season, matching the live board's own season-scoped W/L. The streak columns are
  // season-scoped here too, where the live board deliberately keeps them lifetime: a closed
  // season has no live bot streak to contradict, and a lifetime flame next to a two-season-old
  // MMR would describe nothing that happened then.
  const historicalMainBoardRows = useMemo(() => {
    if (!selectedSeason) return [];
    // Resolve live players before numbering, so a finisher whose player row has since gone away
    // leaves no hole in the positions below them.
    const entries = seasonHistory
      .filter((h) => h.season_id === selectedSeason.id)
      .sort(compareArchivedRank)
      .map((h) => ({ h, player: playersById.get(h.player_id) }))
      .filter((e): e is { h: SeasonHistoryRow; player: PlayerWithGames["player"] } => e.player !== undefined);
    return entries
      .map(({ h, player }, idx) => {
        const seasonStats = computeStats(filterGames(gamesById.get(h.player_id) ?? [], { seasonId: selectedSeason.id }));
        const row: MainBoardRow = {
          // This list's index, not the archived `season_rank` — once banded players are tiered
          // ahead of unranked ones the archived number no longer matches where the row actually
          // sits, and a visibly non-monotonic position column reads as a bug. `season_rank`
          // remains the archived record; this is only what the board displays.
          position: idx + 1,
          playerId: player.id,
          displayName: player.display_name,
          avatarUrl: player.avatar_url,
          band: h.band_at_close,
          isPrism: h.made_top10,
          // A past-season board glows for that season's own Prism finishers, matching Top Players.
          wasPrism: h.made_top10,
          mmr: h.mmr_at_close,
          wins: seasonStats.wins,
          losses: seasonStats.losses,
          winRate: seasonStats.winRate,
          onFire: seasonStats.currentStreak.type === "W" && seasonStats.currentStreak.count >= FLAME_THRESHOLD,
          coldStreak: seasonStats.currentStreak.type === "L" && seasonStats.currentStreak.count >= COLD_THRESHOLD,
        };
        return row;
      });
  }, [seasonHistory, selectedSeason, playersById, gamesById]);

  const displayedMainBoardRows = isCurrentSeason ? mainBoardRows : historicalMainBoardRows;

  // All-Time Stats view
  const statsPlayers = useMemo(() => {
    return eligiblePlayers.map(({ player, games }) => ({
      playerId: player.id,
      displayName: player.display_name,
      avatarUrl: player.avatar_url,
      games,
      peakMmr: player.peak_mmr,
    }));
  }, [eligiblePlayers]);

  function selectView(mode: ViewMode) {
    playTap();
    setViewMode(mode);
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10">
      <h1 className="animate-in mb-6 text-2xl font-bold text-foreground">Leaderboard</h1>

      {/* Settings Row */}
      <div className="animate-in mb-6 flex flex-wrap items-center gap-4">
        {/* View Mode Selection */}
        <div className="segmented">
          {ENABLED_VIEW_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              data-active={viewMode === mode}
              className="segmented-btn"
              onClick={() => selectView(mode)}
            >
              {VIEW_MODE_LABELS[mode]}
            </button>
          ))}
        </div>
      </div>

      <div className="panel animate-in-delay-1 p-4 sm:p-6">
        {viewMode === "top-players" && (
          <div>
            {renderSeasonPicker()}
            <p className="mb-4 text-sm text-muted">
              {isCurrentSeason
                ? "Top players by MMR ranking. Rank Queue standing only."
                : `Final standings for Season ${selectedSeasonNumber}.`}
            </p>
            {displayedTopPlayersRows.length === 0 ? (
              <div className="py-10 text-center text-muted">No players yet.</div>
            ) : (
              <div className="space-y-2">
                {displayedTopPlayersRows.map((row) => {
                  // Prism is a live rank again (see CLAUDE.md, "Bands / ranks"), so it displaces
                  // the player's underlying band in the icon, label and row tint, and the same
                  // flag drives the gold treatment — holding Prism *is* the live top-N cut.
                  const displayBand: DisplayBand | null = row.isPrism ? "Prism" : row.band;
                  const showPrismStyling = row.isPrism;
                  // Unranked (no band) gets no row tint — nothing to color it by. (Distinct from
                  // the avatar glow below, which tracks last season's Prism finishers.)
                  const bandColor = displayBand === null ? null : getBandColor(displayBand);
                  const rowGlow = bandColor
                    ? `radial-gradient(ellipse 70% 100% at 0% 50%, ${bandColor}2e 0%, transparent 75%)`
                    : undefined;
                  return (
                    <div
                      key={row.position}
                      className={`row-hover flex items-center gap-4 rounded-lg px-4 py-3 ${showPrismStyling ? "gold-row" : ""}`}
                      style={rowGlow ? { backgroundImage: rowGlow } : undefined}
                    >
                      <div className={`min-w-fit text-sm font-semibold ${showPrismStyling ? "text-gold" : "text-muted"}`}>
                        #{row.position}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center text-lg font-bold text-foreground">
                          <PlayerAvatar
                            avatarUrl={row.avatarUrl}
                            alt={row.displayName}
                            glow={row.wasPrism}
                          />
                          <span className="truncate">{formatDisplayName(row.displayName)}</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <img
                          src={getRankIconPath(displayBand)}
                          alt={getRankLabel(displayBand)}
                          title={getRankLabel(displayBand)}
                          className="h-6 w-6 object-contain"
                        />
                      </div>
                      <div className="text-right min-w-fit">
                        <div className={`text-sm font-semibold ${showPrismStyling ? "text-gold" : "text-foreground"}`}>
                          {Math.round(applyMMRTransform(row.mmr, mmrScale, mmrShift))} MMR
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {viewMode === "main" && (
          <div>
            {renderSeasonPicker()}
            <p className="mb-4 text-sm text-muted">
              {isCurrentSeason ? "Rank Queue standing." : `Final standings for Season ${selectedSeasonNumber}.`}
            </p>
            {/* Remounted per season so the table's own page and search highlight reset —
                otherwise stepping back from page 3 of the live board into a shorter season lands
                on a blank page with no visible explanation. */}
            <LeaderboardTable
              key={isCurrentSeason ? "live" : selectedSeasonNumber}
              rows={displayedMainBoardRows}
              mmrScale={mmrScale}
              mmrShift={mmrShift}
            />
          </div>
        )}

        {viewMode === "all-time" && (
          <div>
            <p className="mb-4 text-sm text-muted">
              Click a column header to sort. All-time lifetime stats.
            </p>
            <StatsBoard
              players={statsPlayers}
              mode="all-time"
              // Threaded through only so "Current streak" resets at season boundaries — see
              // stats.ts's computeStats and /stats/all-time/page.tsx's identical comment.
              currentSeason={activeSeason ? { id: activeSeason.id, seasonNumber: activeSeason.season_number } : null}
              previousSeason={null}
              mmrScale={mmrScale}
              mmrShift={mmrShift}
            />
          </div>
        )}
      </div>
    </div>
  );
}
