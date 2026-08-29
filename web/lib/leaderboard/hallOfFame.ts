import "server-only";
import { createServerClient } from "../supabase/server";
import type { Band, PlayerRow, SeasonHistoryRow } from "../supabase/types";
import { getAllPlayersWithGames, getAllSeasons } from "./queries";
import { computeStats, filterGames } from "./stats";

export interface HallOfFamePlayer {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  band: Band | null;
  isPrism: boolean;
  // "In that season's top 5 standing" — purely presentational, computed fresh per season here.
  // Distinct from `isPrism` above (the live/archived prism_top_n achievement flag): a player can
  // land in this season's top 5 without being that season's Prism holder, and vice versa in a
  // season where prism_top_n differs from 5. Drives the Hall of Fame's Prism-icon override on
  // every slot (rank1-5, games, streak) that happens to be held by a top-5 player.
  inTopFive: boolean;
}

export type HallOfFameSlot =
  | { kind: "rank"; position: 1 | 2 | 3 | 4 | 5; player: HallOfFamePlayer | null; mmr: number }
  | { kind: "games"; player: HallOfFamePlayer | null; gamesPlayed: number }
  | { kind: "streak"; player: HallOfFamePlayer | null; streak: number };

export interface HallOfFameSeason {
  seasonId: string;
  seasonNumber: number;
  isActive: boolean;
  slots: HallOfFameSlot[]; // always length 7: rank1..rank5, games, streak
}

function toHofPlayer(player: PlayerRow, top5PlayerIds: Set<string>): HallOfFamePlayer {
  return {
    id: player.id,
    displayName: player.display_name,
    avatarUrl: player.avatar_url,
    band: player.band,
    isPrism: player.is_prism,
    inTopFive: top5PlayerIds.has(player.id),
  };
}

// Same standing tiebreak seasonClose.ts uses: MMR desc, then this-season games played desc, then
// player id asc as a final deterministic tiebreak.
function rankParticipants(
  entries: { player: PlayerRow; mmr: number; seasonGames: number }[],
): { player: PlayerRow; mmr: number }[] {
  return [...entries]
    .sort((a, b) => b.mmr - a.mmr || b.seasonGames - a.seasonGames || a.player.id.localeCompare(b.player.id))
    .map((e) => ({ player: e.player, mmr: e.mmr }));
}

// Picks the single highest-`value` entry (games played / win streak slots) — same tiebreak
// philosophy (value desc, then current mmr desc, then id asc). Null when nobody qualifies
// (value <= 0 for everyone, e.g. no Rank Queue games reported yet this season).
function pickTop<T extends { player: PlayerRow; value: number }>(entries: T[]): T | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort(
    (a, b) => b.value - a.value || b.player.mmr - a.player.mmr || a.player.id.localeCompare(b.player.id),
  );
  return sorted[0].value > 0 ? sorted[0] : null;
}

function buildSlots(
  top5: { player: PlayerRow; mmr: number }[],
  gamesWinner: { player: PlayerRow; value: number } | null,
  streakWinner: { player: PlayerRow; value: number } | null,
): HallOfFameSlot[] {
  const top5PlayerIds = new Set(top5.map((e) => e.player.id));
  const slots: HallOfFameSlot[] = [];
  for (let i = 0; i < 5; i++) {
    const entry = top5[i];
    slots.push({
      kind: "rank",
      position: (i + 1) as 1 | 2 | 3 | 4 | 5,
      player: entry ? toHofPlayer(entry.player, top5PlayerIds) : null,
      mmr: entry ? entry.mmr : 0,
    });
  }
  slots.push({
    kind: "games",
    player: gamesWinner ? toHofPlayer(gamesWinner.player, top5PlayerIds) : null,
    gamesPlayed: gamesWinner ? gamesWinner.value : 0,
  });
  slots.push({
    kind: "streak",
    player: streakWinner ? toHofPlayer(streakWinner.player, top5PlayerIds) : null,
    streak: streakWinner ? streakWinner.value : 0,
  });
  return slots;
}

