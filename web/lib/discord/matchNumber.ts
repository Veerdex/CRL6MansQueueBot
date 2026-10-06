import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

// Live "preview" number for naming a match's transient Discord resources (its two team voice
// channels, and its temporary `@Match #n` role) while the match is still being played — the real
// match_number isn't assigned until the series actually reports (crl6mansqueuebot_assign_match_
// number, called from report.ts), so no genuine number exists yet at team-formation time. This
// estimates "what number would this match get if every currently in-flight match reported in the
// order it was created": the count of already-reported real matches, plus how many other
// in-flight real matches were created at or before this one. That second term is what makes
// multiple concurrent matches each get a distinct, increasing preview instead of every one of
// them showing the same "current max + 1" — but since matches don't necessarily *report* in pop
// order, a given match's preview can still end up different from its actual final match_number.
// Display-only and never persisted anywhere, so there's nothing to keep in sync when that happens.
//
// Lives in its own module rather than in teamFormation.ts (where it started, serving only the
// voice-channel names) because the match role is created one step earlier, from queue.ts's
// createMatchChannels. queue.ts and teamFormation.ts already import each other, and matchRole.ts
// is imported by both — so a neutral home is the only placement that doesn't add a cycle.
export async function computePreviewMatchNumber(supabase: AdminClient, seriesCreatedAt: string): Promise<number> {
  const [maxReportedResult, aheadCountResult] = await Promise.all([
    supabase
      .from("crl6mansqueuebot_series")
      .select("match_number")
      .eq("status", "reported")
      .eq("is_test_data", false)
      .not("match_number", "is", null)
      .order("match_number", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("crl6mansqueuebot_series")
      .select("*", { count: "exact", head: true })
      .in("status", ["forming", "active"])
      .eq("is_test_data", false)
      .lte("created_at", seriesCreatedAt),
  ]);
  const maxReported = (maxReportedResult.data as { match_number: number } | null)?.match_number ?? 0;
  const aheadCount = aheadCountResult.count ?? 0;
  return maxReported + aheadCount;
}
