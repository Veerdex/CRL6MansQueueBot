import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { currentPacificDayOfWeek } from "./bonusDay";

type AdminClient = ReturnType<typeof createAdminClient>;

// 30-minute segment of the day in Pacific time: 0 = 00:00-00:29, 1 = 00:30-00:59, ... 47 = 23:30-23:59.
function currentPacificSegmentIndex(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour")!.value);
  const minute = Number(parts.find((p) => p.type === "minute")!.value);
  return hour * 2 + (minute >= 30 ? 1 : 0);
}

// Increment-only match-time counters for the hidden analytics page (see CLAUDE.md, "Match time
// stats"). Called once per real match at team-formation time (teamFormation.ts's finalizeTeams)
// — not per player, and not for test-data matches, matching every other stats feature's
// exclusion of synthetic dev-panel data. "Supercharged" = that series' bonus_day_multiplier > 1,
// i.e. CLAUDE.md's existing Weekly Bonus Day mechanic. Best-effort: a stats-counter failure must
// never block match creation.
export async function recordMatchTimeStats(supabase: AdminClient, isTestData: boolean, isSupercharged: boolean): Promise<void> {
  if (isTestData) return;
  try {
    // supabase-js resolves { error } on a Postgres/PostgREST failure rather than rejecting —
    // it does NOT throw, so this must be checked explicitly or a broken RPC fails silently forever.
    const { error } = await supabase.rpc("crl6mansqueuebot_increment_match_time_stats", {
      p_segment_index: currentPacificSegmentIndex(),
      p_day_of_week: currentPacificDayOfWeek(),
      p_is_supercharged: isSupercharged,
    });
    if (error) {
      console.error("recordMatchTimeStats: RPC failed", error);
    }
  } catch (err) {
    console.error("recordMatchTimeStats: unexpected error", err);
  }
}
