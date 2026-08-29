import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { FLAME_THRESHOLD, COLD_THRESHOLD } from "@/lib/leaderboard/stats";

export { FLAME_THRESHOLD, COLD_THRESHOLD };

type AdminClient = ReturnType<typeof createAdminClient>;

// Win-streak MMR bonus — see CLAUDE.md, "MMR / Elo" (streak bonus) and "Bands / ranks" for the
// precedent this mirrors: streaks are computed live from report history, not stored as a counter
// on the players row (same approach the leaderboard's win-streak columns already use, see
// web/lib/leaderboard/queries.ts's getAllPlayersWithGames). Rank Queue only — Universal Queue
// never participates in this feature. Test-data series are excluded, same as bands.ts/seasonClose.ts.

export const ON_FIRE_EMOJI = "🔥";
// Amber "on a streak!" announcement embed threshold (report.ts) — separate from FLAME_THRESHOLD
// below, since the user asked for the 🔥 mention decoration to trigger earlier without also
// making the announcement embed fire on every 3-game streak.
export const ON_FIRE_THRESHOLD = 5;
// 🔥 mention-decoration threshold (getStreakIds/mention below, and report.ts's summary
// embed) — intentionally lower than ON_FIRE_THRESHOLD. Imported above from leaderboard/stats.ts.

// 🥶 losing-streak mention decoration — purely cosmetic (no MMR effect), so unlike the win-streak
// system there's no separate announcement-embed threshold or bonus arithmetic to mirror, just
// the mention/leaderboard decoration. COLD_THRESHOLD imported above from leaderboard/stats.ts.
export const COLD_EMOJI = "🥶";

interface StreakGame {
  playedAt: string;
  won: boolean;
}

function sortByRecency(games: StreakGame[]): StreakGame[] {
  return [...games].sort((a, b) => new Date(b.playedAt).getTime() - new Date(a.playedAt).getTime());
}

function consecutiveWins(games: StreakGame[]): number {
  let streak = 0;
  for (const g of sortByRecency(games)) {
    if (!g.won) break;
    streak++;
  }
  return streak;
}

function consecutiveLosses(games: StreakGame[]): number {
  let streak = 0;
  for (const g of sortByRecency(games)) {
    if (g.won) break;
    streak++;
  }
  return streak;
}

async function fetchStreakGames(
  supabase: AdminClient,
  playerId: string,
  excludeSeriesId?: string,
): Promise<StreakGame[]> {
  const { data: seriesPlayerRows } = await supabase
    .from("crl6mansqueuebot_series_players")
    .select("series_id, team")
    .eq("player_id", playerId);
  const rows = (seriesPlayerRows ?? []).filter((r) => r.series_id !== excludeSeriesId);
  if (rows.length === 0) return [];

  const { data: seriesRows } = await supabase
    .from("crl6mansqueuebot_series")
    .select("id, winner_team, reported_at, created_at")
    .in(
      "id",
      rows.map((r) => r.series_id),
    )
    .eq("queue_type", "rank")
    .eq("status", "reported")
    .eq("is_test_data", false);

  const seriesById = new Map((seriesRows ?? []).map((s) => [s.id, s]));
  const games: StreakGame[] = [];
  for (const r of rows) {
    const s = seriesById.get(r.series_id);
    if (!s) continue;
    games.push({ playedAt: s.reported_at ?? s.created_at, won: s.winner_team !== null && r.team === s.winner_team });
  }
  return games;
}

// A player's consecutive-win count over their reported Rank Queue history, as of right now.
// `excludeSeriesId` must be passed by any caller invoked after the atomic settle claim has
// already flipped the in-flight series to status='reported' (report.ts, adminTools.ts's
// correct-report) — otherwise the game currently being scored double-counts as its own most
// recent result, shifting the bonus/embed thresholds off by one game.
export async function getPriorRankWinStreak(supabase: AdminClient, playerId: string, excludeSeriesId?: string): Promise<number> {
  return consecutiveWins(await fetchStreakGames(supabase, playerId, excludeSeriesId));
}

