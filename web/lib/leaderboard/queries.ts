import "server-only";
import { createServerClient } from "../supabase/server";
import type { PlayerRow, QueueType, SeasonHistoryRow, SeasonRow, Team } from "../supabase/types";

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
