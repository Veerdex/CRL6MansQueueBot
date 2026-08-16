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
const BOOLEAN_OPTION = 5;
const USER_OPTION = 6;
const ROLE_OPTION = 8;
const NUMBER_OPTION = 10;
const ATTACHMENT_OPTION = 11;
const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;

// Sun=0..Sat=6, matching bonusDay.ts's BONUS_DAY_NAMES convention — duplicated here (this
// script can't import the TS module directly, same precedent as CONFIG_KEYS above) and shared
// by both bonus-day set-start-day/set-end-day options below so the two don't drift apart.
const BONUS_DAY_CHOICES = [
  { name: "Sunday", value: "0" },
  { name: "Monday", value: "1" },
  { name: "Tuesday", value: "2" },
  { name: "Wednesday", value: "3" },
  { name: "Thursday", value: "4" },
  { name: "Friday", value: "5" },
  { name: "Saturday", value: "6" },
];

// Mirrors config.ts's KNOWN_CONFIG_DEFAULTS keys (and CLAUDE.md's "Config values" table) —
// duplicated here the same way setbandrole's band choices duplicate bands.ts's band list,
// since this script can't import the TS module directly. No longer wired into the /admin
// config get/set key: option as Discord `choices` (STRING_OPTION choices are capped at 25,
// and this list grew past that) — the key: option is plain free-text now, validated
// server-side against KNOWN_CONFIG_DEFAULTS in adminTools.ts regardless. Kept here anyway as
// the documented list of which keys are meant to be settable through the generic
// /admin config set, since config.ts's own comments (KNOWN_CONFIG_DEFAULTS) point back at it.
const CONFIG_KEYS = [
  "k_factor",
  "s_scale",
  "hysteresis_mmr",
  "grace_games",
  "grace_inactivity_days",
  "provisional_games",
  "provisional_k_multiplier",
  "placement_games_required",
  "decay_factor",
  "top10_min_games",
  "prism_top_n",
  "series_timeout_hours",
  "vote_timeout_seconds",
  "sub_request_timeout_minutes",
  "queue_member_timeout_minutes",
  "report_cooldown_minutes",
  "band_cutoff_garnet_pctile",
  "band_cutoff_emerald_pctile",
  "band_cutoff_sapphire_pctile",
  "season_rank_display_min_games",
  "mmr_scale",
  "mmr_shift",
  "mmr_skew_factor",
  "mmr_min_delta",
  "mafia_grace_seconds",
  "mafia_timeout_seconds",
];

