import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import { editOriginalResponse } from "./rest";
import { getOrCreatePlayer, getLockedSeriesForPlayer } from "./queue";
import { getConfigNumber } from "./config";
import { calculateTeamStrength } from "@/lib/mmr/teamStrength";
import { interactionUserId, interactionDisplayName, type DiscordInteraction } from "./types";
import type { SeriesRow, Team } from "@/lib/supabase/types";

type AdminClient = ReturnType<typeof createAdminClient>;

// ---------------------------------------------------------------------------
// /chances [id:] — with no id:, purely membership-based (like /report result:) — shows the
// caller's own team's live win probability for whichever active match they're locked into.
// `id:` is an optional override, open to everyone (unlike /report/sub/nominate/abandon/
// cancel's id: overrides, which are admin-gated since they trigger an action — this is
// read-only, so there's no action to gate), for checking any match's chances from outside it.
// Since an id:-override caller isn't necessarily a participant, that path shows both teams'
// percentages instead of picking a "your team" side (falls back to the participant/single-
// percentage view if the caller happens to actually be one of the 6). Uses the same
// calculateTeamStrength()/s_scale pair that actually governs Elo deltas at report time
// (report.ts), rather than the separate legacy plain-average prediction-logging formula in
// report.ts's game-prediction feature — this keeps "chances" consistent with what actually
// determines the outcome's MMR swing. Ephemeral throughout, per explicit request.
// ---------------------------------------------------------------------------

export function handleChancesCommand(interaction: DiscordInteraction) {
  const idOption = interaction.data?.options?.find((o) => o.name === "id")?.value;
  const seriesIdOverride = typeof idOption === "string" && idOption.length > 0 ? idOption : null;
  after(() => processChances(interaction, seriesIdOverride));
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

async function resolveSeriesForChances(
  supabase: AdminClient,
  seriesIdOverride: string | null,
  playerId: string,
): Promise<SeriesRow | null> {
  if (seriesIdOverride) {
    const { data } = await supabase.from("crl6mansqueuebot_series").select("*").eq("id", seriesIdOverride).maybeSingle();
    return data;
  }
  return getLockedSeriesForPlayer(supabase, playerId);
}

async function processChances(interaction: DiscordInteraction, seriesIdOverride: string | null) {
  const supabase = createAdminClient();
  const discordId = interactionUserId(interaction);
  if (!discordId) {
    await editOriginalResponse(interaction.token, { content: "Couldn't identify you — try again." });
    return;
  }

  const caller = await getOrCreatePlayer(supabase, discordId, interactionDisplayName(interaction));
  const series = await resolveSeriesForChances(supabase, seriesIdOverride, caller.id);
  if (!series) {
    await editOriginalResponse(interaction.token, { content: seriesIdOverride ? "Series not found." : "You're not part of an active match." });
    return;
  }
  if (series.status === "forming") {
    await editOriginalResponse(interaction.token, { content: "Teams haven't been finalized yet." });
    return;
  }
  if (series.status !== "active") {
    await editOriginalResponse(interaction.token, { content: "This match has already been settled." });
    return;
  }

  const { data: seriesPlayers } = await supabase.from("crl6mansqueuebot_series_players").select("*").eq("series_id", series.id);
  if (!seriesPlayers || seriesPlayers.length !== 6) {
    await editOriginalResponse(interaction.token, { content: "Something's wrong with this match's roster — ask an admin to check it." });
    return;
  }

  const { data: participants } = await supabase.from("crl6mansqueuebot_players").select("*").in(
    "id",
    seriesPlayers.map((sp) => sp.player_id),
  );
  const mmrByPlayerId = new Map((participants ?? []).map((p) => [p.id, p.mmr]));

  const callerRow = seriesPlayers.find((sp) => sp.player_id === caller.id);
  if (!callerRow && !seriesIdOverride) {
    await editOriginalResponse(interaction.token, { content: "You're not part of this match." });
    return;
  }

  const teamMmr = (team: Team) => seriesPlayers.filter((sp) => sp.team === team).map((sp) => mmrByPlayerId.get(sp.player_id) ?? 0);
  const strengthA = calculateTeamStrength(teamMmr("A"));
  const strengthB = calculateTeamStrength(teamMmr("B"));
  const sScale = await getConfigNumber("s_scale", 400);
  const expectedA = 1 / (1 + 10 ** ((strengthB - strengthA) / sScale));

  if (callerRow) {
    const expectedForCaller = callerRow.team === "A" ? expectedA : 1 - expectedA;
    const pct = Math.round(expectedForCaller * 100);
    await editOriginalResponse(interaction.token, { content: `# ${pct}% chance to win` });
    return;
  }

  const pctA = Math.round(expectedA * 100);
  const pctB = 100 - pctA;
  await editOriginalResponse(interaction.token, {
    content: `# Team A: ${pctA}% — Team B: ${pctB}%`,
  });
}