// Mirror of getPriorRankWinStreak for the losing side — see report.ts's settle logic, which
// needs a losing-team player's own consecutive-loss count the same way it needs a winning-team
// player's consecutive-win count. Same excludeSeriesId reasoning applies.
export async function getPriorRankLossStreak(supabase: AdminClient, playerId: string, excludeSeriesId?: string): Promise<number> {
  return consecutiveLosses(await fetchStreakGames(supabase, playerId, excludeSeriesId));
}

export interface StreakIds {
  onFireIds: Set<string>;
  coldIds: Set<string>;
}

// Batch version for decorating a set of mentions in one bot message (queue status, draft/vote
// embeds, teams-formed summaries, /rank) — one pair of queries for the whole set rather than an
// N+1 per mention, computing both the fire and cold sets from the same fetched game history in
// one pass. No exclusion param: unlike report.ts's mid-settle computation, these call sites
// render *after* any relevant series has already fully settled, so "streak as of now" is
// exactly what should show.
export async function getStreakIds(supabase: AdminClient, playerIds: string[]): Promise<StreakIds> {
  const uniqueIds = [...new Set(playerIds)];
  if (uniqueIds.length === 0) return { onFireIds: new Set(), coldIds: new Set() };

  const { data: seriesPlayerRows } = await supabase
    .from("crl6mansqueuebot_series_players")
    .select("series_id, player_id, team")
    .in("player_id", uniqueIds);
  const rows = seriesPlayerRows ?? [];
  if (rows.length === 0) return { onFireIds: new Set(), coldIds: new Set() };

  const seriesIds = [...new Set(rows.map((r) => r.series_id))];
  const { data: seriesRows } = await supabase
    .from("crl6mansqueuebot_series")
    .select("id, winner_team, reported_at, created_at")
    .in("id", seriesIds)
    .eq("queue_type", "rank")
    .eq("status", "reported")
    .eq("is_test_data", false);
  const seriesById = new Map((seriesRows ?? []).map((s) => [s.id, s]));

  const gamesByPlayer = new Map<string, StreakGame[]>();
  for (const r of rows) {
    const s = seriesById.get(r.series_id);
    if (!s) continue;
    const list = gamesByPlayer.get(r.player_id);
    const game: StreakGame = { playedAt: s.reported_at ?? s.created_at, won: s.winner_team !== null && r.team === s.winner_team };
    if (list) list.push(game);
    else gamesByPlayer.set(r.player_id, [game]);
  }

  const onFireIds = new Set<string>();
  const coldIds = new Set<string>();
  for (const [playerId, games] of gamesByPlayer) {
    if (consecutiveWins(games) >= FLAME_THRESHOLD) onFireIds.add(playerId);
    if (consecutiveLosses(games) >= COLD_THRESHOLD) coldIds.add(playerId);
  }
  return { onFireIds, coldIds };
}

// Sync formatter for a single mention once fire/cold status is already known (from
// getStreakIds' batch result) — bot-message-only decoration, never a nickname mutation
// (the bot's OAuth invite doesn't include MANAGE_NICKNAMES; see CLAUDE.md). A player can't be
// both on-fire and cold at once (they're opposite streak types), but the flags are independent
// booleans rather than an enum so callers can pass whichever they have on hand.
export function mention(discordId: string, decoration: { onFire?: boolean; cold?: boolean; prism?: boolean } = {}): string {
  const prefix = decoration.prism ? "✦ " : "";
  if (decoration.onFire) return `${prefix}<@${discordId}> ${ON_FIRE_EMOJI}`;
  if (decoration.cold) return `${prefix}<@${discordId}> ${COLD_EMOJI}`;
  return `${prefix}<@${discordId}>`;
}
