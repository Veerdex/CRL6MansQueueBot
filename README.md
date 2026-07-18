










# CRL 6 Mans

Discord bot + companion website for a small, high-skill (Champ+) Rocket League community
running 3v3 6-mans pickup games. The bot handles queueing, team formation, MMR/Elo,
ranked bands, reporting, and seasons; the website hosts a public leaderboard.

Live site: **https://crl6mans-queue-bot.vercel.app**

For the full design rationale, resolved decisions, and per-feature implementation notes,
see [`CLAUDE.md`](./CLAUDE.md) — this README only covers getting the project running and
day-to-day command usage.

## Architecture

- **Website** — Next.js (App Router), deployed on Vercel.
- **Discord bot** — not a separate process. It's a set of Next.js API routes living in
  `web/app/api/discord/`, deployed as part of the same Vercel project. Discord POSTs each
  interaction (slash command, button click) to `/api/discord/interactions`; there's no
  gateway/WebSocket connection.
- **Database** — Supabase (Postgres), shared source of truth for both the website and the
  bot.
- **Background jobs** — Supabase `pg_cron` + `pg_net` hit secret-guarded routes on a
  schedule: `/api/discord/sweep` (every minute — series/vote/sub timeouts) and
  `/api/discord/recompute-bands` (daily — band promotion/demotion).

## Repo layout

```
CLAUDE.md              # full design doc — read this for "why", not just "what"
supabase/
  migrations/           # numbered, additive SQL migrations
  README.md              # how to apply a migration
web/                    # the Next.js app — Vercel project root
  app/
    api/discord/          # the bot itself (interactions, sweep, recompute-bands)
    api/dev/                # password-gated dev-panel endpoints (seed/reset test data)
    dev/                     # dev-panel page
    stats/                    # season / all-time leaderboard pages
    page.tsx                   # main leaderboard
  lib/
    discord/               # bot logic — queueing, team formation, reporting, admin tools...
    mmr/                     # Elo implementation
    leaderboard/              # stat queries/computation for the website
    supabase/                  # Supabase client helpers + generated types
  scripts/
    register-commands.mjs   # registers all slash commands with Discord
```

## Setup

### Prerequisites

- Node.js (see `web/package.json` for the toolchain — Next.js 16)
- A Supabase project
- A Discord application (Developer Portal) with a bot user, invited to your server with
  `applications.commands` + `bot` scopes and enough permissions to manage channels/roles
