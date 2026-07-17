import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import { editOriginalResponse } from "./rest";
import { hasAdminAccess, logAdminAction } from "./admin";
import { closeSeason } from "./seasonClose";
import { interactionUserId, type DiscordInteraction } from "./types";

function deferredEphemeral(run: () => Promise<void>) {
  after(run);
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

// ---------------------------------------------------------------------------
// /newseason — owner-or-admin-role gated. Closes any current season (median-compression MMR
// soft reset, season_history standings, Top 10/Prism role sync — see seasonClose.ts and
// CLAUDE.md, "Seasons") and opens the next one. Manual-trigger only for now — no scheduled
// monthly rollover.
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

  const supabase = createAdminClient();
  const today = new Date().toISOString().slice(0, 10);

  // Atomic claim: same UPDATE...WHERE-status pattern as report.ts/teamFormation.ts. A double
  // fire (Discord retry, an admin re-clicking because the deferred ACK gave no instant
  // feedback) must not run the soft reset twice — a double-decay would compress every
  // player's MMR toward the median twice over, silently corrupting ratings. Only the first
  // caller sees a matching row; a retry sees 0 rows back and skips straight to opening the
  // next season with no `current` to report.
  const { data: closedRows } = await supabase
    .from("crl6mansqueuebot_seasons")
    .update({ is_active: false, end_date: today })
    .eq("is_active", true)
    .select("id, season_number");
  const current = closedRows?.[0] ?? null;

  if (current) {
    await closeSeason(current);
  }

  const { data: latest } = await supabase
    .from("crl6mansqueuebot_seasons")
    .select("season_number")
    .order("season_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextNumber = (latest?.season_number ?? 0) + 1;

  const { data: created, error } = await supabase
    .from("crl6mansqueuebot_seasons")
    .insert({ season_number: nextNumber, start_date: today, is_active: true })
    .select("id")
    .single();
  if (error || !created) {
    await editOriginalResponse(interaction.token, { content: "Failed to create the new season — check logs." });
    return;
  }

  await logAdminAction(actorId, "new_season", created.id, `season_number=${nextNumber}`);
  await editOriginalResponse(interaction.token, {
    content: current
      ? `Closed season ${current.season_number} (standings recorded, MMR soft-reset, Top 10/Prism updated) and started season ${nextNumber}.`
      : `Started season ${nextNumber} (no prior active season).`,
  });
}
