import "server-only";
import { createServerClient } from "../supabase/server";
import type { QueueType } from "../supabase/types";

export interface HeadToHeadGame {
  seriesId: string;
  queueType: QueueType;
  playedAt: string;
  won: boolean;
  // Other participants of this series, split by role relative to the target player — a
  // teammate (same team) or an opponent (other team). Self is never included in either list.
  teammateIds: string[];
  opponentIds: string[];
}

export interface HeadToHeadPlayerInfo {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface HeadToHeadData {
  target: HeadToHeadPlayerInfo;
  games: HeadToHeadGame[];
  // Every other player the target has ever shared a reported series with (teammate or
  // opponent) — enough to render every row the client component could ever need across all
  // queue-filter / with-vs-against combinations, without a second round trip on toggle.
  playersById: Map<string, HeadToHeadPlayerInfo>;
}

// Computed on the fly from series_players/series (no persisted pairwise-stats table) — mirrors
// getAllPlayersWithGames's existing precedent of deriving stats straight from source-of-truth
// tables at this project's data volume, and sidesteps needing to keep a counter table's
// increment/decrement in sync with /report, /admin correct-report, and /admin unreport.
export async function getHeadToHeadData(playerId: string): Promise<HeadToHeadData | null> {
  const supabase = createServerClient();

  const { data: target, error: targetError } = await supabase
    .from("crl6mansqueuebot_players")
    .select("id, display_name, avatar_url")
    .eq("id", playerId)
    .maybeSingle();
  if (targetError) throw targetError;
  if (!target) return null;

  const targetInfo: HeadToHeadPlayerInfo = {
    id: target.id,
    displayName: target.display_name,
    avatarUrl: target.avatar_url,
  };

  const { data: ownRows, error: ownError } = await supabase
    .from("crl6mansqueuebot_series_players")
    .select("series_id, team")
    .eq("player_id", playerId);
  if (ownError) throw ownError;
  if (!ownRows || ownRows.length === 0) {
    return { target: targetInfo, games: [], playersById: new Map() };
  }

  const ownTeamBySeries = new Map(ownRows.map((r) => [r.series_id, r.team]));

  const { data: seriesRows, error: seriesError } = await supabase
    .from("crl6mansqueuebot_series")
    .select("id, queue_type, winner_team, reported_at, created_at")
    .eq("status", "reported")
    .in("id", Array.from(ownTeamBySeries.keys()));
  if (seriesError) throw seriesError;
  if (!seriesRows || seriesRows.length === 0) {
    return { target: targetInfo, games: [], playersById: new Map() };
  }

  const { data: rosterRows, error: rosterError } = await supabase
    .from("crl6mansqueuebot_series_players")
    .select("series_id, player_id, team")
    .in(
      "series_id",
      seriesRows.map((s) => s.id),
    );
  if (rosterError) throw rosterError;

  const rosterBySeries = new Map<string, { playerId: string; team: string }[]>();
  for (const row of rosterRows ?? []) {
    const list = rosterBySeries.get(row.series_id);
    if (list) list.push({ playerId: row.player_id, team: row.team });
    else rosterBySeries.set(row.series_id, [{ playerId: row.player_id, team: row.team }]);
  }

  const otherPlayerIds = new Set<string>();
  for (const roster of rosterBySeries.values()) {
    for (const r of roster) {
      if (r.playerId !== playerId) otherPlayerIds.add(r.playerId);
    }
  }

  const { data: otherPlayers, error: otherError } =
    otherPlayerIds.size > 0
      ? await supabase
          .from("crl6mansqueuebot_players")
          .select("id, display_name, avatar_url")
          .in("id", Array.from(otherPlayerIds))
      : { data: [], error: null };
  if (otherError) throw otherError;

  const playersById = new Map<string, HeadToHeadPlayerInfo>(
    (otherPlayers ?? []).map((p) => [p.id, { id: p.id, displayName: p.display_name, avatarUrl: p.avatar_url }]),
  );

  const games: HeadToHeadGame[] = seriesRows.map((s) => {
    const ownTeam = ownTeamBySeries.get(s.id)!;
    const roster = rosterBySeries.get(s.id) ?? [];
    const teammateIds = roster.filter((r) => r.playerId !== playerId && r.team === ownTeam).map((r) => r.playerId);
    const opponentIds = roster.filter((r) => r.team !== ownTeam).map((r) => r.playerId);
    return {
      seriesId: s.id,
      queueType: s.queue_type,
      playedAt: s.reported_at ?? s.created_at,
      won: s.winner_team !== null && ownTeam === s.winner_team,
      teammateIds,
      opponentIds,
    };
  });

  return { target: targetInfo, games, playersById };
}
