// Bulk-registers this bot's slash commands with Discord. A bulk overwrite replaces the
// *entire* command set with exactly what's listed here, so every command the bot supports
// must be included even if unchanged.
//
// Registers per-guild (PUT /applications/{id}/guilds/{guild_id}/commands) rather than
// globally — guild commands propagate instantly, global commands can take up to ~1hr to
// show up, which would make live testing look broken. This bot is single-server, so
// guild-scoped is also just the correct long-term scope, not only a testing convenience.
// The guild is auto-detected from the bot's guild list (GET /users/@me/guilds) — set
// DISCORD_GUILD_ID explicitly if the bot is ever in more than one server.
//
// Run with: node --env-file=.env.local scripts/register-commands.mjs
// (reads DISCORD_BOT_TOKEN / DISCORD_APPLICATION_ID / optional DISCORD_GUILD_ID from the environment)

const STRING_OPTION = 3;
const INTEGER_OPTION = 4;
const USER_OPTION = 6;
const ROLE_OPTION = 8;
const NUMBER_OPTION = 10;
const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;

// Mirrors config.ts's KNOWN_CONFIG_DEFAULTS keys (and CLAUDE.md's "Config values" table) —
// duplicated here the same way setbandrole's band choices duplicate bands.ts's band list,
// since this script can't import the TS module directly.
const CONFIG_KEYS = [
  "k_factor",
  "s_scale",
  "hysteresis_pct",
  "grace_games",
  "provisional_games",
  "provisional_k_multiplier",
  "placement_games_required",
  "decay_factor",
  "top10_min_games",
  "series_timeout_hours",
  "vote_timeout_seconds",
  "sub_request_timeout_minutes",
  "queue_member_timeout_minutes",
  "band_cutoff_garnet_pctile",
  "band_cutoff_emerald_pctile",
  "band_cutoff_sapphire_pctile",
  "season_rank_display_min_games",
];
const CONFIG_KEY_CHOICES = CONFIG_KEYS.map((k) => ({ name: k, value: k }));

