// Why pg_cron woke the sweep route (migration 0059). The single every-minute job asks Postgres
// what is due — crl6mansqueuebot_cron.due() — and only calls the route when something is, passing
// the reasons so the route runs just those passes. Every reason here must have a matching row in
// due(), and every row in due() a reason here; see CLAUDE.md, "Architecture".
export const SWEEP_REASONS = [
  "series_length_vote", // a BO3/5/7 vote ran out of time
  "vote_silence", // nobody voted Balanced/Captains in time
  "draft_pick", // a captain's pick timer ran out
  "sub_expiry", // a /sub nomination passed its timeout
  "mafia_lobby", // a waiting Mafia lobby never filled
  "series_expiry", // a series went unreported past series_timeout_hours
  "queue_inactivity", // someone sat in the queue past queue_member_timeout_minutes
  "orphan_channels", // a reported series still has match channels
  "match_role_release", // a settled series still holds its @Match role
  "stuck_mafia", // a Mafia lobby stuck in 'starting'
  "season_reset", // a scheduled season reset is due
] as const;

export type SweepReason = (typeof SWEEP_REASONS)[number];

// "all" = the whole sweep: a manual call with no body, or a body this code doesn't recognise
// (e.g. a reason added to due() before the code that handles it deployed). Running everything is
// always safe, since every pass re-checks its own condition.
export type SweepRequest = { kind: "all" } | { kind: "reasons"; reasons: ReadonlySet<SweepReason> };

export function parseSweepRequest(body: unknown): SweepRequest {
  const raw = (body as { reasons?: unknown } | null)?.reasons;
  if (!Array.isArray(raw)) return { kind: "all" };
  const known = raw.filter((r): r is SweepReason => SWEEP_REASONS.includes(r as SweepReason));
  if (known.length === 0) return { kind: "all" };
  return { kind: "reasons", reasons: new Set(known) };
}

export function sweepRuns(request: SweepRequest, ...reasons: SweepReason[]): boolean {
  return request.kind === "all" || reasons.some((r) => request.reasons.has(r));
}
