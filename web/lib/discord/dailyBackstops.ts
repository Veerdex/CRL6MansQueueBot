import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { reclaimStrayMatchRoles } from "./matchRole";
import { advanceMatchTimeStatsDayCounters } from "./bonusDay";

type AdminClient = ReturnType<typeof createAdminClient>;

// The sweep work Postgres can't gate on, so it runs on a fixed daily schedule instead: the
// refresh-avatars route's 09:30 UTC pg_cron job (migration 0027) calls this, and a manual
// whole-sweep call runs it too. Everything else in the sweep is woken only when the database says
// it's due (migration 0059). Each pass is best-effort and never throws.
export async function runDailyDiscordBackstops(supabase: AdminClient = createAdminClient()) {
  // Stray match roles. Every teardown path deletes its own role, so this only ever catches a
  // leak — but it is load-bearing rather than tidy-up: Discord caps a guild at 250 roles and
  // this one already sits around 204, and hitting the ceiling blocks *all* role creation
  // server-wide, band roles included. It compares Discord's role list with the database, which
  // pg_cron can't see, hence the fixed schedule. See matchRole.ts for the age floor that keeps
  // it from deleting a role created seconds ago whose id hasn't been written back yet.
  let matchRolesReclaimed = 0;
  try {
    matchRolesReclaimed = await reclaimStrayMatchRoles(supabase);
  } catch (err) {
    console.error("Daily backstops: failed to reclaim stray match roles", err);
  }

  // Match Times' supercharged/non-supercharged day counters (see CLAUDE.md, "Match time
  // stats") — advances once per Pacific calendar day, classifying that day against the bonus
  // config as of right now. 09:30 UTC is just after midnight Pacific, so a daily run is enough.
  let matchTimeStatsDaysAdvanced = 0;
  try {
    matchTimeStatsDaysAdvanced = await advanceMatchTimeStatsDayCounters(new Date());
  } catch (err) {
    console.error("Daily backstops: failed to advance match-time-stats day counters", err);
  }

  return { matchRolesReclaimed, matchTimeStatsDaysAdvanced };
}