const commands = [
  {
    name: "help",
    description: "Show available commands.",
    type: 1,
  },
  {
    name: "setqueuechannel",
    description: "Post the persistent queue message in this channel.",
    type: 1,
    options: [
      {
        name: "queue_type",
        description: "Which queue this channel is for.",
        type: STRING_OPTION,
        required: true,
        choices: [
          { name: "rank", value: "rank" },
          { name: "universal", value: "universal" },
        ],
      },
    ],
  },
  {
    name: "set6manscallcategory",
    description: "Set the 6-mans voice channel category (infers parent if omitted).",
    type: 1,
    options: [
      {
        name: "category",
        description: "The category for voice channels.",
        type: 7,
        required: false,
      },
    ],
  },
  {
    name: "setreportchannel",
    description: "Set the match report channel (infers current channel if omitted).",
    type: 1,
    options: [
      {
        name: "channel",
        description: "The channel to post results in.",
        type: 7,
        required: false,
      },
    ],
  },
  {
    name: "q",
    description: "Join the queue mapped to this channel.",
    type: 1,
  },
  {
    name: "queue",
    description: "Join the queue mapped to this channel.",
    type: 1,
  },
  {
    name: "l",
    description: "Leave the queue mapped to this channel.",
    type: 1,
  },
  {
    name: "leave",
    description: "Leave the queue mapped to this channel.",
    type: 1,
  },
  {
    name: "add-admin-role",
    description: "Grant a Discord role admin access and match-channel visibility.",
    type: 1,
    options: [
      {
        name: "role",
        description: "The role to grant admin access to.",
        type: ROLE_OPTION,
        required: true,
      },
    ],
  },
  {
    name: "remove-admin-role",
    description: "Revoke a Discord role's admin access.",
    type: 1,
    options: [
      {
        name: "role",
        description: "The role to revoke admin access from.",
        type: ROLE_OPTION,
        required: true,
      },
    ],
  },
  {
    name: "list-admin-roles",
    description: "List Discord roles with admin access.",
    type: 1,
  },
  {
    name: "newseason",
    description: "Close the current season (if any) and start the next one.",
    type: 1,
  },
  {
    name: "vote-default",
    description: "Set or clear your default team-formation vote.",
    type: 1,
    options: [
      {
        name: "mode",
        description: "Your default vote, or clear to remove.",
        type: STRING_OPTION,
        required: true,
        choices: [
          { name: "balanced", value: "balanced" },
          { name: "captains", value: "captains" },
          { name: "clear", value: "clear" },
        ],
      },
    ],
  },
  {
    name: "report",
    description: "Report your match's result.",
    type: 1,
    options: [
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
      {
        name: "id",
        description: "Series id override — admins only.",
        type: STRING_OPTION,
        required: false,
      },
    ],
  },
  {
    name: "r",
    description: "Report your match's result (alias for /report).",
    type: 1,
    options: [
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
      {
        name: "id",
        description: "Series id override — admins only.",
        type: STRING_OPTION,
        required: false,
      },
    ],
  },
  {
    name: "sub",
    description: "Nominate a replacement to take your seat in your current match (run inside the match channel).",
    type: 1,
    options: [
      {
        name: "nominee",
        description: "The player to nominate as your replacement.",
        type: USER_OPTION,
        required: true,
      },
      {
        name: "id",
        description: "Series id override — admins only, for subbing from outside the match channel.",
        type: STRING_OPTION,
        required: false,
      },
    ],
  },
  {
    name: "setbandrole",
    description: "Map a band (or the Placed gate / Prism Top 10 role) to a Discord role for auto role-sync.",
    type: 1,
    options: [
      {
        name: "band",
        description: "Which band (or Placed) this role represents.",
        type: STRING_OPTION,
        required: true,
        choices: [
          { name: "Iron", value: "Iron" },
          { name: "Garnet", value: "Garnet" },
          { name: "Emerald", value: "Emerald" },
          { name: "Sapphire", value: "Sapphire" },
          { name: "Placed", value: "Placed" },
          { name: "Prism", value: "Prism" },
        ],
      },
      {
        name: "role",
        description: "The Discord role to grant/revoke for this band.",
        type: ROLE_OPTION,
        required: true,
      },
    ],
  },
  {
    name: "admin",
    description: "Admin tools.",
    type: 1,
    options: [
      {
        name: "unreport",
        description: "Reverse a reported series and unwind its MMR/games-played changes.",
        type: SUB_COMMAND,
        options: [
          {
            name: "id",
            description: "The series id to unreport.",
            type: STRING_OPTION,
            required: true,
          },
        ],
      },
      {
        name: "cancel-series",
        description: "Void an in-progress series (run inside its match channel, or pass id: from elsewhere).",
        type: SUB_COMMAND,
        options: [
          {
            name: "id",
            description: "Series id override — for cancelling from outside the match channel.",
            type: STRING_OPTION,
            required: false,
          },
        ],
      },
      {
        name: "adjust-mmr",
        description: "Manually adjust a player's MMR — provide exactly one of delta or mmr.",
        type: SUB_COMMAND,
        options: [
          {
            name: "target",
            description: "The player to adjust.",
            type: USER_OPTION,
            required: true,
          },
          {
            name: "delta",
            description: "Relative change to apply to their current MMR.",
            type: NUMBER_OPTION,
            required: false,
          },
          {
            name: "mmr",
            description: "Absolute MMR value to set.",
            type: NUMBER_OPTION,
            required: false,
          },
        ],
      },
      {
        name: "force-leave",
        description: "Dequeue a player and/or void any active series they're locked into.",
        type: SUB_COMMAND,
        options: [
          {
            name: "target",
            description: "The player to remove.",
            type: USER_OPTION,
            required: true,
          },
        ],
      },
      {
        name: "recompute-bands",
        description: "Manually trigger the daily band recompute.",
        type: SUB_COMMAND,
      },
      {
        name: "config",
        description: "Get or set an admin-tunable config value.",
        type: SUB_COMMAND_GROUP,
        options: [
          {
            name: "get",
            description: "Show a config value (or all of them, if key is omitted).",
            type: SUB_COMMAND,
            options: [
              {
                name: "key",
                description: "The config key to look up.",
                type: STRING_OPTION,
                required: false,
                choices: CONFIG_KEY_CHOICES,
              },
            ],
          },
          {
            name: "set",
            description: "Set a config value.",
            type: SUB_COMMAND,
            options: [
              {
                name: "key",
                description: "The config key to set.",
                type: STRING_OPTION,
                required: true,
                choices: CONFIG_KEY_CHOICES,
              },
              {
                name: "value",
                description: "The new numeric value.",
                type: NUMBER_OPTION,
                required: true,
              },
            ],
          },
        ],
      },
      {
        name: "audit-log",
        description: "Show recent admin actions.",
        type: SUB_COMMAND,
        options: [
          {
            name: "limit",
            description: "How many entries to show (default 10, max 25).",
            type: INTEGER_OPTION,
            required: false,
          },
        ],
      },
      {
        name: "test-flow",
        description: "Create a temporary test match to try the queue→teams→report flow (auto-cleanup on /report).",
        type: SUB_COMMAND,
        options: [
          {
            name: "mode",
            description: "Team formation mode for the test bots to vote for.",
            type: STRING_OPTION,
            required: true,
            choices: [
              { name: "captains", value: "captains" },
              { name: "balanced", value: "balanced" },
            ],
          },
        ],
      },
    ],
  },
  {
    name: "test-rank-match",
    description: "Admin: spin up a simulated Rank Queue match (you + 5 test bots) to try the flow yourself.",
    type: 1,
  },
  {
    name: "test-universal-match",
    description: "Admin: spin up a simulated Universal Queue match (you + 5 test bots) to try the flow yourself.",
    type: 1,
  },
  {
    name: "end-test",
    description: "Admin: tear down the test match in this channel (channels + its test data).",
    type: 1,
  },
];

const token = process.env.DISCORD_BOT_TOKEN;
const appId = process.env.DISCORD_APPLICATION_ID;

if (!token || !appId) {
  console.error("Missing DISCORD_BOT_TOKEN or DISCORD_APPLICATION_ID in the environment.");
  process.exit(1);
}

let guildId = process.env.DISCORD_GUILD_ID;

if (!guildId) {
  const guildsRes = await fetch("https://discord.com/api/v10/users/@me/guilds", {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!guildsRes.ok) {
    console.error(`Failed to list bot guilds: ${guildsRes.status} ${await guildsRes.text()}`);
    process.exit(1);
  }
  const guilds = await guildsRes.json();
  if (guilds.length !== 1) {
    console.error(
      guilds.length === 0
        ? "Bot isn't in any guild yet — invite it first, or set DISCORD_GUILD_ID explicitly."
        : `Bot is in ${guilds.length} guilds — set DISCORD_GUILD_ID explicitly to pick one: ${guilds.map((g) => `${g.name} (${g.id})`).join(", ")}`,
    );
    process.exit(1);
  }
  guildId = guilds[0].id;
  console.log(`Auto-detected guild: ${guilds[0].name} (${guildId})`);
}

const res = await fetch(`https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(commands),
});

if (!res.ok) {
  console.error(`Registration failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}

const registered = await res.json();
console.log(`Registered ${registered.length} commands:`, registered.map((c) => c.name).join(", "));