- The [Vercel CLI](https://vercel.com/docs/cli) if you're deploying (`npm i -g vercel`)

### 1. Install dependencies

```bash
cd web
npm install
```

### 2. Database

Apply the migrations in `supabase/migrations/` in order — see
[`supabase/README.md`](./supabase/README.md) for how (SQL Editor paste, or `supabase db
push` if you've linked the CLI). Every table is prefixed `crl6mansqueuebot_` since this
Supabase project may be shared with other apps.

After the schema is applied, also run the `pg_cron`/`pg_net` scheduling migrations
(`0003_schedule_sweep_cron.sql`, `0009_schedule_bands_cron.sql`) — these register the two
background jobs mentioned above and expect a Vault secret matching `CRON_SWEEP_SECRET`
(see below).

### 3. Environment variables

Create `web/.env.local` (or `vercel env pull .env.local` if the Vercel project is already
provisioned) with:

| Variable | Where to get it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase project settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase project settings → API (server-only — bypasses RLS, never expose client-side) |
| `DISCORD_APPLICATION_ID` | Discord Developer Portal → your app → General Information |
| `DISCORD_PUBLIC_KEY` | Discord Developer Portal → your app → General Information |
| `DISCORD_BOT_TOKEN` | Discord Developer Portal → your app → Bot |
| `DISCORD_GUILD_ID` | *(optional)* only needed if the bot is in more than one server — otherwise auto-detected |
| `CRON_SWEEP_SECRET` | Any random string — must match the secret the `pg_cron` migrations use to call the sweep/recompute-bands routes |
| `DEV_PANEL_PASSWORD` | Any password of your choosing — gates the `/dev` test-data panel |

### 4. Invite the bot to your server

Developer Portal → your app → **OAuth2** → **URL Generator**:

- Scopes: `bot`, `applications.commands`
- Bot permissions: **View Channels**, **Send Messages**, **Manage Channels** (creates/
  deletes per-match categories and channels), **Manage Roles** (band/Placed/Prism role
  sync), **Connect** and **Move Members** (force-disconnects a subbed-out player from
  their team voice channel)

Open the generated URL and add the bot to your server.

**Role hierarchy matters**: in Server Settings → Roles, drag the bot's own role *above*
every role it will need to assign (the band roles, `Placed`, `Prism` — see step 8 below).
Discord silently rejects a bot's attempt to grant/revoke a role positioned above its own —
there's no error surfaced to players, promotions/demotions just stop actually changing
anyone's roles.

### 5. Run locally / deploy

```bash
npm run dev      # local dev server
npm run build    # production build (also run before deploying, to catch errors early)
npm run lint      # eslint
vercel deploy --prod   # deploy — this Vercel project isn't Git-connected, so this
                         # always targets production regardless of --prod
```

### 6. Point Discord at the interactions endpoint

In the Developer Portal, set **Interactions Endpoint URL** to
`https://<your-deployment>/api/discord/interactions`. Discord sends a `PING` to verify
this URL before accepting it — the route must already be deployed and reachable (step 5)
for this to succeed.

### 7. Register Discord commands

```bash
cd web
npm run register-commands
```

This does a bulk overwrite of the guild's command set with everything defined in
`scripts/register-commands.mjs` — run it again any time commands change. It auto-detects
the guild the bot is in, so the bot must already be a member of your server (step 4);
it fails if the bot is in more than one server, unless `DISCORD_GUILD_ID` is set.

## Discord server setup

Everything above gets the bot *running*. This section is the one-time in-Discord setup
that gets the actual queue → match → report flow working — roles, channels, and a handful
of bootstrap commands, run in this order.

### 1. Create the roles

In Server Settings → Roles, create (empty is fine — no Discord permissions needed on any
of these; the bot uses them purely as tags):

- **Iron**, **Garnet**, **Emerald**, **Sapphire** — the four bands
- **Unranked** — informational only: the role for players who don't yet have a real band
  (show players in the unbanded state before placement).
- **Prism** — only matters once you're running seasons (Top 10 role); can be added later
- One or more **admin role(s)** (e.g. "6 Mans Admin") — optional. The server owner always
  has admin access even with none of these granted; add a role only if you want other
  people to be able to run admin commands.

Confirm the bot's own role sits above the band/Unranked/Prism roles (step 4 above) — do
this now, before anyone plays, since a missed promotion is invisible until someone
notices their role never changed.

### 2. Create the queue channels

Create `#universal-queue` and `#rank-queue` — both open to everyone, no permission
changes needed. Rank Queue has no placement requirement; anyone can join and start
earning MMR immediately.

### 3. Wire the queue channels to the bot

Run inside each channel:

```
/setqueuechannel queue_type:universal      (run inside #universal-queue)
/setqueuechannel queue_type:rank           (run inside #rank-queue)
```

Each posts the persistent queue-status message the bot will update whenever someone joins or
leaves. The message shows the current queue member list and queue count. Players use `/q` and
`/l` to join/leave — don't post the message manually, and don't run this a second time in
the same channel unless you want to relocate it.

### 4. Map bands to roles

Run once per row:

```
/setbandrole band:Iron role:@Iron
/setbandrole band:Garnet role:@Garnet
/setbandrole band:Emerald role:@Emerald
/setbandrole band:Sapphire role:@Sapphire
/setbandrole band:Unranked role:@Unranked
/setbandrole band:Prism role:@Prism        (can wait until your first /newseason)
```

Without this, the daily band recompute has nowhere to sync roles to — players' MMR/band
will still update internally, but nobody's Discord role will move.

### 5. Grant admin roles (optional)

```
/add-admin-role role:@6-Mans-Admin
```

Skip this if the server owner running admin commands personally is enough for now — it
can be added anytime later. `/list-admin-roles` shows current grants.

### 6. Bootstrap the first season

```
/newseason confirmation:NEW SEASON
```

**Don't skip this.** Every popped queue needs an active season row to attach the series
to — if none exists, a 6th queue-join silently fails to create a match (it's logged
server-side, but the 6 players just sit there locked with nothing happening). Run this
once, immediately, before the first real queue pop; the first call has nothing to close,
so it just opens season 1.

### 7. Verify

Join `#universal-queue` (or have 6 alts/teammates do it) and confirm: the queue message
updates live, popping at 6/6 creates a match category with a text channel and pulls in
the 6 players, `/help` responds, and an admin command like `/admin audit-log` works.

## Player usage

- **Queueing** — use `/q` (or `/queue`) to join the queue channel's queue, `/l` (or `/leave`)
  to leave. `#universal-queue` and `#rank-queue` each have one persistent bot message showing
  the current queue list. Both queues are open immediately, no placement requirement — Rank
  Queue results affect your MMR from your very first game. You can sit in both queues at
  once; popping one auto-removes you from the other.
- **On pop (6/6)** — the bot creates a private match category with two voice channels
  (Team A and Team B) visible only to the 6 players (plus admins). Vote **Balanced** or
  **Captains** using the buttons that appear in the queue channel; your `/vote-default`
  preference auto-casts if you have one set, but you can still override it per game.
  - `/vote-default mode:<balanced|captains|clear>` — set your default vote, or clear it.
- **Balanced split** — if Balanced wins, the bot computes the optimal 3v3 split
  (smallest MMR-average difference between teams) instantly.
- **Captains draft** — if Captains wins, the two highest-MMR players in the lobby become
  captains and pick via buttons in DM: Captain 1 picks one player, Captain 2 picks two,
  and the last player auto-assigns to Captain 1's team. (If a captain has DMs closed, the
  bot posts the pick prompt in the queue channel as a fallback.)
- **`/report result:<win|loss>`** — once the game is over, report your team's result from
  anywhere (no channel restriction). Settles immediately, no confirmation needed from the
  other team. Rank Queue series update MMR; Universal Queue series are unranked but still
  count toward placement and season stats. The match result is posted to the report channel
  with a match ID (base-71 encoded: 0-9, a-z, A-Z, then !-)).
