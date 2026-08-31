// Season podium medals worn in Discord server nicknames (see CLAUDE.md, "Seasons"). Pure and
// dependency-free — no server-only, no Supabase — so the rebuild rules stay unit-testable and
// importable from both the display-name resolvers (types.ts, avatars.ts) and the daily sync.
//
// The whole feature rests on one property: applying these rules to an already-correct nickname
// must produce that same nickname, byte for byte. Anyone in the server can edit their own
// nickname, so the daily cron re-derives every member's correct nickname from scratch and
// writes only the ones that differ. If the rebuild weren't exactly idempotent, that sweep would
// rewrite every medal holder every single day and run straight into Discord's per-object rename
// throttle. The round-trip tests in nicknameMedals.test.ts guard exactly that.

// U+1F947..U+1F949 — 1st/2nd/3rd place medals.
export const MEDAL_BY_RANK: Record<number, string> = { 1: "\u{1F947}", 2: "\u{1F948}", 3: "\u{1F949}" };

// Rolling window: the 7th medal earned evicts the oldest, so a player never wears more than six.
// This counts medals earned, not seasons elapsed — three medals then four quiet seasons still
// shows three.
export const MAX_NICKNAME_MEDALS = 6;

// Discord rejects an over-length nickname with a 400 rather than truncating it. Counted in code
// points, which is how Discord counts every other text field (a medal emoji is a single code
// point, so it costs 1). The PATCH path still treats a 400 as a non-fatal skip in case that
// assumption is ever wrong on Discord's side.
export const NICKNAME_MAX_LENGTH = 32;

// Matches a medal plus any whitespace hugging it, so removal doesn't leave a double space
// behind. Deliberately NOT a blanket whitespace collapse: the sweep sees every member in the
// server, and it must never "tidy up" a nickname that has nothing to do with this feature.
const MEDAL_RUN = /\s*[\u{1F947}-\u{1F949}]\s*/gu;

export function medalForRank(rank: number): string | null {
  return MEDAL_BY_RANK[rank] ?? null;
}

export function hasMedals(name: string | null | undefined): boolean {
  if (!name) return false;
  MEDAL_RUN.lastIndex = 0;
  return MEDAL_RUN.test(name);
}

// Removes every medal from anywhere in the name, not just a well-formed trailing run — a
// tamperer can put them in the middle, and `display_name` has to come out clean regardless.
export function stripMedals(name: string): string {
  return name.replace(MEDAL_RUN, " ").trim();
}

export function nicknameLength(name: string): number {
  return [...name].length;
}

export type MedalMember = {
  nick: string | null;
  user: { username: string; global_name: string | null };
};

// The name a member's medals hang off: their current nickname with any medals removed, falling
// back to their account display name when they have no nickname (the common case — a top-3
// finisher who has never set one still needs a nickname created for them to wear medals).
export function medalBaseName(member: MedalMember): string {
  const candidates = [member.nick, member.user.global_name, member.user.username];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const stripped = stripMedals(candidate);
    if (stripped) return stripped;
  }
  return "";
}

// The nickname this member should be wearing right now, or null for "no nickname at all".
// `medals` is already ordered oldest-first and windowed to MAX_NICKNAME_MEDALS.
//
// When the name plus its medals won't fit, the medals are dropped rather than the name being
// trimmed: stripping is always shorter than what's already there, so it can never overflow, and
// it keeps the anti-tamper guarantee intact for long names. Because the sweep re-derives this
// from scratch every day, the medals reappear on their own the moment that player shortens
// their nickname.
export function desiredNickname(member: MedalMember, medals: string[]): string | null {
  const bare = member.nick ? stripMedals(member.nick) : "";
  const accountName = member.user.global_name || member.user.username;
  // A nickname that is exactly the account name is one this sweep created to hang medals off
  // (Discord shows the account name when there is no nickname, so nobody sets that by hand for
  // any other reason). Clearing it instead of leaving it behind means that when a player's last
  // medal rolls off six seasons later they go back to following their account name, exactly as
  // they did before they ever placed — rather than being pinned to whatever they were called
  // the day the medal was awarded.
  const withoutMedals = !bare || bare === accountName ? null : bare;

  if (medals.length === 0) return withoutMedals;

  const base = medalBaseName(member);
  if (!base) return withoutMedals;

  const candidate = `${base} ${medals.slice(0, MAX_NICKNAME_MEDALS).join(" ")}`;
  if (nicknameLength(candidate) > NICKNAME_MAX_LENGTH) return withoutMedals;
  return candidate;
}

export type MedalFinish = { seasonNumber: number; rank: number };

// Chronological, oldest first, capped at the six most recent. Ties on season_number can't happen
// (season_number is unique) but the rank tiebreak keeps the order deterministic anyway.
export function medalsForFinishes(finishes: MedalFinish[]): string[] {
  return finishes
    .filter((f) => MEDAL_BY_RANK[f.rank] !== undefined)
    .sort((a, b) => a.seasonNumber - b.seasonNumber || a.rank - b.rank)
    .slice(-MAX_NICKNAME_MEDALS)
    .map((f) => MEDAL_BY_RANK[f.rank]);
}
