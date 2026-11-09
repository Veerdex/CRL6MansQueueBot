// Pure rules for admin queue timeouts and strikes (/timeout, /strike) — no Discord or database
// code, so they're unit-testable on their own. See queueTimeout.ts for the command handlers and
// CLAUDE.md, "Queue timeouts and strikes".

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Postgres' 'infinity' timestamptz, as PostgREST returns it — a permanent ban.
export const PERMANENT_TIMEOUT = "infinity";

// Strike level -> timeout length. Level 0 clears the timeout; anything past the last entry is
// permanent. "1 month" is a flat 30 days.
export const STRIKE_DURATIONS_MS = [1 * DAY_MS, 3 * DAY_MS, 7 * DAY_MS, 30 * DAY_MS] as const;
export const PERMANENT_STRIKE_LEVEL = STRIKE_DURATIONS_MS.length + 1;

const STRIKE_LABELS = ["1 day", "3 days", "1 week", "1 month"];

export function strikeLabel(level: number): string {
  if (level <= 0) return "no timeout";
  return STRIKE_LABELS[level - 1] ?? "permanent";
}

export function timeoutDurationMs(days: number, hours: number, minutes: number): number {
  return days * DAY_MS + hours * HOUR_MS + minutes * MINUTE_MS;
}

// The queue_timeout_until value to store for a duration starting at `now`. A zero duration
// clears the timeout (null) rather than storing an instant that's already passed.
export function timeoutUntilFromDuration(durationMs: number, now: Date): string | null {
  if (durationMs <= 0) return null;
  return new Date(now.getTime() + durationMs).toISOString();
}

export function timeoutUntilForStrikeLevel(level: number, now: Date): string | null {
  if (level <= 0) return null;
  if (level > STRIKE_DURATIONS_MS.length) return PERMANENT_TIMEOUT;
  return timeoutUntilFromDuration(STRIKE_DURATIONS_MS[level - 1], now);
}

export type TimeoutState = { kind: "none" } | { kind: "permanent" } | { kind: "until"; until: Date; remainingMs: number };

export function timeoutState(queueTimeoutUntil: string | null, now: Date): TimeoutState {
  if (!queueTimeoutUntil) return { kind: "none" };
  if (queueTimeoutUntil === PERMANENT_TIMEOUT) return { kind: "permanent" };
  const until = new Date(queueTimeoutUntil);
  const remainingMs = until.getTime() - now.getTime();
  if (Number.isNaN(remainingMs) || remainingMs <= 0) return { kind: "none" };
  return { kind: "until", until, remainingMs };
}

// "2d 3h 15m" — rounded up to the minute so a timeout never reads as "0m" while still active.
export function formatRemaining(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / MINUTE_MS));
  const d = Math.floor(totalMinutes / (24 * 60));
  const h = Math.floor((totalMinutes % (24 * 60)) / 60);
  const m = totalMinutes % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.join(" ");
}

// Discord timestamp markup: full date/time plus a live relative countdown, both rendered in the
// viewer's own timezone.
export function discordTimestamp(until: Date): string {
  const unix = Math.floor(until.getTime() / 1000);
  return `<t:${unix}:f> (<t:${unix}:R>)`;
}

// The ephemeral reply a timed-out player gets from /q. null = not timed out.
export function queueBlockedMessage(queueTimeoutUntil: string | null, now: Date): string | null {
  const state = timeoutState(queueTimeoutUntil, now);
  if (state.kind === "none") return null;
  if (state.kind === "permanent") return "You're permanently timed out from queueing.";
  return `You're timed out from queueing for another **${formatRemaining(state.remainingMs)}** — until ${discordTimestamp(state.until)}.`;
}

// The ephemeral reply a timed-out nominee gets from a sub request's Accept button — subbing
// in is another way into a match, so the queue timeout covers it too. null = not timed out.
export function subBlockedMessage(queueTimeoutUntil: string | null, now: Date): string | null {
  const state = timeoutState(queueTimeoutUntil, now);
  if (state.kind === "none") return null;
  if (state.kind === "permanent") return "You're permanently timed out from queueing, so you can't sub in.";
  return `You're timed out from queueing for another **${formatRemaining(state.remainingMs)}** (until ${discordTimestamp(state.until)}), so you can't sub in.`;
}

export function isTimedOut(queueTimeoutUntil: string | null, now: Date): boolean {
  return timeoutState(queueTimeoutUntil, now).kind !== "none";
}

// How an admin-facing reply describes a newly stored timeout.
export function describeTimeout(queueTimeoutUntil: string | null, now: Date): string {
  const state = timeoutState(queueTimeoutUntil, now);
  if (state.kind === "none") return "no timeout";
  if (state.kind === "permanent") return "a permanent timeout";
  return `a ${formatRemaining(state.remainingMs)} timeout (until ${discordTimestamp(state.until)})`;
}
