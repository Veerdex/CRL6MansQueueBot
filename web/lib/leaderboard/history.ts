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
  // command uses — computed off each player's mmr_before snapshot (see
  // migration 0032_series_players_mmr_before.sql), falling back to their current mmr for
  // matches reported before that column existed.
  expectedA: number;
}

export interface MatchHistoryData {
  matches: MatchHistoryEntry[];
  // Every player who's ever been part of a reported match — powers the History page's player
  // filter dropdown. Deliberately not filtered by is_test_data, same precedent as
  // getAllPlayersWithGames/getHeadToHeadData.
  players: { playerId: string; displayName: string }[];
}

// Same fetchAllPages/chunk pattern as avatars.ts, nicknameSync.ts, and seasonClose.ts, duplicated
// rather than imported for the reason avatars.ts:7 records. PostgREST silently truncates an
// unbounded select at a project row cap (1000 rows), with no error and no marker on the response
// — six matches short of biting here: the roster read below stood at 966 of the 1000 rows
// it needed on the day this paging went in.
// Every paged read needs a *total* order on a unique key as well: .range() is LIMIT/OFFSET over
// whatever order the planner happened to pick, so without one a page boundary can repeat a row
// and drop another. series_players' primary key is (series_id, player_id).
const PAGE_SIZE = 1000;
const ID_CHUNK = 200;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function fetchAllPages<T>(page: (from: number, to: number) => PromiseLike<T[]>): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const batch = await page(from, from + PAGE_SIZE - 1);
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
    from += PAGE_SIZE;
  }
}

export async function getMatchHistory(): Promise<MatchHistoryData> {
  const supabase = createServerClient();

  // reported_at alone is not a total order to page over (two series can share a timestamp, and
  // the column is nullable), hence the id tiebreak — see the note above.
  const series = await fetchAllPages((from, to) =>
    supabase
      .from("crl6mansqueuebot_series")
      .select("id, queue_type, winner_team, reported_at, created_at, match_number")
      .eq("status", "reported")
      .order("reported_at", { ascending: false })
      .order("id")
      .range(from, to)
      .then((r) => {
        if (r.error) throw r.error;
        return r.data ?? [];
      }),
  );
  if (series.length === 0) return { matches: [], players: [] };

  const rosterChunks = await Promise.all(
    chunk(
      series.map((s) => s.id),
      ID_CHUNK,
    ).map((idChunk) =>
      fetchAllPages((from, to) =>
        supabase
          .from("crl6mansqueuebot_series_players")
          .select("series_id, player_id, team, mmr_before")
          .in("series_id", idChunk)
          .order("series_id")
          .order("player_id")
          .range(from, to)
          .then((r) => {
            if (r.error) throw r.error;
            return r.data ?? [];
          }),
      ),
    ),
  );
  const rosterRows = rosterChunks.flat();

  const playerIds = new Set(rosterRows.map((r) => r.player_id));
  const playerChunks = await Promise.all(
    chunk(Array.from(playerIds), ID_CHUNK).map((idChunk) =>
      fetchAllPages((from, to) =>
        supabase
          .from("crl6mansqueuebot_players")
          .select("id, display_name, avatar_url, band, is_prism, mmr")
          .in("id", idChunk)
          .order("id")
          .range(from, to)
          .then((r) => {
            if (r.error) throw r.error;
            return r.data ?? [];
          }),
      ),
    ),
  );

  const players = playerChunks.flat();
  const playerById = new Map(players.map((p) => [p.id, p]));

  const rosterBySeries = new Map<string, { playerId: string; team: Team; mmrBefore: number | null }[]>();
  for (const row of rosterRows) {
    const entry = { playerId: row.player_id, team: row.team, mmrBefore: row.mmr_before };
    const list = rosterBySeries.get(row.series_id);
    if (list) list.push(entry);
    else rosterBySeries.set(row.series_id, [entry]);
  }

  const sScale = await getConfigNumber("s_scale", 400);

  // Prefers the mmr_before snapshot taken at report time (see migration
  // 0032_series_players_mmr_before.sql) so this card reflects what the player's MMR actually
  // was when the match was played; falls back to their current mmr for matches reported before
  // that column existed, since no historical value exists to recover for those.
  const toHistoryPlayer = (playerId: string, mmrBefore: number | null): MatchHistoryPlayer | null => {
    const p = playerById.get(playerId);
    if (!p) return null;
    return {
      playerId: p.id,
      displayName: p.display_name,
      avatarUrl: p.avatar_url,
      band: p.band,
      isPrism: p.is_prism,
      mmr: mmrBefore ?? p.mmr,
    };
  };

  const matches: MatchHistoryEntry[] = [];
  for (const s of series) {
    const roster = rosterBySeries.get(s.id) ?? [];
    const teamA = roster
      .filter((r) => r.team === "A")
      .map((r) => toHistoryPlayer(r.playerId, r.mmrBefore))
      .filter((p): p is MatchHistoryPlayer => p !== null);
    const teamB = roster
      .filter((r) => r.team === "B")
      .map((r) => toHistoryPlayer(r.playerId, r.mmrBefore))
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
    players: players.map((p) => ({ playerId: p.id, displayName: p.display_name })),
  };
}
