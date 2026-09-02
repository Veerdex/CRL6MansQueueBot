# CRL 6 Mans — Claude Instructions

## Purpose and source of truth

This repository contains a Discord-integrated website for a small, high-skill (Champ+) Rocket League community running 3v3 six-mans pickup games. The website and Discord interactions form one product.

This file contains only the instructions and decisions Claude needs on every task. Detailed implementation history, UI revisions, migration notes, edge cases, and resolved discussions are stored in `# CRL 6 Mans — Project Memory.txt`.

Read the full memory **only when relevant to the task**. Search it for the feature, command, table, migration, or filename involved; do not load the entire file by default. When this file conflicts with older specifications, this file and the full project memory supersede them.

## Working rules

- Build incrementally. Brainstorm and agree on a feature's design before implementing it; never build ahead of the agreed scope.
- Preserve established behavior unless the requested change explicitly replaces it.
- Reuse existing helpers and patterns instead of creating parallel implementations.
- Inspect relevant code, migrations, and tests before changing behavior.
- Keep Discord operations race-safe and idempotent. Settlement paths use atomic database claims so concurrent actions cannot settle a series twice.
- Keep public Discord messages concise and consistent with existing embeds, colors, rank emoji, mentions, and ephemeral/public reply conventions.
- Do not read whole large files when a function, section, search, or line range is sufficient.
- Update the full project memory when an implemented decision materially changes the source of truth.
- Database migrations produced here may require manual application to production Supabase; never assume a migration is live without confirmation.

## Architecture

- Website: Next.js deployed on Vercel.
- Database: Supabase Postgres, shared by the website and Discord system.
- Discord bot: Next.js API routes inside `web/`, not a persistent separate process. Discord sends interactions to an HTTP endpoint.
- Verify Discord request signatures and acknowledge interactions within Discord's three-second limit. Defer responses when work may take longer.
- Scheduled cleanup and timeout work runs through the sweep route and Supabase `pg_cron`.
- MMR calculations should remain pure and independent of Discord/database code where possible.

## Current phase status

Implemented and deployed: leaderboard, queue system, team formation, Elo engine, bands and role synchronization, reporting, substitutes, abandonment/cancellation, seasons, admin tools, and audit logging. Remaining website features beyond the implemented leaderboard/analytics surfaces are handled one phase at a time.

## Core queue and series rules

- One queue exists: Rank Queue. It is available immediately, has no placement requirement, and every reported series changes MMR and advances placement games.
- Queue joins/leaves must use atomic RPC/check-and-write behavior so simultaneous joins cannot exceed six.
- A series expires after two unreported hours and is voided with no MMR change.
- `/cancel` voids a forming or active series after four of six votes. Every sub-threshold vote gets a small public progress announcement.
- `/abandon target:` voids after three of the other five players report the same absent player. Self-targeting is rejected.
- All settlement paths must atomically claim an unsettled series before changing records, clearing pending state, posting results, or tearing down channels.

## Team formation

After a queue pops, players choose Balanced or Captains. Existing vote defaults may be auto-cast. Captains mode randomly selects two captains from the top three MMR players, randomizes who picks first, uses a 1-2 draft order, then auto-assigns the final player. Balanced mode brute-forces valid 3v3 divisions to minimize team MMR difference.

An optional admin-controlled series-length vote runs first when enabled. Players choose BO3, BO5, or BO7; first to three resolves. Timeout resolves by current majority, with ties favoring the shorter series. K multipliers are BO3 0.6x, BO5 1.0x, and BO7 1.4x. The selected length and multiplier are snapshotted on the series.

## MMR, placement, bands, and seasons

