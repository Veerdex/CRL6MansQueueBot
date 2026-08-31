import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import { editOriginalResponse } from "./rest";
import { hasAdminAccess, logAdminAction } from "./admin";
import { closeSeason } from "./seasonClose";
import { recomputeBands } from "./bands";
import { syncNicknameMedals } from "./nicknameSync";
import { deleteConfigValue } from "./config";
import { interactionUserId, type DiscordInteraction } from "./types";

function deferredEphemeral(run: () => Promise<void>) {
  after(run);
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

export type SeasonResetSummary = {
  closedSeasonNumber: number | null;
  newSeasonNumber: number;
  playersReset: number;
};

// Shared by the manual /newseason command and the automatic scheduled-reset sweep trigger
// (see scheduledReset.ts) — atomically closes any currently active season (standings, MMR
// soft reset, everyone back to Unranked — see seasonClose.ts and CLAUDE.md, "Seasons") and
// opens the next one, then runs recomputeBands() once against the freshly-opened season so a
// stale Prism holder from last season's now-reset games-played count is cleared immediately
// rather than waiting for their own next report.
export async function performSeasonReset(): Promise<SeasonResetSummary> {
  const supabase = createAdminClient();
  const today = new Date().toISOString().slice(0, 10);

  // Atomic claim: same UPDATE...WHERE-status pattern as report.ts/teamFormation.ts. A double
  // fire (Discord retry, an admin re-clicking because the deferred ACK gave no instant
  // feedback, or a sweep tick racing a manual /newseason) must not run the soft reset twice —
  // a double-decay would compress every player's MMR toward the median twice over, silently
  // corrupting ratings. Only the first caller sees a matching row; a retry sees 0 rows back
  // and skips straight to opening the next season with no `current` to report.
  const { data: closedRows } = await supabase
    .from("crl6mansqueuebot_seasons")
    .update({ is_active: false, end_date: today })
    .eq("is_active", true)
    .select("id, season_number");
  const current = closedRows?.[0] ?? null;

  let playersReset = 0;
  if (current) {
    const summary = await closeSeason(current);
    playersReset = summary.playersReset;
  }

  const { data: latest } = await supabase
    .from("crl6mansqueuebot_seasons")
    .select("season_number")
    .order("season_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextNumber = (latest?.season_number ?? 0) + 1;

  const { error } = await supabase
    .from("crl6mansqueuebot_seasons")
    .insert({ season_number: nextNumber, start_date: today, is_active: true })
    .select("id")
    .single();
  if (error) {
    throw new Error("Failed to create the new season");
  }

  await recomputeBands();

  // Podium medals for the season that just closed, applied now instead of waiting for the daily
  // sweep to pick them up. Best-effort: the season is already closed and reset in the database by
  // this point, and nickname writes must never be what fails a season rollover.
  try {
    await syncNicknameMedals();
  } catch (error) {
    console.error("Nickname medal sync failed after season close", error);
  }

  return { closedSeasonNumber: current?.season_number ?? null, newSeasonNumber: nextNumber, playersReset };
}

// ---------------------------------------------------------------------------
// /newseason — owner-or-admin-role gated. Closes any current season (median-compression MMR
// soft reset, season_history standings, every placed player reset back to Unranked — see
// seasonClose.ts and CLAUDE.md, "Seasons") and opens the next one, then runs recomputeBands()
// (bands.ts) once against the freshly-opened season —
// Prism is a live top-N overlay gated on *this season's* Rank Queue games played, so without an
// explicit recompute here, last season's Prism holders would stay Prism until their own next
// report happens to re-trigger it, even though the new season's games-played count just reset
// to zero under them. Manual-trigger only for now — no scheduled monthly rollover.
// ---------------------------------------------------------------------------

export function handleNewSeasonCommand(interaction: DiscordInteraction) {
  const confirmation = interaction.data?.options?.find((o) => o.name === "confirmation")?.value;
  return deferredEphemeral(() => processNewSeason(interaction, typeof confirmation === "string" ? confirmation : null));
}

async function processNewSeason(interaction: DiscordInteraction, confirmation: string | null) {
  if (confirmation !== "NEW SEASON") {
    await editOriginalResponse(interaction.token, { content: 'Confirmation failed. Type exactly: "NEW SEASON"' });
    return;
  }

  const actorId = interactionUserId(interaction);
  if (!actorId) {
    await editOriginalResponse(interaction.token, { content: "Couldn't identify you — try again." });
    return;
  }
  if (!(await hasAdminAccess(interaction))) {
    await editOriginalResponse(interaction.token, { content: "You don't have admin access." });
    return;
  }

  let summary: SeasonResetSummary;
  try {
    summary = await performSeasonReset();
  } catch {
    await editOriginalResponse(interaction.token, { content: "Failed to create the new season — check logs." });
    return;
  }

  // A manual reset supersedes any pending scheduled one — leaving it in place would just fire
  // a second, redundant close/reopen at the scheduled time.
  await deleteConfigValue("scheduled_season_reset_at");

  await logAdminAction(actorId, "new_season", undefined, `season_number=${summary.newSeasonNumber}`);
  await editOriginalResponse(interaction.token, {
    content: summary.closedSeasonNumber
      ? `Closed season ${summary.closedSeasonNumber} (standings recorded, MMR soft-reset, ${summary.playersReset} player(s) reset to Unranked) and started season ${summary.newSeasonNumber} (Prism cut refreshed for the new season).`
      : `Started season ${summary.newSeasonNumber} (no prior active season).`,
  });
}
