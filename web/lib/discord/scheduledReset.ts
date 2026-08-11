import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { editOriginalResponse } from "./rest";
import { hasAdminAccess, logAdminAction } from "./admin";
import { getConfigValue, setConfigValue, deleteConfigValue } from "./config";
import { interactionUserId, type DiscordInteraction, type CommandOption } from "./types";

function deferredEphemeral(run: () => Promise<void>) {
  after(run);
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

// Reused by the sweep route's auto-fire check (see sweep/route.ts) and the website's countdown
// (layout.tsx) — a plain ISO timestamp string in the generic crl6mansqueuebot_config table,
// same precedent as lobby_voice_channel_id/log_channel_id (no dedicated column/table needed).
export const SCHEDULED_RESET_CONFIG_KEY = "scheduled_season_reset_at";

function getParamValue(options: CommandOption[] | undefined, name: string): string | number | boolean | undefined {
  return options?.find((o) => o.name === name)?.value;
}

// The exact UTC instant of 12:00am America/Los_Angeles on (year, month, day) — see CLAUDE.md,
// "Seasons": a reset scheduled for a given date always fires at midnight Pacific the day AFTER
// it, i.e. once that day has fully finished. Single-correction technique, no iteration needed:
// guess a UTC instant for the target date assuming a fixed -8h (PST) offset, read back what that
// guess actually resolves to in Pacific local time via Intl, then correct by the exact delta.
// This is exact (not an approximation) because the guess and the true target sit on the same
// calendar day, so no DST transition can fall between them regardless of which offset (PST/PDT)
// actually applies that day.
export function pacificMidnightUTC(year: number, month: number, day: number): Date {
  const guess = Date.UTC(year, month - 1, day, 8, 0, 0);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(guess));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const hour = get("hour") % 24; // some ICU builds render midnight as "24" under hour12: false
  const resolvedLocal = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  const targetLocal = Date.UTC(year, month - 1, day, 0, 0, 0);
  return new Date(guess + (targetLocal - resolvedLocal));
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  // Date.UTC silently normalizes an out-of-range day/month (e.g. Feb 30 -> Mar 2) instead of
  // erroring — round-tripping and comparing catches exactly that case.
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

// ---------------------------------------------------------------------------
// /schedule-reset set year:<int> month:<int> day:<int> | clear — owner-or-admin-role gated,
// standalone top-level command (same precedent as /newseason, /chances — not an /admin
// subcommand). `set` schedules an automatic future season reset (fired by the sweep route, see
// CLAUDE.md); `clear` cancels a pending one. See CLAUDE.md, "Seasons" for the full design.
// ---------------------------------------------------------------------------

export function handleScheduleResetCommand(interaction: DiscordInteraction) {
  const sub = interaction.data?.options?.[0];
  return deferredEphemeral(() => processScheduleReset(interaction, sub?.name ?? null, sub?.options));
}

async function processScheduleReset(
  interaction: DiscordInteraction,
  subcommand: string | null,
  options: CommandOption[] | undefined,
) {
  const actorId = interactionUserId(interaction);
  if (!actorId) {
    await editOriginalResponse(interaction.token, { content: "Couldn't identify you — try again." });
    return;
  }
  if (!(await hasAdminAccess(interaction))) {
    await editOriginalResponse(interaction.token, { content: "You don't have admin access." });
    return;
  }

  if (subcommand === "clear") {
    const existing = await getConfigValue(SCHEDULED_RESET_CONFIG_KEY);
    if (!existing) {
      await editOriginalResponse(interaction.token, { content: "No season reset is currently scheduled." });
      return;
    }
    await deleteConfigValue(SCHEDULED_RESET_CONFIG_KEY);
    await logAdminAction(actorId, "schedule_reset_clear", undefined, `was scheduled for ${existing}`);
    await editOriginalResponse(interaction.token, { content: "Scheduled season reset cleared." });
    return;
  }

  if (subcommand === "set") {
    const year = getParamValue(options, "year");
    const month = getParamValue(options, "month");
    const day = getParamValue(options, "day");
    if (typeof year !== "number" || typeof month !== "number" || typeof day !== "number") {
      await editOriginalResponse(interaction.token, { content: "year, month, and day are all required." });
      return;
    }
    if (!isValidCalendarDate(year, month, day)) {
      await editOriginalResponse(interaction.token, { content: `${year}-${month}-${day} isn't a valid calendar date.` });
      return;
    }

    // Fires at 12:00am Pacific the day AFTER the specified date — Date.UTC normalizes
    // month/year rollovers (day 32 in January -> Feb 1), so day+1 needs no manual calendar math.
    const resetAt = pacificMidnightUTC(year, month, day + 1);
    if (resetAt.getTime() <= Date.now()) {
      await editOriginalResponse(interaction.token, { content: "That date has already passed — pick a future date." });
      return;
    }

    await setConfigValue(SCHEDULED_RESET_CONFIG_KEY, resetAt.toISOString());

    const unixSeconds = Math.floor(resetAt.getTime() / 1000);
    await logAdminAction(actorId, "schedule_reset_set", undefined, `resets at ${resetAt.toISOString()}`);
    await editOriginalResponse(interaction.token, {
      content:
        `Season reset scheduled for <t:${unixSeconds}:F> (<t:${unixSeconds}:R>) — ` +
        `12:00am Pacific the day after ${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}.`,
    });
    return;
  }

  await editOriginalResponse(interaction.token, { content: "Unknown subcommand." });
}
