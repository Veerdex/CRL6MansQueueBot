import "server-only";
import { createServerClient } from "../supabase/server";
import type { Band, DayOfWeekStatsRow, PlayerRow, QueueType, SeasonHistoryRow, SeasonRow, Team, TimeOfDayStatsRow } from "../supabase/types";

export interface CompletedGame {
  seriesId: string;
  seasonId: string;
  queueType: QueueType;
  playedAt: string;
  team: Team;
  won: boolean;
}

export interface PlayerWithGames {
  player: PlayerRow;
  games: CompletedGame[]; // chronological order (oldest first), all seasons/queues
}

export async function getActiveSeason(): Promise<SeasonRow | null> {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("crl6mansqueuebot_seasons")
    .select("*")
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getPreviousSeason(currentSeasonNumber: number): Promise<SeasonRow | null> {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("crl6mansqueuebot_seasons")
    .select("*")
    .lt("season_number", currentSeasonNumber)
    .order("season_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getSeasonHistoryMap(seasonId: string): Promise<Map<string, SeasonHistoryRow>> {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("crl6mansqueuebot_season_history")
    .select("*")
    .eq("season_id", seasonId);
  if (error) throw error;

  const map = new Map<string, SeasonHistoryRow>();
  for (const row of data ?? []) {
    map.set(row.player_id, row);
  }
  return map;
}

// Fetches every player plus their full chronological game history in two flat
// queries (not N+1 per player, not embedded joins) — fine at this data volume
// per CLAUDE.md's "small server, don't over-engineer" principle.
export async function getAllPlayersWithGames(): Promise<PlayerWithGames[]> {
  const supabase = createServerClient();

  const { data: players, error: playersError } = await supabase
    .from("crl6mansqueuebot_players")
    .select("*");
  if (playersError) throw playersError;

  const { data: series, error: seriesError } = await supabase
    .from("crl6mansqueuebot_series")
    .select("id, season_id, queue_type, winner_team, reported_at, created_at")
    .eq("status", "reported");
  if (seriesError) throw seriesError;

  const { data: seriesPlayers, error: seriesPlayersError } = await supabase
    .from("crl6mansqueuebot_series_players")
    .select("series_id, player_id, team");
  if (seriesPlayersError) throw seriesPlayersError;

  const seriesById = new Map((series ?? []).map((s) => [s.id, s]));

  const gamesByPlayer = new Map<string, CompletedGame[]>();
  for (const sp of seriesPlayers ?? []) {
    const s = seriesById.get(sp.series_id);
    if (!s) continue; // series wasn't in the "reported" set

    const game: CompletedGame = {
      seriesId: s.id,
      seasonId: s.season_id,
      queueType: s.queue_type,
      playedAt: s.reported_at ?? s.created_at,
      team: sp.team,
      won: s.winner_team !== null && sp.team === s.winner_team,
    };

    const list = gamesByPlayer.get(sp.player_id);
    if (list) {
      list.push(game);
    } else {
      gamesByPlayer.set(sp.player_id, [game]);
    }
  }

  return (players ?? []).map((player) => {
    const games = (gamesByPlayer.get(player.id) ?? []).sort(
      (a, b) => new Date(a.playedAt).getTime() - new Date(b.playedAt).getTime(),
    );
    return { player, games };
  });
}

// Lightweight — just band + MMR for every currently-placed, real player. Powers the Info page's
// per-band MMR display; doesn't need full game history.
export async function getPlacedPlayerBandMMRs(): Promise<{ band: Band; mmr: number }[]> {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("crl6mansqueuebot_players")
    .select("band, mmr")
    .eq("is_placed", true)
    .eq("is_test_data", false);
  if (error) throw error;
  return (data ?? []).filter((p): p is { band: Band; mmr: number } => p.band !== null);
}

// Powers the hidden match-time-stats page (see CLAUDE.md, "Match time stats") — just the two
// aggregate-counter tables, ordered by their index so the caller can render straight through.
export async function getMatchTimeStats(): Promise<{ timeOfDay: TimeOfDayStatsRow[]; dayOfWeek: DayOfWeekStatsRow[] }> {
  const supabase = createServerClient();
  const [timeOfDayResult, dayOfWeekResult] = await Promise.all([
    supabase.from("crl6mansqueuebot_time_of_day_stats").select("*").order("segment_index", { ascending: true }),
    supabase.from("crl6mansqueuebot_day_of_week_stats").select("*").order("day_of_week", { ascending: true }),
  ]);
  if (timeOfDayResult.error) throw timeOfDayResult.error;
  if (dayOfWeekResult.error) throw dayOfWeekResult.error;
  return { timeOfDay: timeOfDayResult.data ?? [], dayOfWeek: dayOfWeekResult.data ?? [] };
}

export interface MMRDistributionPlayer {
  mmr: number;
  band: Band | null;
  isPlaced: boolean;
  isPrism: boolean;
  rankGamesPlayed: number;
}

export interface MMRDistributionStats {
  players: MMRDistributionPlayer[];
  totalMatchesPlayed: number;
  rankMatchesPlayed: number;
  universalMatchesPlayed: number;
}

// Powers the MMR distribution graph on the hidden match-time-stats page. Match counts use
// head:true counts rather than fetching rows — CLAUDE.md's seasonClose.ts note documents that
// PostgREST silently truncates unbounded selects past a project row cap, and a plain fetch-then-
// .length count would walk straight into that with no error.
export async function getMMRDistributionStats(): Promise<MMRDistributionStats> {
  const supabase = createServerClient();
  const [playersResult, totalCount, rankCount, universalCount] = await Promise.all([
    supabase
      .from("crl6mansqueuebot_players")
      .select("mmr, band, is_placed, is_prism, total_games_played, rank_games_played")
      .eq("is_test_data", false),
    supabase.from("crl6mansqueuebot_series").select("*", { count: "exact", head: true }).eq("status", "reported").eq("is_test_data", false),
    supabase
      .from("crl6mansqueuebot_series")
      .select("*", { count: "exact", head: true })
      .eq("status", "reported")
      .eq("is_test_data", false)
      .eq("queue_type", "rank"),
    supabase
      .from("crl6mansqueuebot_series")
      .select("*", { count: "exact", head: true })
      .eq("status", "reported")
      .eq("is_test_data", false)
      .eq("queue_type", "universal"),
  ]);
  if (playersResult.error) throw playersResult.error;
  if (totalCount.error) throw totalCount.error;
  if (rankCount.error) throw rankCount.error;
  if (universalCount.error) throw universalCount.error;

  // Same "eligible player" convention UnifiedLeaderboard.tsx uses: only count players who've
  // actually played at least one game (any queue) toward any aggregate.
  const players = (playersResult.data ?? [])
    .filter((p) => p.total_games_played >= 1)
    .map((p) => ({
      mmr: p.mmr,
      band: p.band,
      isPlaced: p.is_placed,
      isPrism: p.is_prism,
      rankGamesPlayed: p.rank_games_played,
    }));

  return {
    players,
    totalMatchesPlayed: totalCount.count ?? 0,
    rankMatchesPlayed: rankCount.count ?? 0,
    universalMatchesPlayed: universalCount.count ?? 0,
  };
}
