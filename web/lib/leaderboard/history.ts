import "server-only";
import { createServerClient } from "../supabase/server";
import { getConfigNumber } from "@/lib/discord/config";
import { calculateTeamStrength } from "@/lib/mmr/teamStrength";
import type { Band, QueueType, Team } from "../supabase/types";

export interface MatchHistoryPlayer {
  playerId: string;
  displayName: string;
  avatarUrl: string | null;
  band: Band | null;
  isPrism: boolean;
  mmr: number;
}

export interface MatchHistoryEntry {
  seriesId: string;
  queueType: QueueType;
  playedAt: string;
  matchNumber: number | null;
  winnerTeam: Team | null;
  // Team A = the "Team Blue" voice channel, Team B = "Team Orange" — see CLAUDE.md's "Voice
  // channels" section for the naming convention this mirrors (createVoiceChannels in queue.ts).
  teamA: MatchHistoryPlayer[];
  teamB: MatchHistoryPlayer[];
  // P(Team A wins), from the same calculateTeamStrength()/s_scale pair the /chances Discord
  // command uses — computed off each player's CURRENT mmr, since no historical pre-match
  // snapshot is persisted anywhere in the schema (series_players.mmr_delta is only the delta
  // applied at report time, not a before/after snapshot).
  expectedA: number;
}

export interface MatchHistoryData {
  matches: MatchHistoryEntry[];
  // Every player who's ever been part of a reported match — powers the History page's player
  // filter dropdown. Deliberately not filtered by is_test_data, same precedent as
  // getAllPlayersWithGames/getHeadToHeadData.
  players: { playerId: string; displayName: string }[];
}

export async function getMatchHistory(): Promise<MatchHistoryData> {
  const supabase = createServerClient();

  const { data: series, error: seriesError } = await supabase
    .from("crl6mansqueuebot_series")
    .select("id, queue_type, winner_team, reported_at, created_at, match_number")
    .eq("status", "reported")
    .order("reported_at", { ascending: false });
  if (seriesError) throw seriesError;
  if (!series || series.length === 0) return { matches: [], players: [] };

  const { data: rosterRows, error: rosterError } = await supabase
    .from("crl6mansqueuebot_series_players")
    .select("series_id, player_id, team")
    .in(
      "series_id",
      series.map((s) => s.id),
    );
  if (rosterError) throw rosterError;

  const playerIds = new Set((rosterRows ?? []).map((r) => r.player_id));
  const { data: players, error: playersError } =
    playerIds.size > 0
      ? await supabase
          .from("crl6mansqueuebot_players")
          .select("id, display_name, avatar_url, band, is_prism, mmr")
          .in("id", Array.from(playerIds))
      : { data: [], error: null };
  if (playersError) throw playersError;

  const playerById = new Map((players ?? []).map((p) => [p.id, p]));

  const rosterBySeries = new Map<string, { playerId: string; team: Team }[]>();
  for (const row of rosterRows ?? []) {
    const entry = { playerId: row.player_id, team: row.team };
    const list = rosterBySeries.get(row.series_id);
    if (list) list.push(entry);
    else rosterBySeries.set(row.series_id, [entry]);
  }

  const sScale = await getConfigNumber("s_scale", 400);

  const toHistoryPlayer = (playerId: string): MatchHistoryPlayer | null => {
    const p = playerById.get(playerId);
    if (!p) return null;
    return {
      playerId: p.id,
      displayName: p.display_name,
      avatarUrl: p.avatar_url,
      band: p.band,
      isPrism: p.is_prism,
      mmr: p.mmr,
    };
  };

  const matches: MatchHistoryEntry[] = [];
  for (const s of series) {
    const roster = rosterBySeries.get(s.id) ?? [];
    const teamA = roster
      .filter((r) => r.team === "A")
      .map((r) => toHistoryPlayer(r.playerId))
      .filter((p): p is MatchHistoryPlayer => p !== null);
    const teamB = roster
      .filter((r) => r.team === "B")
      .map((r) => toHistoryPlayer(r.playerId))
      .filter((p): p is MatchHistoryPlayer => p !== null);
    // Guards against a malformed/incomplete roster (shouldn't happen for a genuinely reported
    // series, but calculateTeamStrength expects exactly 3 ratings per team).
    if (teamA.length !== 3 || teamB.length !== 3) continue;

    const strengthA = calculateTeamStrength(teamA.map((p) => p.mmr));
    const strengthB = calculateTeamStrength(teamB.map((p) => p.mmr));
    const expectedA = 1 / (1 + 10 ** ((strengthB - strengthA) / sScale));

    matches.push({
      seriesId: s.id,
      queueType: s.queue_type,
      playedAt: s.reported_at ?? s.created_at,
      matchNumber: s.match_number,
      winnerTeam: s.winner_team,
      teamA,
      teamB,
      expectedA,
    });
  }

  return {
    matches,
    players: (players ?? []).map((p) => ({ playerId: p.id, displayName: p.display_name })),
  };
}