- **`/sub nominee:<@user>`** — run inside your match channel if you need to leave
  mid-series; nominates a specific replacement, who must accept via a button before the
  swap happens. The sub inherits your team and plays out the rest of the series.
- **`/admin cancel-series [id:<series_id>]`** — admin-only: abruptly end a match.
  Run inside the channel with no `id:`, or provide `id:` from elsewhere.
- **`/help`** — lists available commands (shows an extra admin section if you have admin
  access).

## Admin usage

Admin access is granted per-role, not per-user — see `/add-admin-role` below. Until any
role is granted, only the server owner has admin access.

- **`/add-admin-role role:<@role>`** / **`/remove-admin-role role:<@role>`** /
  **`/list-admin-roles`** — manage which Discord roles have admin access.
- **`/setqueuechannel queue_type:<rank|universal>`** — run inside the channel you want
  that queue's persistent join/leave message posted (or relocated) to.
- **`/setbandrole band:<Iron|Garnet|Emerald|Sapphire|Unranked|Prism> role:<@role>`** — map a
  band (or the `Unranked` state, or the season-end-only `Prism` Top 10 tier) to a Discord
  role the bot grants/revokes automatically on change.
- **`/setmentionrole queue_type:<rank|universal> role:<@role>`** — set the role to mention
  when the first player joins an empty queue (useful for pinging community members to start
  playing).
- **`/newseason confirmation:NEW SEASON`** — closes the current season (soft-reset MMR via
  hyperbolic decay, snapshot final standings, sync the Prism Top 10 role) and opens the next
  one. Requires confirmation text "NEW SEASON". Manual trigger only — there's no scheduled
  monthly rollover.
- **`/admin unreport id:<series_id>`** — reverses a reported series and unwinds the
  MMR/games-played changes it caused for all 6 players.
