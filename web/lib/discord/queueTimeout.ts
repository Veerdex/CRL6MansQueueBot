import "server-only";
import { after } from "next/server";
import { InteractionResponseType, InteractionResponseFlags } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PlayerRow } from "@/lib/supabase/types";
import { editOriginalResponse } from "./rest";
import { hasAdminAccess, logAdminAction } from "./admin";
import { refreshQueueMessage } from "./queue";
import { interactionUserId, resolvedUserDisplayName, type DiscordInteraction } from "./types";
import {
  describeTimeout,
  PERMANENT_STRIKE_LEVEL,
  strikeLabel,
  timeoutDurationMs,
  timeoutUntilForStrikeLevel,
  timeoutUntilFromDuration,
} from "./queueTimeoutRules";

type AdminClient = ReturnType<typeof createAdminClient>;

// ---------------------------------------------------------------------------
// /timeout user: [days:] [hours:] [minutes:] and /strike user: [level:] — admin-gated queue
// bans. Both overwrite the player's current timeout outright (a 0-length /timeout ends one
// early). /strike raises the player's strike level by one, or sets it to `level:` when given,
// and applies that level's timeout: 1 → 1 day, 2 → 3 days, 3 → 1 week, 4 → 1 month, 5+ →
// permanent; level 0 clears both the strikes and the timeout. Enforced on /q in queue.ts.
// See CLAUDE.md, "Queue timeouts and strikes".
// ---------------------------------------------------------------------------

function deferredEphemeral(run: () => Promise<void>) {
  after(run);
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  };
}

function optionValue(interaction: DiscordInteraction, name: string) {
  return interaction.data?.options?.find((o) => o.name === name)?.value;
}

