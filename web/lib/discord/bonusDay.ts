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

// Evaluated once at series-pop time (not report time) — the resulting multiplier is stored on
// the series row (`bonus_day_multiplier`) and reused unchanged whenever that series eventually
// settles. This is deliberate: eligibility is "the queue completed before the start of the next
// day," not "the match happened to be reported during the window" — a series that pops at
// 11:59pm Saturday and gets reported Sunday afternoon still earns the bonus. "The start of the
// next day" is read as midnight in the America/Los_Angeles zone (auto-switches PDT/PST with
// DST) rather than a hardcoded UTC-7 offset, since a fixed PDT offset would silently become
// wrong for half the year.
export async function computeBonusDayMultiplier(): Promise<number> {
  const enabled = await getConfigNumber("bonus_day_enabled", 1);
  if (enabled !== 1) return 1;
  const targetDay = await getConfigNumber("bonus_day_of_week", 6);
  if (currentPacificDayOfWeek() !== targetDay) return 1;
  const bonusPct = await getConfigNumber("bonus_day_bonus_pct", 50);
  return 1 + bonusPct / 100;
}

// Live "is today currently the supercharged day" check, for call sites with no series row to read
// a stored bonus_day_multiplier snapshot from yet (e.g. the first-queue-join ping embed). Series-
// tied embeds (vote, draft, teams-formed, report) should keep checking their own series'
// bonus_day_multiplier > 1 instead — see CLAUDE.md, "Weekly bonus day".
export async function isSuperchargedDayLive(): Promise<boolean> {
  return (await computeBonusDayMultiplier()) > 1;
}
