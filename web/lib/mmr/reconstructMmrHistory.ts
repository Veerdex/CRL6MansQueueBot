// Best-effort backfill of series_players.mmr_before for series reported before migration
// 0032_series_players_mmr_before.sql existed (see CLAUDE.md, "Match History" / the backfill
// script's own header comment for the full design rationale). Pure function, no DB/Discord I/O,
// so it's testable in isolation and reused as-is by web/scripts/backfill-mmr-before.ts.
//
// Approach: replay every player's MMR forward from 0 (MMR's real starting value) through a single
// chronologically-ordered timeline of events — series reports (both queue types) and admin
// /admin adjust-mmr corrections — snapshotting each series' participants' pre-report MMR along the
// way, and applying the real season-close soft-reset decay formula (imported directly from
// seasonClose.ts, not reimplemented) at each season boundary.
//
// Deliberately NOT modeled (see CLAUDE.md's admission that an exact backfill isn't possible):
// - /admin unreport: the reversed series is status='void', so it's excluded from the
//   status='reported' query the caller feeds in here — its effect self-cancels by omission.
// - /admin correct-report: not specially parsed. The caller reads each series' CURRENT (already
//   corrected, if applicable) series_players.mmr_delta directly, so a correction's effect is
//   already baked into the value this module replays — the only imprecision is using the
//   series' original reported_at as its timeline position rather than the later correction time.
import { decayMmr, computeSafeMedian } from "./seasonDecay";

export interface SeriesBatchInput {
  seriesId: string;
  seasonId: string;
  reportedAt: string;
  isRank: boolean;
  players: { playerId: string; mmrDelta: number }[];
}

export interface AdminAdjustInput {
  playerId: string;
  at: string;
  newMmr: number;
}

// Only seasons that have already closed (is_active = false) belong here — the currently active
// season has no decay to reconstruct yet. Ascending season_number order is not required by the
// caller; this module sorts internally.
export interface SeasonInput {
  seasonId: string;
  seasonNumber: number;
}

export interface SeasonHistoryCheckpoint {
  seasonId: string;
  playerId: string;
  mmrAtClose: number;
}

export interface ReconstructMmrHistoryInput {
  playerIds: string[];
  seriesBatches: SeriesBatchInput[];
  adminAdjustments: AdminAdjustInput[];
  seasons: SeasonInput[];
  seasonHistoryCheckpoints: SeasonHistoryCheckpoint[];
  decayFactor: number;
  placementGamesRequired: number;
}

export interface DriftWarning {
  seasonId: string;
  playerId: string;
  simulatedPreDecayMmr: number;
  recordedMmrAtClose: number;
  drift: number;
}

export interface ReconstructMmrHistoryResult {
  // seriesId -> playerId -> reconstructed mmr_before value.
  mmrBeforeBySeries: Map<string, Map<string, number>>;
  finalMmrByPlayer: Map<string, number>;
  // Running high-water mark of each player's mmr, tracked only from the moment they cross
  // placementGamesRequired onward — mirrors bands.ts's recomputeBands() seeding peak_mmr at the
  // instant a player places, and report.ts/adminTools.ts only bumping it while is_placed. A
  // player who never reaches placement within this timeline has no entry (peak is meaningless
  // while unranked — see CLAUDE.md's "Peak MMR" section).
  peakMmrByPlayer: Map<string, number>;
  // Divergences between the simulation and season_history's recorded ground truth at a season
  // close — the simulation snaps to the recorded value when this happens (see runDecayForSeason
  // below), so drift never compounds past one season boundary, but it's surfaced here as a
  // diagnostic since a nonzero drift usually means an unmodeled event (e.g. a mid-season admin
  // correction this module doesn't have audit-log coverage for) happened to that player.
  driftWarnings: DriftWarning[];
}

const DRIFT_EPSILON = 0.01;

type TimelineEvent =
  | {
      kind: "series";
      at: number;
      seasonId: string;
      seriesId: string;
      isRank: boolean;
      players: { playerId: string; mmrDelta: number }[];
    }
  | { kind: "admin_adjust"; at: number; playerId: string; newMmr: number };