- Standard team Elo uses the average MMR of each three-player team.
- K-factor is applied per player because teammates may have different provisional status.
- Rank Queue only changes MMR. Series length and any active bonus-day multiplier scale the update.
- Placement requires Rank Queue games. Until complete, players display as Unranked; completion assigns a real band from current MMR.
- Bands are distribution-based and recomputed on schedule. Role synchronization must follow the existing band helpers and preserve the live Prism/top-player behavior.
- Displayed MMR may use configured display transformations; calculations use underlying MMR.
- Seasons close manually through the admin flow, archive eligible Top N results, update Hall of Fame data, soft-reset ratings, and start the next season. There is no automatic monthly rollover.
- Preserve streak tracking and established fire/cold emoji formatting across queue cards, leaderboards, and reports.
- **Current streak always resets at a season boundary — All-Time Stats' remaining gap fixed this session** (`web/lib/leaderboard/stats.ts`'s `computeStats`, `web/components/StatsBoard.tsx`, `web/app/stats/all-time/page.tsx`, `UnifiedLeaderboard.tsx`'s embedded All-Time tab): reported live — a player ("Tony") who hadn't played since a prior season still showed a 9-game win streak on the All-Time Stats page, because "current streak" there was computed by walking a player's full lifetime game history with no notion of a season boundary. A separate, parallel fix landed on `main` moments before this one (`streaks.ts`'s live 🔥/🥶 decorations + the report-time MMR bonus, and the Main leaderboard/`/profile`'s W/L/streak) by scoping those surfaces' queries to the active season outright — but deliberately left the All-Time Stats board's `wins`/`losses`/`gamesPlayed`/`longestWinStreak` as pure lifetime totals (the whole point of that page) and never touched `computeStats` itself, so its "Current streak" column still bridged across seasons unfixed. **Fixed**: `computeStats` now takes an optional `currentSeasonId` and resets `currentStreak` (only that field — `longestWinStreak`/`wins`/`losses` stay lifetime) at the first game outside it, walked chronologically; `StatsBoard.tsx`'s `mode === "all-time"` path and both of its call sites (the standalone `/stats/all-time` page and `UnifiedLeaderboard.tsx`'s All-Time tab, which previously both hardcoded `currentSeason={null}`) now fetch and pass the live active season's id through — used only for this reset, never to filter which games count. `/stats/season` and Hall of Fame needed no change, since their games are already pre-filtered to one season before reaching `computeStats`, making the boundary check a no-op there. Passing `null`/omitting the season id keeps the old unrestricted (bridging) behavior for any future caller with no season id on hand. Regression-tested in `stats.test.ts` (the exact "played a run ending last season, hasn't played since" case, a same-season case, a cross-season non-bridging case, and the no-boundary-passed fallback case).

## Weekly bonus day

The configured weekly bonus period increases both gains and losses using a multiplier snapshotted when the series pops. Existing Supercharged/Bonus Range visual styling uses purple; ordinary styling uses the normal brand color. Do not retroactively change a series multiplier after formation.

## Reporting, substitutes, and teardown

- `/report result:<win|loss>` determines the caller's team, atomically settles the series, applies Elo only for Rank Queue, increments appropriate games-played statistics, posts a public summary, and begins teardown.
- Reporting supports the established admin-only `id:` override pattern outside the inferred match context.
- `/correct` (no options) always targets the caller's own most-recently-reported, non-test match. Once 5 of that match's 6 players have each run it, the winner flips, MMR/bands/streaks recompute the same way `/admin correct-report` does, and a fresh report summary posts. One-time only per match, atomically claimed like every other settlement path. Every report embed advertises it in a footer line.
- `/sub nominee:` nominates a replacement for the caller. `/nominate target: nominee:` lets a participant nominate for another participant.
- The nominee must accept. Recheck that the nominee is not locked in another active series before swapping them into the same team seat.
- Rank MMR applies to the players who finish the series. Remove stale abandon votes and queue membership during substitution.
- Pending substitute requests expire through the sweep route.
- Series teardown moves participants who are currently inside that series' team voice channels to the configured lobby, then deletes match channels. Never move a participant from an unrelated voice channel.
- Teardown is best-effort but database settlement must not be blocked by Discord cleanup failure. The sweep route retries orphaned channel cleanup.

## Discord channel behavior

- Queue channels use admin-configured persistent message modes. `/q` and `/l` respond ephemerally; shared queue messages provide the public state.
- `/status` returns an ephemeral one-off roster using the hybrid roster format.
- A sixth join still renders the ordinary rich join card. A separate gold Match Found message preserves the full six-player roster.
- Mentions that must notify belong in top-level message content, not inside embeds.
- Rich join cards may use purple on bonus days. Rich leave cards stay red and inactivity removal cards stay orange regardless of bonus-day styling.
- Team voice channels are visible to everyone but connectable only by participants, admins, and the bot. Substitute permission changes must be scoped to those channels.
- Voice channel names use the persistent series `match_number`. Real series obtain it atomically from the database sequence; test/dev series explicitly use `null` so they do not consume real match numbers.

## Commands and administration

User flows include queue join/leave/status, reporting, voting/drafting, substitute nomination and acceptance, abandonment, cancellation, help, leaderboard/stat views, and supported mini-games. Follow existing dispatch and registration patterns whenever adding or changing commands.

Admin authorization is role-based and uses configured Discord admin roles. Admin changes must be audited with structured before/after or change metadata. Existing controls cover configuration, queue/channel setup, season operations, band recomputation, player/MMR corrections, report correction/unreporting, series cancellation, test matches, avatar refresh, message modes, bonus settings, and feature toggles. Search the full memory and current command registration before modifying the admin surface.

## Website and data surfaces

The primary leaderboard ranks eligible players using the established display MMR and band logic. Additional surfaces include season stats, all-time stats, head-to-head comparisons, match history, Hall of Fame, and match-time analytics. Preserve filtering, eligibility, test-data exclusion, pagination, player identity/avatar handling, and responsive design conventions already present in the implementation.

Match analytics derive queue/pop/report timing carefully and exclude invalid or test records according to existing queries. Do not reinterpret historical statistics without reviewing the relevant section of the full memory.

The Mafia mini-game has its own documented state, commands, timing, roles, and Discord behavior. Search the full memory before touching it; do not infer its rules from the six-mans system.

## Configuration and database conventions

- Runtime behavior that admins can tune belongs in the existing configuration table rather than new hardcoded constants, unless the design explicitly defines a constant.
- Reuse established table prefixes, Supabase types, RPCs, constraints, and row lifecycle conventions.
- Pending/active rows are often deleted when resolved rather than retained with redundant status flags; follow the surrounding feature's convention.
- Use unique constraints and atomic `UPDATE/DELETE ... RETURNING` claims to prevent double clicks, concurrent reports, sweep races, and duplicate settlements.
- Test data must remain isolated from live leaderboards, match numbering, MMR, and archival records.

## Task-specific reference routing

Search `# CRL 6 Mans — Project Memory.txt` before work involving:

- exact command options, response wording, embed layouts, colors, or emojis;
- migration numbers, table schemas, RPC behavior, sequence fixes, or deployment status;
- queue message modes and historical revisions;
- vote timeouts, defaults, draft UI, or series-length behavior;
- MMR display formulas, K values, promotion/demotion, placement, Prism, streaks, or bonus ranges;
- season archival, leaderboard eligibility, Hall of Fame, head-to-head, match history, or analytics;
- substitute permissions, voice-state movement, cleanup edge cases, or race conditions;
- admin command details, audit entries, test tools, Mafia, or unresolved/open items.

Prefer targeted search, for example:

```bash
rg -n "substitutes|match_number|series-length|leaderboard" "# CRL 6 Mans — Project Memory.txt"
```

Then read only the relevant section and confirm it against current code, since the repository may contain later implementation changes.

## Validation before completion

- Run the relevant unit tests, type checks, lint, and build commands available in the repository.
- Verify command registration and interaction dispatch together.
- Verify new migrations/types align with application queries.
- Check normal, bonus-day, test-data, timeout, double-click, and concurrent-settlement paths where applicable.
- Summarize changed files, behavior, validation results, and any migration or deployment step the user must perform.