const commands = [
  {
    name: "help",
    description: "Show available commands.",
    type: 1,
  },
  {
    name: "site",
    description: "Get the link to the leaderboard website.",
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
    name: "setlogchannel",
    description: "Set the channel where admin change-log embeds are posted (infers current channel if omitted).",
    type: 1,
    options: [
      {
        name: "channel",
        description: "The channel to post admin change-log embeds in.",
        type: 7,
        required: false,
      },
    ],
  },
  {
    name: "setlobbychannel",
    description: "Set the voice channel players are moved to when their match ends.",
    type: 1,
    options: [
      {
        name: "channel",
        description: "The voice channel to move players into after a match.",
        type: 7,
        // 2 = GUILD_VOICE, 13 = GUILD_STAGE_VOICE — restricts the picker to channels a member
        // can actually be moved into.
        channel_types: [2, 13],
        required: true,
      },
    ],
  },
  {
    name: "setqueuementionrole",
    description: "Set the role to mention when first player joins a queue.",
    type: 1,
    options: [
      {
        name: "queue_type",
        description: "Which queue this role is for.",
        type: STRING_OPTION,
        required: true,
        choices: [
          { name: "rank", value: "rank" },
          { name: "universal", value: "universal" },
        ],
      },
      {
        name: "role",
        description: "The role to mention on first join.",
        type: ROLE_OPTION,
        required: true,
      },
    ],
  },
  {
    name: "setnotificationchannel",
    description: "Post the notification preference message in this channel.",
    type: 1,
  },
  {
    name: "setnotificationrole",
    description: "Set the role for queue notifications.",
    type: 1,
    options: [
      {
        name: "queue_type",
        description: "Which queue this role is for.",
        type: STRING_OPTION,
        required: true,
        choices: [
          { name: "rank", value: "rank" },
          { name: "universal", value: "universal" },
        ],
      },
      {
        name: "role",
        description: "The role to use for notifications.",
        type: ROLE_OPTION,
        required: true,
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
    name: "status",
    description: "Show who's currently in the queue mapped to this channel.",
    type: 1,
  },
  {
    name: "ranks",
    description: "Show the live player count, emoji, and MMR cutoff for each rank.",
    type: 1,
  },
  {
    name: "chances",
    description: "Show a team's live win chance for a match. Admin only.",
    type: 1,
    options: [
      {
        name: "id",
        description: "Series id override — check any match's chances from outside it.",
        type: STRING_OPTION,
        required: false,
      },
    ],
  },
  {
    name: "profile",
    description: "Show a player's band, MMR, streak, wins/losses, and leaderboard rank.",
    type: 1,
    options: [
      {
        name: "target",
        description: "Whose profile to show — defaults to yourself.",
        type: USER_OPTION,
        required: false,
      },
    ],
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
    options: [
      {
        name: "confirmation",
        description: 'Type "NEW SEASON" to confirm this action.',
        type: STRING_OPTION,
        required: true,
      },
    ],
  },
  {
    name: "schedule-reset",
    description: "Schedule or clear an automatic future season reset.",
    type: 1,
    options: [
      {
        name: "set",
        description: "Schedule a season reset for 12:00am Pacific the day after the given date.",
        type: SUB_COMMAND,
        options: [
          {
            name: "year",
            description: "Year, e.g. 2026.",
            type: INTEGER_OPTION,
            required: true,
          },
          {
            name: "month",
            description: "Month (1-12).",
            type: INTEGER_OPTION,
            required: true,
            min_value: 1,
            max_value: 12,
          },
          {
            name: "day",
            description: "Day of month (1-31).",
            type: INTEGER_OPTION,
            required: true,
            min_value: 1,
            max_value: 31,
          },
        ],
      },
      {
        name: "clear",
        description: "Cancel the currently scheduled season reset, if any.",
        type: SUB_COMMAND,
        options: [],
      },
    ],
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
    name: "nominate",
    description: "Request a sub for any player in your match, including yourself (run inside the match channel).",
    type: 1,
    options: [
      {
        name: "target",
        description: "The player who needs to be subbed out.",
        type: USER_OPTION,
        required: true,
      },
      {
        name: "nominee",
        description: "The player to nominate as their replacement.",
        type: USER_OPTION,
        required: true,
      },
      {
        name: "id",
        description: "Series id override — admins only, for nominating from outside the match channel.",
        type: STRING_OPTION,
        required: false,
      },
    ],
  },
  {
    name: "abandon",
    description: "Vote that a player has abandoned your current match (3 of the other 5 needed).",
    type: 1,
    options: [
      {
        name: "target",
        description: "The player you're reporting as having abandoned the match.",
        type: USER_OPTION,
        required: true,
      },
      {
        name: "id",
        description: "Series id override — admins only, for voting from outside the match channel.",
        type: STRING_OPTION,
        required: false,
      },
    ],
  },
  {
    name: "cancel",
    description: "Vote to cancel your current match (4 of 6 needed, no MMR change).",
    type: 1,
    options: [
      {
        name: "id",
        description: "Series id override — admins only, for cancelling from outside the match channel.",
        type: STRING_OPTION,
        required: false,
      },
    ],
  },
  {
    name: "setbandrole",
    description: "Map a band (or the Placed gate / Prism season-Top-N role) to a Discord role for auto role-sync.",
    type: 1,
    options: [
      {
        name: "band",
        description: "Which band (or Unranked) this role represents.",
        type: STRING_OPTION,
        required: true,
        choices: [
          { name: "Iron", value: "Iron" },
          { name: "Garnet", value: "Garnet" },
          { name: "Emerald", value: "Emerald" },
          { name: "Sapphire", value: "Sapphire" },
          { name: "Unranked", value: "Unranked" },
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
    name: "setmentionrole",
    description: "Set the role to mention when the first player joins an empty queue.",
    type: 1,
    options: [
      {
        name: "queue_type",
        description: "Which queue this role is for.",
        type: STRING_OPTION,
        required: true,
        choices: [
          { name: "rank", value: "rank" },
          { name: "universal", value: "universal" },
        ],
      },
      {
        name: "role",
        description: "The Discord role to mention.",
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
            description: "The match number from the report (e.g. 55), or the series id.",
            type: STRING_OPTION,
            required: true,
          },
        ],
      },
      {
        name: "correct-report",
        description: "Correct the reported winner for a series (reverses old MMR deltas and applies new ones).",
        type: SUB_COMMAND,
        options: [
          {
            name: "id",
            description: "The match number from the report (e.g. 55), or the series id.",
            type: STRING_OPTION,
            required: true,
          },
          {
            name: "winner",
            description: "The correct winning team.",
            type: STRING_OPTION,
            required: true,
            choices: [
              { name: "Team A", value: "team_a" },
              { name: "Team B", value: "team_b" },
            ],
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
        name: "cancel-matches",
        description: "Cancel all active and forming matches.",
        type: SUB_COMMAND,
        options: [],
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
        options: [
          {
            name: "force",
            description: "Bypass grace/hysteresis and reseat everyone to their true percentile (one-time fix).",
            type: BOOLEAN_OPTION,
            required: false,
          },
        ],
      },
      {
        name: "refresh-avatars",
        description: "Manually trigger the daily avatar refresh.",
        type: SUB_COMMAND,
        options: [],
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
                description: "The config key to look up (see /admin config get with no key for the full list).",
                type: STRING_OPTION,
                required: false,
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
                description: "The config key to set (see /admin config get with no key for the full list).",
                type: STRING_OPTION,
                required: true,
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
        name: "bonus-day",
        description: "Configure the weekly bonus-MMR day range.",
        type: SUB_COMMAND_GROUP,
        options: [
          {
            name: "toggle",
            description: "Turn the weekly bonus day on or off.",
            type: SUB_COMMAND,
            options: [
              {
                name: "enabled",
                description: "Whether the bonus day is active.",
                type: BOOLEAN_OPTION,
                required: true,
              },
            ],
          },
          {
            name: "set-bonus",
            description: "Set the K-factor bonus percentage applied during the bonus day.",
            type: SUB_COMMAND,
            options: [
              {
                name: "percent",
                description: "Bonus percentage, e.g. 50 for +50% (K x1.5).",
                type: NUMBER_OPTION,
                required: true,
              },
            ],
          },
          {
            name: "set-start-day",
            description: "Set the first day of the bonus range (12am Pacific start).",
            type: SUB_COMMAND,
            options: [
              {
                name: "day",
                description: "The bonus range's start day.",
                type: STRING_OPTION,
                required: true,
                choices: BONUS_DAY_CHOICES,
              },
            ],
          },
          {
            name: "set-end-day",
            description: "Set the last day of the bonus range (ends 12am Pacific the day after).",
            type: SUB_COMMAND,
            options: [
              {
                name: "day",
                description: "The bonus range's end day.",
                type: STRING_OPTION,
                required: true,
                choices: BONUS_DAY_CHOICES,
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
      {
        name: "set-rank-emoji",
        description: "Upload and assign a custom emoji for a rank band.",
        type: SUB_COMMAND,
        options: [
          {
            name: "band",
            description: "Which rank band to assign the emoji to.",
            type: STRING_OPTION,
            required: true,
            choices: [
              { name: "Iron", value: "Iron" },
              { name: "Garnet", value: "Garnet" },
              { name: "Emerald", value: "Emerald" },
              { name: "Sapphire", value: "Sapphire" },
              { name: "Prism (season Top N)", value: "Prism" },
              { name: "Unranked", value: "Unranked" },
            ],
          },
          {
            name: "image",
            description: "The emoji image file (PNG recommended).",
            type: ATTACHMENT_OPTION,
            required: true,
          },
        ],
      },
      {
        name: "reset",
        description: "DANGER: Wipe all game data and reset to a clean slate (keeps configuration).",
        type: SUB_COMMAND,
        options: [
          {
            name: "confirmation",
            description: 'Type "SEASON RESET" to confirm this destructive action.',
            type: STRING_OPTION,
            required: true,
          },
        ],
      },
      {
        name: "full-reset",
        description: "DANGER: Complete factory reset — wipes ALL data including configuration (makes bot brand new).",
        type: SUB_COMMAND,
        options: [
          {
            name: "confirmation",
            description: 'Type "FACTORY RESET" to confirm this extremely destructive action.',
            type: STRING_OPTION,
            required: true,
          },
        ],
      },
      {
        name: "setguildid",
        description: "Set the Discord server (guild) ID for this bot instance.",
        type: SUB_COMMAND,
        options: [
          {
            name: "guild_id",
            description: "The Discord server ID (snowflake).",
            type: STRING_OPTION,
            required: true,
          },
        ],
      },
      {
        name: "stop",
        description: "Pause all bot activity (queue joins, team formation, etc.).",
        type: SUB_COMMAND,
      },
      {
        name: "start",
        description: "Resume bot activity after a pause.",
        type: SUB_COMMAND,
      },
      {
        name: "queue-message-mode",
        description: "Set how join/leave queue messages behave: simplified, default, hybrid, or rich.",
        type: SUB_COMMAND,
        options: [
          {
            name: "mode",
            description: "simplified = 1 msg; default = stacks; hybrid = announce+roster; rich = rich announce+roster.",
            type: STRING_OPTION,
            required: true,
            choices: [
              { name: "simplified", value: "simplified" },
              { name: "default", value: "default" },
              { name: "hybrid", value: "hybrid" },
              { name: "rich", value: "rich" },
            ],
          },
        ],
      },
      {
        name: "streak-bonus",
        description: "Toggle the win-streak MMR bonus. Tracking/announcement/fire emoji still work when off.",
        type: SUB_COMMAND,
        options: [
          {
            name: "enabled",
            description: "If true (default), 3+ game win streaks get bonus MMR. If false, only the bonus is disabled.",
            type: BOOLEAN_OPTION,
            required: true,
          },
        ],
      },
      {
        name: "series-length-vote",
        description: "Toggle the Best-of-3/5/7 series-length pre-vote (off by default).",
        type: SUB_COMMAND,
        options: [
          {
            name: "enabled",
            description: "If true, a Best of 3/5/7 vote runs before Balanced/Captains, scaling the K-factor (0.6x/1.0x/1.4x).",
            type: BOOLEAN_OPTION,
            required: true,
          },
        ],
      },
      {
        name: "band-calc-mode",
        description: "Set how band percentile is computed: leaderboard position, or raw MMR distribution.",
        type: SUB_COMMAND,
        options: [
          {
            name: "mode",
            description: "position = evenly-spaced rank order (default); mmr = percentile follows actual MMR gaps/clusters.",
            type: STRING_OPTION,
            required: true,
            choices: [
              { name: "position", value: "position" },
              { name: "mmr", value: "mmr" },
            ],
          },
        ],
      },
      {
        name: "checklist",
        description: "Show which settings are configured and which still need setup.",
        type: SUB_COMMAND,
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
  {
    name: "mafia",
    description: "Start a game of Mafia — waits for 6 players to join, then secretly assigns one as the Mafia.",
    type: 1,
    options: [
      {
        name: "password",
        description: "Optional lobby password — players must enter it to join.",
        type: STRING_OPTION,
        required: false,
      },
    ],
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

// Always state the target guild, not just on the auto-detect path. Commands registered against
// the wrong (or an unexpectedly empty) guild register "successfully" and simply never appear in
// the server you're watching, which is indistinguishable from a client-cache problem and cost a
// long debugging session to track down. Printing it unconditionally makes the target auditable
// in the workflow log regardless of how it was resolved.
console.log(`Registering commands to guild: ${guildId}${process.env.DISCORD_GUILD_ID ? " (from DISCORD_GUILD_ID)" : " (auto-detected)"}`);

// Diagnostic: this bot deliberately registers guild-scoped commands only (see the header
// comment above) — a leftover *global* command with the same name as a guild command can
// confuse Discord clients about which definition to show/autocomplete against, and global
// commands take up to ~1hr to change on top of that. Surface any global commands here so a
// stale-global-command mismatch is visible instead of silently confusing.
const globalRes = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
  headers: { Authorization: `Bot ${token}` },
});
if (globalRes.ok) {
  const globalCommands = await globalRes.json();
  if (globalCommands.length > 0) {
    console.log(
      `WARNING: ${globalCommands.length} GLOBAL command(s) also registered for this app (these can shadow/conflict with the guild-scoped ones below):`,
      globalCommands.map((c) => c.name).join(", "),
    );
  } else {
    console.log("No global commands registered for this app (expected — this bot is guild-scoped only).");
  }
} else {
  console.log(`Could not check global commands: ${globalRes.status} ${await globalRes.text()}`);
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

// Discord's response only lists top-level commands — a subcommand's own name never appears
// above, even when it registered correctly. Print the /admin subcommand tree specifically so a
// stale-registration or nesting bug is visible in the log without a separate GET round trip.
const adminCommand = registered.find((c) => c.name === "admin");
if (adminCommand) {
  const describe = (opt) =>
    opt.options && opt.options.length > 0 && (opt.type === 1 || opt.type === 2)
      ? `${opt.name}(${opt.options.map(describe).join(",")})`
      : opt.name;
  console.log(`/admin subcommand tree:`, (adminCommand.options ?? []).map(describe).join(", "));
}