export function reconstructMmrHistory(input: ReconstructMmrHistoryInput): ReconstructMmrHistoryResult {
  const events: TimelineEvent[] = [
    ...input.seriesBatches.map(
      (s): TimelineEvent => ({
        kind: "series",
        at: Date.parse(s.reportedAt),
        seasonId: s.seasonId,
        seriesId: s.seriesId,
        isRank: s.isRank,
        players: s.players,
      }),
    ),
    ...input.adminAdjustments.map(
      (a): TimelineEvent => ({
        kind: "admin_adjust",
        at: Date.parse(a.at),
        playerId: a.playerId,
        newMmr: a.newMmr,
      }),
    ),
  ];
  // Array.prototype.sort is stable (ES2019+), so events with an identical timestamp keep their
  // original relative order rather than being shuffled.
  events.sort((a, b) => a.at - b.at);

  // Anchor each closing season's decay pass to the index of the LAST series event belonging to
  // that season, rather than trying to compare against seasons.end_date — which is a date-only
  // string (see CLAUDE.md's /newseason note), too imprecise to order reliably against same-day
  // series reports. Since seasons never interleave in real usage (the app only opens season N+1
  // after season N is closed), every season-N series necessarily sorts before every season-(N+1)
  // series in the global timeline, making this index-based anchor exact.
  const lastIndexForSeason = new Map<string, number>();
  events.forEach((e, i) => {
    if (e.kind === "series") lastIndexForSeason.set(e.seasonId, i);
  });

  const orderedSeasons = [...input.seasons].sort((a, b) => a.seasonNumber - b.seasonNumber);

  // A season with zero series ever reported still needs its decay pass reconstructed (season
  // close decays every currently-placed player, not just that season's participants) — anchored
  // right after the previous closing season's decay point as a reasonable fallback, since there's
  // no series event to anchor to directly.
  const decaysByIndex = new Map<number, string[]>();
  let fallbackIndex = -1;
  for (const season of orderedSeasons) {
    const idx = lastIndexForSeason.get(season.seasonId) ?? fallbackIndex;
    const list = decaysByIndex.get(idx);
    if (list) list.push(season.seasonId);
    else decaysByIndex.set(idx, [season.seasonId]);
    fallbackIndex = idx;
  }

  const mmr = new Map<string, number>(input.playerIds.map((id) => [id, 0]));
  const rankGamesPlayed = new Map<string, number>(input.playerIds.map((id) => [id, 0]));
  const mmrBeforeBySeries = new Map<string, Map<string, number>>();
  const driftWarnings: DriftWarning[] = [];
  const placed = new Set<string>();
  const peakMmr = new Map<string, number>();

  // Placement transition, or an already-placed player's mmr moving — mirrors bands.ts seeding
  // peak_mmr at the instant of placement (Math.max against a 0 default) and report.ts/
  // adminTools.ts only bumping it thereafter while is_placed.
  const touchPeak = (playerId: string) => {
    const current = mmr.get(playerId) ?? 0;
    if (!placed.has(playerId)) {
      if ((rankGamesPlayed.get(playerId) ?? 0) < input.placementGamesRequired) return;
      placed.add(playerId);
      peakMmr.set(playerId, Math.max(current, 0));
    } else {
      peakMmr.set(playerId, Math.max(peakMmr.get(playerId) ?? 0, current));
    }
  };

  const checkpointByKey = new Map<string, number>();
  for (const c of input.seasonHistoryCheckpoints) {
    checkpointByKey.set(`${c.seasonId}:${c.playerId}`, c.mmrAtClose);
  }

  const runDecayForSeason = (seasonId: string) => {
    // Snap to season_history's recorded pre-decay MMR where we have it — genuine ground truth
    // that bounds simulation drift to within a single season rather than letting it compound.
    for (const playerId of input.playerIds) {
      const checkpoint = checkpointByKey.get(`${seasonId}:${playerId}`);
      if (checkpoint === undefined) continue;
      const simulated = mmr.get(playerId) ?? 0;
      if (Math.abs(simulated - checkpoint) > DRIFT_EPSILON) {
        driftWarnings.push({
          seasonId,
          playerId,
          simulatedPreDecayMmr: simulated,
          recordedMmrAtClose: checkpoint,
          drift: checkpoint - simulated,
        });
      }
      mmr.set(playerId, checkpoint);
    }

    // "Currently placed" at a past moment is approximated via each player's own simulated
    // cumulative rank-games-played count against the CURRENT placement_games_required config
    // value — historical config changes aren't tracked, so this is an accepted approximation.
    const placedIds = input.playerIds.filter((id) => (rankGamesPlayed.get(id) ?? 0) >= input.placementGamesRequired);
    if (placedIds.length === 0) return;
    const median = computeSafeMedian(placedIds.map((id) => mmr.get(id) ?? 0));
    for (const id of placedIds) {
      mmr.set(id, decayMmr(mmr.get(id) ?? 0, median, input.decayFactor));
    }
  };

  const preLoopSeasons = decaysByIndex.get(-1);
  if (preLoopSeasons) for (const seasonId of preLoopSeasons) runDecayForSeason(seasonId);

  events.forEach((e, i) => {
    if (e.kind === "series") {
      const before = new Map<string, number>();
      for (const p of e.players) before.set(p.playerId, mmr.get(p.playerId) ?? 0);
      mmrBeforeBySeries.set(e.seriesId, before);

      for (const p of e.players) {
        mmr.set(p.playerId, (mmr.get(p.playerId) ?? 0) + p.mmrDelta);
        if (e.isRank) rankGamesPlayed.set(p.playerId, (rankGamesPlayed.get(p.playerId) ?? 0) + 1);
        touchPeak(p.playerId);
      }
    } else {
      mmr.set(e.playerId, e.newMmr);
      touchPeak(e.playerId);
    }

    const seasonIds = decaysByIndex.get(i);
    if (seasonIds) for (const seasonId of seasonIds) runDecayForSeason(seasonId);
  });

  return { mmrBeforeBySeries, finalMmrByPlayer: mmr, peakMmrByPlayer: peakMmr, driftWarnings };
}
