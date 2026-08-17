import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// In-memory cache of the whole config table, module-scoped so it survives across requests on a
// warm Vercel instance. Every command reads several config keys (a typical /q in rich mode reads
// 6+), each of which used to be its own Supabase round trip with zero caching — this was one of
// the largest, most universal sources of latency in the bot (see the /q latency discussion),
// since it affects every command that touches config, not just queueing. Config changes are rare
// (admin-only) and don't need to be instant everywhere, so a short TTL is an easy tradeoff — but
// the two write paths below also update the cache immediately, so the instance that actually
// handled an admin's `/admin config set` (or any other config-writing command) sees its own
// change right away rather than waiting out the TTL, even though *other* warm instances still
// only pick it up once their own cache expires.
const CONFIG_CACHE_TTL_MS = 30_000;
let configCache: Map<string, string> | null = null;
let configCacheLoadedAt = 0;
let configCacheLoadPromise: Promise<Map<string, string>> | null = null;

async function loadConfigCache(): Promise<Map<string, string>> {
  if (configCache && Date.now() - configCacheLoadedAt < CONFIG_CACHE_TTL_MS) return configCache;
  // Collapse concurrent cache-miss callers onto one in-flight fetch instead of each firing its
  // own SELECT — the whole point of this cache is fewer round trips, so a stampede of parallel
  // reloads right as the TTL expires would defeat that.
  if (configCacheLoadPromise) return configCacheLoadPromise;

  configCacheLoadPromise = (async () => {
    const supabase = createAdminClient();
    const { data } = await supabase.from("crl6mansqueuebot_config").select("key, value");
    const map = new Map((data ?? []).map((row) => [row.key as string, row.value as string]));
    configCache = map;
    configCacheLoadedAt = Date.now();
    configCacheLoadPromise = null;
    return map;
  })();
  return configCacheLoadPromise;
}

export async function getConfigValue(key: string): Promise<string | null> {
  const cache = await loadConfigCache();
  return cache.get(key) ?? null;
}

