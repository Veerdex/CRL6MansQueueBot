import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

export async function getConfigValue(key: string): Promise<string | null> {
  const supabase = createAdminClient();
  const { data } = await supabase.from("crl6mansqueuebot_config").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
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
  // Weekly bonus day — see CLAUDE.md, "Weekly bonus day". Listed here so /admin config get can
  // display current values, but deliberately left out of register-commands.mjs's CONFIG_KEYS
  // (same precedent as bot_paused) — these three are set through their own dedicated,
  // validated /admin bonus-day subcommands instead of the generic /admin config set.
  bonus_day_enabled: 1,
  bonus_day_bonus_pct: 50,
  bonus_day_of_week: 6, // Saturday (Sun=0..Sat=6)
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
};

export async function setConfigValue(key: string, value: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase.from("crl6mansqueuebot_config").upsert({ key, value });
}

// Apply MMR display transformation: displayed_mmr = (actual_mmr * scale) + shift
export async function getDisplayMMR(actualMMR: number): Promise<number> {
  const scale = await getConfigNumber("mmr_scale", 1);
  const shift = await getConfigNumber("mmr_shift", 0);
  return actualMMR * scale + shift;
}
