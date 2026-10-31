import "server-only";
import { discordFetch, getGuildId } from "./rest";

// /report and /r's options depend on report_score_mode_enabled (see config.ts), and Discord
// command definitions are static — so /admin report-mode re-registers both commands with the
// matching shape at the moment the mode changes (and /correct with it — correctCommandOptions
// below). scripts/register-commands.mjs duplicates these shapes (it can't import TS, same precedent as CONFIG_KEYS) and picks one from the same
// config key, so a later bulk re-register doesn't silently revert /report to the other mode.

const STRING_OPTION = 3;
const INTEGER_OPTION = 4;

export const REPORT_COMMAND_NAMES = ["report", "r"] as const;

export function reportCommandOptions(scoreMode: boolean) {
  if (scoreMode) {
    return [
      { name: "my-games", description: "How many games did your team win?", type: INTEGER_OPTION, required: true, min_value: 0, max_value: 4 },
      { name: "opponent-games", description: "How many games did the other team win?", type: INTEGER_OPTION, required: true, min_value: 0, max_value: 4 },
    ];
  }
  return [
    {
      name: "result",
      description: "Did your team win or lose?",
      type: STRING_OPTION,
      required: true,
      choices: [
        { name: "win", value: "win" },
        { name: "loss", value: "loss" },
      ],
    },
  ];
}

// /correct follows the same mode (correct.ts): no options in win/loss mode (each vote is a flip),
// the actual score in score mode.
export function correctCommandOptions(scoreMode: boolean) {
  if (!scoreMode) return [];
  return [
    { name: "my-games", description: "How many games did your team actually win?", type: INTEGER_OPTION, required: true, min_value: 0, max_value: 4 },
    { name: "opponent-games", description: "How many games did the other team actually win?", type: INTEGER_OPTION, required: true, min_value: 0, max_value: 4 },
  ];
}

// PATCHes only the options of the existing /report, /r and /correct guild commands, leaving every
// other command (and their ids/permissions) untouched — unlike register-commands.mjs's bulk PUT.
// Throws if any command can't be found or updated, so the caller can refuse to flip the config.
export async function syncReportCommandOptions(scoreMode: boolean): Promise<void> {
  const appId = process.env.DISCORD_APPLICATION_ID;
  if (!appId) throw new Error("Missing DISCORD_APPLICATION_ID");
  const guildId = await getGuildId();
  const commands = (await discordFetch(`/applications/${appId}/guilds/${guildId}/commands`)) as { id: string; name: string }[];
  const targets: [string, unknown[]][] = [
    ...REPORT_COMMAND_NAMES.map((name): [string, unknown[]] => [name, reportCommandOptions(scoreMode)]),
    ["correct", correctCommandOptions(scoreMode)],
  ];
  for (const [name, options] of targets) {
    const command = commands.find((c) => c.name === name);
    if (!command) throw new Error(`/${name} isn't registered in this guild — run register-commands first.`);
    await discordFetch(`/applications/${appId}/guilds/${guildId}/commands/${command.id}`, {
      method: "PATCH",
      body: JSON.stringify({ options }),
    });
  }
}