export async function getConfigNumber(key: string, fallback: number): Promise<number> {
  const value = await getConfigValue(key);
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Every admin-tunable value from CLAUDE.md's "Config values" table, with its documented
// default — the single source of truth /admin config get/set validates keys against and
// falls back to for display. Keep in sync with the inline `getConfigNumber(key, fallback)`
// call sites scattered across bands.ts/report.ts/seasonClose.ts/teamFormation.ts/sub.ts/the
// sweep route — this map doesn't replace those calls, it just mirrors their fallbacks for the
// admin command's validation/display purposes.
export const KNOWN_CONFIG_DEFAULTS: Record<string, number> = {
  k_factor: 32,
  s_scale: 400,
  // Fixed MMR-point buffer for the demotion hysteresis check — see CLAUDE.md, "Bands / ranks".
  // Superseded the earlier percentile-based hysteresis_pct: a player only demotes once their raw
  // MMR falls more than this many points below their current band's threshold MMR. Raw MMR space,
  // not display-scaled (mmr_scale/mmr_shift never feed back into internal comparisons).
  hysteresis_mmr: 7,
  grace_games: 3,
  // Grace-inactivity bypass — see CLAUDE.md, "Bands / ranks". Days since a player's last Rank
  // Queue game after which grace is treated as expired even if band_games_played hasn't reached
  // grace_games yet. 7 = one week.
  grace_inactivity_days: 7,
  provisional_games: 10,
  provisional_k_multiplier: 1.75,
  placement_games_required: 10,
  decay_factor: 0.25,
  top10_min_games: 8,
  // Restricted to the single top-ranked player, not a wider top-N — with a small community, a
  // top-5 cut let a majority of active players hold an ostensibly exclusive tier at once.
  prism_top_n: 1,
  series_timeout_hours: 2,
  vote_timeout_seconds: 180,
  sub_request_timeout_minutes: 10,
  queue_member_timeout_minutes: 30,
  // Minimum time after teams are formed before /report is allowed to settle — see CLAUDE.md,
  // "Reporting & disputes". Prevents a false/premature report right after teams are decided.
  report_cooldown_minutes: 15,
  band_cutoff_garnet_pctile: 40,
  band_cutoff_emerald_pctile: 70,
  band_cutoff_sapphire_pctile: 90,
  season_rank_display_min_games: 10,
  bot_paused: 0,
  mmr_scale: 1,
  mmr_shift: 0,
  mmr_skew_factor: 0.5,
  mmr_min_delta: 2,
  // Divides s_scale for the expected-score used in MMR delta calculations (and, in turn, the
  // win-streak bonus taper — see elo.ts, EloConfig.confidenceMultiplier). Deliberately separate
  // from s_scale above: the website History page and /chances compute their own win-odds live
  // off s_scale directly and never read this config, so tuning it changes how confident the Elo
  // math itself is without retroactively shifting any displayed odds. 1 = no boost (same
  // confidence as the real odds); >1 sharpens favorite/underdog deltas and tapers the streak
  // bonus off faster for favorites.
  mmr_confidence_multiplier: 1,
  // Weekly bonus day — see CLAUDE.md, "Weekly bonus day". Listed here so /admin config get can
  // display current values, but deliberately left out of register-commands.mjs's CONFIG_KEYS
  // (same precedent as bot_paused) — these four are set through their own dedicated,
  // validated /admin bonus-day subcommands instead of the generic /admin config set.
  bonus_day_enabled: 1,
  bonus_day_bonus_pct: 50,
  // bonus_day_start/end together define an inclusive, wraparound-aware day range (Sun=0..Sat=6)
  // — start==end is a single bonus day (default: Saturday only, matching the original
  // bonus_day_of_week behavior it supersedes). Set independently via /admin bonus-day
  // set-start-day / set-end-day.
  bonus_day_start: 6,
  bonus_day_end: 6,
  // Queue-status message behavior — see queue.ts's getQueueMessageMode(). Superseded by the
  // string-valued `queue_message_mode` config key (simplified|default|hybrid, set via /admin
  // queue-message-mode — not listed here since this map is number-only) but kept as a legacy
  // fallback for anyone who set this boolean before hybrid mode existed.
  queue_simplified_messages: 1,
  // Win-streak MMR bonus — see CLAUDE.md, "MMR / Elo" (streak bonus). Same precedent as
  // bonus_day_enabled/queue_simplified_messages: listed here for /admin config get's display,
  // but deliberately left out of register-commands.mjs's CONFIG_KEYS since it's set through its
  // own dedicated, boolean-validated /admin streak-bonus toggle command instead.
  streak_bonus_enabled: 1,
  // Best-of-3/5/7 series-length pre-vote — see CLAUDE.md, "Team formation (on pop)". Same
  // precedent as bonus_day_enabled/streak_bonus_enabled: listed here for /admin config get's
  // display, but deliberately left out of register-commands.mjs's CONFIG_KEYS since it's set
  // through its own dedicated /admin series-length-vote toggle command instead. Defaults to
  // disabled — this is a new behavior change to the pop flow, not something that should suddenly
  // activate for a live community without an admin's deliberate choice.
  series_length_vote_enabled: 0,
  // /mafia mini-game — see CLAUDE.md, "Mafia". No dedicated subcommand exists for these (unlike
  // bonus_day_*/streak_bonus_enabled above), so both are left in register-commands.mjs's
  // CONFIG_KEYS and settable via the generic /admin config set.
  mafia_grace_seconds: 5,
  mafia_timeout_seconds: 120,
};

export async function setConfigValue(key: string, value: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase.from("crl6mansqueuebot_config").upsert({ key, value });
  // Best-effort: keep this instance's cache in sync so the write is visible on its very next
  // read. If the cache hasn't been loaded yet on this instance, there's nothing to update —
  // the next getConfigValue call will load it fresh (including this write) anyway.
  if (configCache) configCache.set(key, value);
}

export async function deleteConfigValue(key: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase.from("crl6mansqueuebot_config").delete().eq("key", key);
  if (configCache) configCache.delete(key);
}

// Apply MMR display transformation: displayed_mmr = (actual_mmr * scale) + shift
export async function getDisplayMMR(actualMMR: number): Promise<number> {
  const scale = await getConfigNumber("mmr_scale", 1);
  const shift = await getConfigNumber("mmr_shift", 0);
  return actualMMR * scale + shift;
}
