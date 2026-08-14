import "server-only";
import { getConfigNumber } from "./config";

// Sun=0 .. Sat=6, matching JS/Intl weekday ordering — see CLAUDE.md's "Weekly bonus day" note.
// Exported so the admin set-day command can render/validate its choices against the same list.
export const BONUS_DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Exported for matchTimeStats.ts, which needs the same Sun=0..Sat=6 Pacific-time day-of-week
// index for the weekly graph's increment — reused rather than reimplemented.
export function currentPacificDayOfWeek(): number {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short" }).format(new Date());
  return WEEKDAY_INDEX[weekday];
}

// Range membership, wraparound-aware: when start <= end it's a normal inclusive range
// (e.g. Mon(1)..Wed(3) -> Mon,Tue,Wed); when start > end it wraps through the week boundary
// (e.g. Fri(5)..Sun(0) -> Fri,Sat,Sun) instead of matching nothing. Every start/end
// combination is therefore meaningful — start==end is a single-day range (the original
// bonus_day_of_week behavior), start=0/end=6 (or any full lap) covers every day. Exported
// and pure so it's unit-testable independent of config/DB access.
export function isDayInRange(day: number, start: number, end: number): boolean {
  if (start <= end) return day >= start && day <= end;
  return day >= start || day <= end;
}

// Evaluated once at series-pop time (not report time) — the resulting multiplier is stored on
// the series row (`bonus_day_multiplier`) and reused unchanged whenever that series eventually
// settles. This is deliberate: eligibility is "the queue completed before the start of the next
// day (the day after the range's end day)," not "the match happened to be reported during the
// window" — a series that pops at 11:59pm on the range's last day and gets reported the next
// afternoon still earns the bonus. "The start of the next day" is read as midnight in the
// America/Los_Angeles zone (auto-switches PDT/PST with DST) rather than a hardcoded UTC-7
// offset, since a fixed PDT offset would silently become wrong for half the year.
export async function computeBonusDayMultiplier(): Promise<number> {
  // Fetched together rather than sequentially short-circuited on `enabled` — config.ts caches
  // the whole config table in one request regardless of how many individual keys are asked for,
  // so there's no longer a round trip to save by reading fewer keys; parallelizing just avoids a
  // few extra sequential microtask ticks per call, and this runs on every queue join/leave.
  const [enabled, startDay, endDay, bonusPct] = await Promise.all([
    getConfigNumber("bonus_day_enabled", 1),
    getConfigNumber("bonus_day_start", 6),
    getConfigNumber("bonus_day_end", 6),
    getConfigNumber("bonus_day_bonus_pct", 50),
  ]);
  if (enabled !== 1) return 1;
  if (!isDayInRange(currentPacificDayOfWeek(), startDay, endDay)) return 1;
  return 1 + bonusPct / 100;
}

// Live "is today currently the supercharged day" check, for call sites with no series row to read
// a stored bonus_day_multiplier snapshot from yet (e.g. the first-queue-join ping embed). Series-
// tied embeds (vote, draft, teams-formed, report) should keep checking their own series'
// bonus_day_multiplier > 1 instead — see CLAUDE.md, "Weekly bonus day".
export async function isSuperchargedDayLive(): Promise<boolean> {
  return (await computeBonusDayMultiplier()) > 1;
}

// Pacific calendar-date components (not an instant) — used below to do whole-day arithmetic
// without DST tripping up a plain millisecond subtraction across a spring-forward/fall-back
// boundary.
function pacificDateParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return {
    year: Number(parts.find((p) => p.type === "year")!.value),
    month: Number(parts.find((p) => p.type === "month")!.value),
    day: Number(parts.find((p) => p.type === "day")!.value),
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// A Pacific calendar date, anchored at UTC midnight purely so day-count arithmetic (subtracting/
// adding whole days) is safe regardless of DST — only the Y/M/D components matter here, never a
// real instant, so there's no timezone-conversion bug to worry about.
function calendarDayToUtcDate({ year, month, day }: { year: number; month: number; day: number }): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

export interface DayTrackingTotals {
  totalDays: number;
  superchargedDays: number;
  nonSuperchargedDays: number;
  // Index 0=Sun..6=Sat, matching this file's existing convention — how many times each weekday
  // has occurred (as a Pacific calendar date) between startedAt and now, inclusive of both ends.
  daysOccurredByWeekday: number[];
}

// Powers the Match Times page's per-day averaging (see CLAUDE.md, "Match time stats") — the
// denominator for "matches per day" is computed live from a single stored start timestamp rather
// than a second set of incrementing counters, since it's pure calendar-date arithmetic against
// the *current* bonus-day range config. That's a known approximation if the admin has changed the
// bonus range since startedAt (there's no historical config log to consult, same precedent as
// every other place in this codebase that reads current config against historical data) — an
// accepted tradeoff for not needing a whole second daily-cron-driven counter system. Pure and
// exported so it's unit-testable independent of config/DB access, same as isDayInRange.
export function computeDayTrackingTotals(
  startedAt: Date,
  now: Date,
  bonusDayEnabled: boolean,
  bonusDayStart: number,
  bonusDayEnd: number,
): DayTrackingTotals {
  const startUtc = calendarDayToUtcDate(pacificDateParts(startedAt));
  const endUtc = calendarDayToUtcDate(pacificDateParts(now));
  const totalDays = Math.max(1, Math.round((endUtc.getTime() - startUtc.getTime()) / MS_PER_DAY) + 1);

  const daysOccurredByWeekday = [0, 0, 0, 0, 0, 0, 0];
  let superchargedDays = 0;

  for (let i = 0; i < totalDays; i++) {
    // getUTCDay() on a date built from Date.UTC(y, m-1, d) gives that calendar date's real
    // weekday (0=Sun..6=Sat) — safe here since calendarDayToUtcDate never carries a real time
    // component that could shift the date across a UTC day boundary.
    const weekday = new Date(startUtc.getTime() + i * MS_PER_DAY).getUTCDay();
    daysOccurredByWeekday[weekday]++;
    if (bonusDayEnabled && isDayInRange(weekday, bonusDayStart, bonusDayEnd)) {
      superchargedDays++;
    }
  }

  return {
    totalDays,
    superchargedDays,
    nonSuperchargedDays: totalDays - superchargedDays,
    daysOccurredByWeekday,
  };
}