function intOption(interaction: DiscordInteraction, name: string): number | null {
  const v = optionValue(interaction, name);
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

export function handleTimeoutCommand(interaction: DiscordInteraction) {
  return deferredEphemeral(() => runAdminCommand(interaction, processTimeout));
}

export function handleStrikeCommand(interaction: DiscordInteraction) {
  return deferredEphemeral(() => runAdminCommand(interaction, processStrike));
}

async function runAdminCommand(
  interaction: DiscordInteraction,
  run: (interaction: DiscordInteraction, actorId: string, target: PlayerRow) => Promise<void>,
) {
  try {
    const actorId = interactionUserId(interaction);
    if (!actorId) {
      await editOriginalResponse(interaction.token, { content: "Couldn't identify you — try again." });
      return;
    }
    if (!(await hasAdminAccess(interaction))) {
      await editOriginalResponse(interaction.token, { content: "You don't have admin access." });
      return;
    }
    const targetId = optionValue(interaction, "user");
    if (typeof targetId !== "string") {
      await editOriginalResponse(interaction.token, { content: "Missing user." });
      return;
    }
    const target = await getOrCreateTarget(createAdminClient(), interaction, targetId);
    await run(interaction, actorId, target);
  } catch (err) {
    console.error(`Unhandled error in /${interaction.data?.name}`, err);
    await editOriginalResponse(interaction.token, { content: "Something went wrong running that command." });
  }
}

// A player with no record yet still needs one so the timeout sticks for their first /q. Unlike
// getOrCreatePlayer this never rewrites an existing row's display_name — the name here comes
// from the target, not the caller, and may be missing from the payload.
async function getOrCreateTarget(supabase: AdminClient, interaction: DiscordInteraction, discordId: string): Promise<PlayerRow> {
  const { data: existing } = await supabase.from("crl6mansqueuebot_players").select("*").eq("discord_id", discordId).maybeSingle();
  if (existing) return existing;
  const { data: created, error } = await supabase
    .from("crl6mansqueuebot_players")
    .upsert({ discord_id: discordId, display_name: resolvedUserDisplayName(interaction, discordId) }, { onConflict: "discord_id", ignoreDuplicates: false })
    .select("*")
    .single();
  if (error || !created) throw new Error(`Failed to create player: ${error?.message}`);
  return created;
}

// A newly timed-out player is taken out of any queue they're sitting in, so they can't pop into
// a match they're barred from. An active series they're already locked into is left alone —
// /admin force-leave covers that.
async function dequeueTimedOutPlayer(supabase: AdminClient, playerId: string): Promise<boolean> {
  const { data: removed } = await supabase.from("crl6mansqueuebot_queue_members").delete().eq("player_id", playerId).select("queue_type");
  const queueTypes = [...new Set((removed ?? []).map((r) => r.queue_type))];
  await Promise.all(queueTypes.map((qt) => refreshQueueMessage(supabase, qt)));
  return queueTypes.length > 0;
}

async function processTimeout(interaction: DiscordInteraction, actorId: string, target: PlayerRow) {
  const days = intOption(interaction, "days") ?? 0;
  const hours = intOption(interaction, "hours") ?? 0;
  const minutes = intOption(interaction, "minutes") ?? 0;

  const now = new Date();
  const until = timeoutUntilFromDuration(timeoutDurationMs(days, hours, minutes), now);

  const supabase = createAdminClient();
  const { error } = await supabase.from("crl6mansqueuebot_players").update({ queue_timeout_until: until }).eq("id", target.id);
  if (error) throw new Error(`Failed to set timeout: ${error.message}`);
  const dequeued = until ? await dequeueTimedOutPlayer(supabase, target.id) : false;

  await logAdminAction(actorId, "queue_timeout", target.discord_id, undefined, [
    { field: "Duration", before: null, after: `${days}d ${hours}h ${minutes}m` },
    { field: "Timeout until", before: target.queue_timeout_until, after: until ?? "(none)" },
  ]);

  await editOriginalResponse(interaction.token, {
    content: until
      ? `<@${target.discord_id}> now has ${describeTimeout(until, now)} from queueing.${dequeued ? " Removed them from the queue." : ""}`
      : `<@${target.discord_id}>'s queue timeout has been cleared.`,
  });
}

async function processStrike(interaction: DiscordInteraction, actorId: string, target: PlayerRow) {
  const explicitLevel = intOption(interaction, "level");
  const supabase = createAdminClient();

  // Compare-and-set on strike_count so two admins striking the same player at once each land a
  // strike instead of both writing the same incremented value.
  let current = target;
  for (let attempt = 0; attempt < 5; attempt++) {
    const level = explicitLevel ?? Math.min(current.strike_count + 1, PERMANENT_STRIKE_LEVEL);
    const now = new Date();
    const until = timeoutUntilForStrikeLevel(level, now);

    const { data: updated, error } = await supabase
      .from("crl6mansqueuebot_players")
      .update({ strike_count: level, queue_timeout_until: until })
      .eq("id", current.id)
      .eq("strike_count", current.strike_count)
      .select("*")
      .maybeSingle();
    if (error) throw new Error(`Failed to set strike: ${error.message}`);

    if (!updated) {
      const { data: fresh } = await supabase.from("crl6mansqueuebot_players").select("*").eq("id", current.id).single();
      if (!fresh) throw new Error("Player disappeared mid-strike");
      current = fresh;
      continue;
    }

    const dequeued = until ? await dequeueTimedOutPlayer(supabase, current.id) : false;

    await logAdminAction(actorId, "strike", current.discord_id, undefined, [
      { field: "Strikes", before: String(current.strike_count), after: String(level) },
      { field: "Timeout until", before: current.queue_timeout_until, after: until ?? "(none)" },
    ]);

    await editOriginalResponse(interaction.token, {
      content:
        level === 0
          ? `<@${current.discord_id}>'s strikes have been reset to 0 and their queue timeout cleared.`
          : `<@${current.discord_id}> is now on **strike ${level}** (${strikeLabel(level)}) — ${describeTimeout(until, now)} from queueing.${dequeued ? " Removed them from the queue." : ""}`,
    });
    return;
  }

  await editOriginalResponse(interaction.token, { content: "That player's strikes kept changing underneath this command — try again." });
}
