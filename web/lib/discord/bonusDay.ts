import "server-only";
import { getConfigNumber, getConfigValue, setConfigValue } from "./config";

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
  // Index 0=Sun..6=Sat, matching this file's existing convention — how many times each weekday
  // has occurred (as a Pacific calendar date) between startedAt and now, inclusive of both ends.
  daysOccurredByWeekday: number[];
}

// Powers the Match Times page's Day of Week averaging denominator ("how many Mondays have
// occurred so far") — pure calendar-date arithmetic with no config dependency, since a Monday is
// always a Monday regardless of any admin setting. (The supercharged/non-supercharged split used
// to live here too, computed the same way against the *current* bonus-day range — which was a
// real bug: changing the bonus range later silently reclassified every already-elapsed day, not
// just future ones, on every page load. That's now tracked by two persistent counters instead —
// see advanceMatchTimeStatsDayCounters/computeDayAdvanceSteps below.) Pure and exported so it's
// unit-testable independent of config/DB access, same as isDayInRange.
export function computeDayTrackingTotals(startedAt: Date, now: Date): DayTrackingTotals {
  const startUtc = calendarDayToUtcDate(pacificDateParts(startedAt));
  const endUtc = calendarDayToUtcDate(pacificDateParts(now));
  const totalDays = Math.max(1, Math.round((endUtc.getTime() - startUtc.getTime()) / MS_PER_DAY) + 1);

  const daysOccurredByWeekday = [0, 0, 0, 0, 0, 0, 0];

  for (let i = 0; i < totalDays; i++) {
    // getUTCDay() on a date built from Date.UTC(y, m-1, d) gives that calendar date's real
    // weekday (0=Sun..6=Sat) — safe here since calendarDayToUtcDate never carries a real time
    // component that could shift the date across a UTC day boundary.
    const weekday = new Date(startUtc.getTime() + i * MS_PER_DAY).getUTCDay();
    daysOccurredByWeekday[weekday]++;
  }

  return { totalDays, daysOccurredByWeekday };
}

// Pacific calendar date as "YYYY-MM-DD" — the storage/comparison format for
// match_time_stats_last_marked_date below, since plain ISO-date strings sort/compare correctly
// with ordinary string comparison and need no date-library parsing to persist or read back.
export function pacificDateString(date: Date): string {
  const { year, month, day } = pacificDateParts(date);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export interface DayAdvanceStep {
  date: string; // Pacific calendar date, YYYY-MM-DD
  supercharged: boolean;
}

// Pure: given the last Pacific calendar date already counted and "today" (both YYYY-MM-DD),
// returns one step per day that has now fully elapsed and needs counting — today itself is
// excluded since it hasn't finished yet. Each step's supercharged/non-supercharged
// classification is evaluated once, using the bonus config passed in — this is the actual fix
// for the old computeDayTrackingTotals behavior: a day's classification is decided when that day
// ends and never revisited, so changing the bonus range later can't silently rewrite days that
// already elapsed. (A catch-up gap, e.g. the sweep having been down for a few days, is still a
// best-effort approximation — every day in the gap is evaluated against whatever the config says
// right now, since there's no historical config log to consult for the exact days in between.)
// Pure and exported so it's unit-testable independent of config/DB access.
export function computeDayAdvanceSteps(
  lastMarkedDate: string,
  today: string,
  bonusDayEnabled: boolean,
  bonusDayStart: number,
  bonusDayEnd: number,
): DayAdvanceStep[] {
  const steps: DayAdvanceStep[] = [];
  let cursor = new Date(`${lastMarkedDate}T00:00:00Z`);
  const todayUtc = new Date(`${today}T00:00:00Z`);
  while (cursor.getTime() < todayUtc.getTime()) {
    cursor = new Date(cursor.getTime() + MS_PER_DAY);
    const weekday = cursor.getUTCDay();
    steps.push({
      date: cursor.toISOString().slice(0, 10),
      supercharged: bonusDayEnabled && isDayInRange(weekday, bonusDayStart, bonusDayEnd),
    });
  }
  return steps;
}

export const MATCH_TIME_STATS_SUPERCHARGED_DAYS_KEY = "match_time_stats_supercharged_days";
export const MATCH_TIME_STATS_NONSUPERCHARGED_DAYS_KEY = "match_time_stats_nonsupercharged_days";
export const MATCH_TIME_STATS_LAST_MARKED_DATE_KEY = "match_time_stats_last_marked_date";

// DB-backed wrapper around computeDayAdvanceSteps, called once per sweep tick (see
// web/app/api/discord/sweep/route.ts) — a no-op on nearly every tick (0 steps, since a Pacific
// day only rolls over once every ~1440 one-minute ticks), and catches up multiple days at once
// if the sweep was ever down across a day boundary. Returns how many days were counted this call.
export async function advanceMatchTimeStatsDayCounters(now: Date): Promise<number> {
  const lastMarked = await getConfigValue(MATCH_TIME_STATS_LAST_MARKED_DATE_KEY);
  if (!lastMarked) return 0; // not seeded yet — the migration that seeds it hasn't been applied

  const today = pacificDateString(now);
  const [enabled, start, end, superCount, nonSuperCount] = await Promise.all([
    getConfigNumber("bonus_day_enabled", 1),
    getConfigNumber("bonus_day_start", 6),
    getConfigNumber("bonus_day_end", 6),
    getConfigNumber(MATCH_TIME_STATS_SUPERCHARGED_DAYS_KEY, 0),
    getConfigNumber(MATCH_TIME_STATS_NONSUPERCHARGED_DAYS_KEY, 0),
  ]);

  const steps = computeDayAdvanceSteps(lastMarked, today, enabled === 1, start, end);
  if (steps.length === 0) return 0;

  const superchargedDelta = steps.filter((s) => s.supercharged).length;
  const nonSuperchargedDelta = steps.length - superchargedDelta;

  await Promise.all([
    setConfigValue(MATCH_TIME_STATS_SUPERCHARGED_DAYS_KEY, String(superCount + superchargedDelta)),
    setConfigValue(MATCH_TIME_STATS_NONSUPERCHARGED_DAYS_KEY, String(nonSuperCount + nonSuperchargedDelta)),
    setConfigValue(MATCH_TIME_STATS_LAST_MARKED_DATE_KEY, steps[steps.length - 1].date),
  ]);

  return steps.length;
}
