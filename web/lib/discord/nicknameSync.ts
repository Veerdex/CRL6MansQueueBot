import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  listAllGuildMembers,
  setMemberNickname,
  getGuildId,
  type DiscordGuildMember,
} from "./rest";
import { desiredNickname, hasMedals, medalsForFinishes, type MedalFinish } from "./nicknameMedals";

const PAGE_SIZE = 1000;

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

export type NicknameMedalSummary = {
  members: number;
  awarded: number;
  stripped: number;
  unchanged: number;
  failed: number;
};

// Podium finishes, keyed by discord_id. Derived from season_history rather than stored anywhere,
// for the same reason as season_score: the standings are already the source of truth, so a
// re-close or an admin correction can't leave a denormalized medal list behind. Only closed
// seasons have history rows, so the in-progress season correctly awards nothing.
//
// season_rank 1-3 is exactly the set Hall of Fame's podium renders (hallOfFame.ts). Like that
// podium it has no placed/min-games gate, so an unplaced high-MMR finisher can take a medal —
// deliberately consistent with what the website already shows.
async function fetchPodiumFinishes(): Promise<Map<string, MedalFinish[]>> {
  const supabase = createAdminClient();

  const [seasons, history, players] = await Promise.all([
    fetchAllPages((from, to) =>
      supabase
        .from("crl6mansqueuebot_seasons")
        .select("id, season_number")
        .range(from, to)
        .then(({ data }) => data ?? []),
    ),
    fetchAllPages((from, to) =>
      supabase
        .from("crl6mansqueuebot_season_history")
        .select("season_id, player_id, season_rank")
        .lte("season_rank", 3)
        .range(from, to)
        .then(({ data }) => data ?? []),
    ),
    fetchAllPages((from, to) =>
      supabase
        .from("crl6mansqueuebot_players")
        .select("id, discord_id")
        .eq("is_test_data", false)
        .range(from, to)
        .then(({ data }) => data ?? []),
    ),
  ]);

  const seasonNumberById = new Map(seasons.map((s) => [s.id, s.season_number]));
  const discordIdByPlayerId = new Map(players.map((p) => [p.id, p.discord_id]));

  const finishes = new Map<string, MedalFinish[]>();
  for (const row of history) {
    const discordId = discordIdByPlayerId.get(row.player_id);
    const seasonNumber = seasonNumberById.get(row.season_id);
    if (!discordId || seasonNumber === undefined) continue;
    const finish = { seasonNumber, rank: row.season_rank };
    const existing = finishes.get(discordId);
    if (existing) existing.push(finish);
    else finishes.set(discordId, [finish]);
  }
  return finishes;
}

// undefined means "already correct, don't write" — distinct from null, which means "clear this
// member's nickname entirely".
function plannedNickname(
  member: DiscordGuildMember,
  finishes: Map<string, MedalFinish[]>,
): string | null | undefined {
  const medals = medalsForFinishes(finishes.get(member.user.id) ?? []);
  const desired = desiredNickname(member, medals);
  return desired === (member.nick || null) ? undefined : desired;
}

// Daily job, run alongside the avatar refresh. Sweeps *every* guild member, not just registered
// players: nickname editing is open to everyone in this server, so a user who has never queued
// can still award themselves a medal, and only a full sweep takes it back off them. With no
// gateway connection there's no way to react to a nickname edit as it happens, so a stolen medal
// can be worn for up to a day before this strips it — inherent to a webhook bot, not a bug.
//
// Writes are serial and only ever go out for members whose nickname is actually wrong, so a
// normal day issues zero PATCHes (see nicknameMedals.ts on why exact idempotency matters here).
export async function syncNicknameMedals(): Promise<NicknameMedalSummary> {
  const guildId = await getGuildId();
  const [members, finishes] = await Promise.all([listAllGuildMembers(guildId), fetchPodiumFinishes()]);

  const summary: NicknameMedalSummary = {
    members: members.length,
    awarded: 0,
    stripped: 0,
    unchanged: 0,
    failed: 0,
  };

  for (const member of members) {
    const planned = plannedNickname(member, finishes);
    if (planned === undefined) {
      summary.unchanged += 1;
      continue;
    }
    try {
      await setMemberNickname(guildId, member.user.id, planned);
      if (hasMedals(planned)) summary.awarded += 1;
      else summary.stripped += 1;
    } catch (error) {
      // Best-effort, per member: a 403 means the target outranks the bot (the guild owner always
      // does) and a 400 means Discord rejected the nickname outright. Neither should stop the
      // sweep, and neither is worth retrying — see discordFetch's note on invalid-request bans.
      summary.failed += 1;
      console.error(`Failed to sync nickname medals for member ${member.user.id}`, error);
    }
  }

  return summary;
}
