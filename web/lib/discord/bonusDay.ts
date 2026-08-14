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