// One Hall of Fame section per season (see CLAUDE.md, "Hall of Fame"): top 5 by final season
// standing (1st-3rd get podium gold/silver/bronze, 4th-5th a plain slot), plus a 6th slot for
// most games played that season (both queues, matching season_history's own definition) and a
// 7th for highest Rank Queue win streak reached that season. Any of these 7 slots whose player
// is also among that season's top 5 gets the Prism icon substituted in for their band icon (see
// HallOfFameSlotCard) — independent of the `is_prism` achievement flag, which tracks a different,
// separately-configured (`prism_top_n`) mechanic. Closed seasons read the archival
// `season_history` record (seasonClose.ts's permanent standings snapshot) for the
// rank/games-played slots; the still-active season has no season_history rows yet, so all slots
// are computed live off current data instead — which is also exactly why that section renders
// "greyed out / unconfirmed" on the page, since it can still change as the season progresses.
// Neither path filters `is_test_data`, matching the established precedent for read-side
// leaderboard-style queries (getAllPlayersWithGames, getMatchHistory, getHeadToHeadData) — see
// CLAUDE.md, "Match History".
export async function getHallOfFameData(): Promise<HallOfFameSeason[]> {
  const supabase = createServerClient();
  const [seasons, playersWithGames, { data: historyRows, error: historyError }] = await Promise.all([
    getAllSeasons(),
    getAllPlayersWithGames(),
    supabase.from("crl6mansqueuebot_season_history").select("*"),
  ]);
  if (historyError) throw historyError;
  if (seasons.length === 0) return [];

  const playersById = new Map(playersWithGames.map((pw) => [pw.player.id, pw.player]));
  const gamesByPlayerId = new Map(playersWithGames.map((pw) => [pw.player.id, pw.games]));

  const historyBySeasonId = new Map<string, SeasonHistoryRow[]>();
  for (const row of historyRows ?? []) {
    const list = historyBySeasonId.get(row.season_id);
    if (list) list.push(row);
    else historyBySeasonId.set(row.season_id, [row]);
  }

  // Current season always renders first regardless of numbering quirks, then the rest newest-first.
  const ordered = [...seasons].sort(
    (a, b) => (b.is_active ? 1 : 0) - (a.is_active ? 1 : 0) || b.season_number - a.season_number,
  );

  return ordered.map((season) => {
    if (season.is_active) {
      const participants = playersWithGames
        .map((pw) => ({
          player: pw.player,
          games: pw.games,
          seasonGames: filterGames(pw.games, { seasonId: season.id }).length,
        }))
        .filter((p) => p.seasonGames >= 1);

      const top5 = rankParticipants(
        participants.map((p) => ({ player: p.player, mmr: p.player.mmr, seasonGames: p.seasonGames })),
      ).slice(0, 5);

      const gamesWinner = pickTop(participants.map((p) => ({ player: p.player, value: p.seasonGames })));
      const streakWinner = pickTop(
        participants.map((p) => ({
          player: p.player,
          value: computeStats(filterGames(p.games, { seasonId: season.id })).longestWinStreak,
        })),
      );

      return {
        seasonId: season.id,
        seasonNumber: season.season_number,
        isActive: true,
        slots: buildSlots(top5, gamesWinner, streakWinner),
      };
    }

    const history = historyBySeasonId.get(season.id) ?? [];

    const top5 = [...history]
      .sort((a, b) => a.season_rank - b.season_rank)
      .slice(0, 5)
      .map((row) => {
        const player = playersById.get(row.player_id);
        return player ? { player, mmr: row.mmr_at_close } : null;
      })
      .filter((x): x is { player: PlayerRow; mmr: number } => x !== null);

    const gamesWinner = pickTop(
      history
        .map((row) => {
          const player = playersById.get(row.player_id);
          return player ? { player, value: row.season_games_played } : null;
        })
        .filter((x): x is { player: PlayerRow; value: number } => x !== null),
    );

    // No archived per-season win streak exists (season_history predates this feature) — derived
    // live from each participant's immutable reported-series history instead, scoped to that
    // season and Rank Queue only (matching the bot's own streak semantics elsewhere). Safe to
    // compute at read time no matter how long ago the season closed: win/loss results never
    // change after a series is reported, barring the already-accepted imprecision of
    // /admin unreport/correct-report not being modeled everywhere else in this codebase either.
    const streakWinner = pickTop(
      history
        .map((row) => {
          const player = playersById.get(row.player_id);
          const games = gamesByPlayerId.get(row.player_id);
          if (!player || !games) return null;
          const streak = computeStats(filterGames(games, { seasonId: season.id })).longestWinStreak;
          return { player, value: streak };
        })
        .filter((x): x is { player: PlayerRow; value: number } => x !== null),
    );

    return {
      seasonId: season.id,
      seasonNumber: season.season_number,
      isActive: false,
      slots: buildSlots(top5, gamesWinner, streakWinner),
    };
  });
}
