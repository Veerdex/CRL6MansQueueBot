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
  hysteresis_pct: 5,
  grace_games: 3,
  provisional_games: 10,
  provisional_k_multiplier: 1.75,
  placement_games_required: 10,
  decay_factor: 0.25,
  top10_min_games: 8,
  series_timeout_hours: 2,
  vote_timeout_seconds: 180,
  sub_request_timeout_minutes: 10,
  queue_member_timeout_minutes: 30,
  band_cutoff_garnet_pctile: 40,
  band_cutoff_emerald_pctile: 70,
  band_cutoff_sapphire_pctile: 90,
  season_rank_display_min_games: 10,
};

export async function setConfigValue(key: string, value: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase.from("crl6mansqueuebot_config").upsert({ key, value });
}