- **`/admin cancel-series [id:<series_id>]`** — voids an in-progress (forming or active)
  series. Run inside the match channel with no `id:` to cancel whichever match you're
  sitting in, or pass `id:` from elsewhere to cancel any series by id.
- **`/admin adjust-mmr target:<@user> [delta:<n>|mmr:<n>]`** — manually adjust a player's
  MMR. Provide exactly one of `delta:` (relative) or `mmr:` (absolute).
- **`/admin force-leave target:<@user>`** — dequeue a player and/or void any active series
  they're locked into. Useful when a stuck/unresponsive player can't be handled via
  `/abandon`'s 3-vote threshold.
- **`/admin recompute-bands`** — manually trigger the daily band promotion/demotion pass.
- **`/admin config get [key:<...>]`** / **`/admin config set key:<...> value:<n>`** — read
  or tune any of the config values below.
- **`/admin audit-log [limit:<n>]`** — show recent admin actions (default 10, max 25).
  Every admin action is logged automatically.
- **`/admin test-flow mode:<captains|balanced>`** — creates a temporary test match to
  simulate the queue→team-formation→report flow. Posts 5 sequential bot joins to the queue
  channel (with delays), then you manually run `/q` to trigger the pop at 6/6. Bots vote
  according to the specified mode and play out a full match that cleans up after `/report`.
  Test data is auto-flagged so it won't pollute leaderboards or season stats.
- **`/admin set-rank-emoji band:<Iron|Garnet|Emerald|Sapphire|Unranked|Prism> image:<file>`**
  — uploads a custom emoji image for a rank band and stores it in the database. Used by the
  bot to display custom rank emoji in report embeds instead of Unicode fallbacks.
- **`/admin reset confirmation:SEASON RESET`** — **DANGER: wipes all game data** (series,
  queue members, votes, sub requests, abandonment votes) and resets all player stats to a
  clean slate. Configuration (channels, roles, emoji) is preserved. Does not start a new
  season — run `/newseason` separately if needed. Requires confirmation text "SEASON RESET".
- **`/admin full-reset confirmation:FACTORY RESET`** — **DANGER: complete factory reset** —
  wipes all data including game data, configuration, audit log, and admin roles. Bot becomes
  brand new and requires full setup again (channels, roles, mention roles, config) except rank
  emoji is preserved. Requires confirmation text "FACTORY RESET".
- **`/admin checklist`** — shows a setup status checklist indicating which configuration
  items are complete: queue channels (rank & universal), report channel, 6-mans call
  category, 6 custom rank emoji, 6 band roles, admin roles.
- **`/admin stop`** — pauses all bot activity: blocks queue joins, team formation, voting,
  reports, subs, and abandon votes. Admin commands (like `/admin start`) remain available.
  Useful for emergency maintenance or freezing the queue without shutting down the bot.
- **`/admin start`** — resumes normal bot activity after a pause.

### Config values (tunable via `/admin config set`)

`k_factor`, `s_scale`, `hysteresis_pct`, `grace_games`, `provisional_games`,
`provisional_k_multiplier`, `placement_games_required`, `decay_factor`, `top10_min_games`,
`series_timeout_hours`, `vote_timeout_seconds`, `sub_request_timeout_minutes`,
`band_cutoff_garnet_pctile`, `band_cutoff_emerald_pctile`, `band_cutoff_sapphire_pctile`,
`season_rank_display_min_games`.

See `CLAUDE.md`'s "Config values" table for defaults and what each one controls.

## Dev panel

`/dev` on the website (password-gated by `DEV_PANEL_PASSWORD`) can generate or clear
synthetic test data (`is_test_data = true`) to exercise the leaderboard boards without a
live Discord community generating real games. Test-data players/series are excluded from
band recomputes and season close, so they can't pollute real standings. Remove or re-gate
this panel before this stops being useful for verification.

## Known limitations & future features

- **Dispute resolution** — no formal appeal/review process for abandoned series or
  incorrect reports (besides admin manually running `/admin unreport`).
- **Website features** — the leaderboard is the only user-facing page. Season stats,
  all-time stats, and detailed player profiles are implemented but basic. Future: add match
  history, team statistics, replay links, etc.
