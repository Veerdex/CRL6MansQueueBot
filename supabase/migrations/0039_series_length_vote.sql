-- Best-of-3/5/7 series-length vote — a second vote inserted before the existing Balanced/Captains
-- vote, deciding how long the series is and scaling the K-factor used at report time (BO3=0.6x,
-- BO5=1.0x/no change, BO7=1.4x — see CLAUDE.md, "Team formation (on pop)"). Feature-flagged via
-- config key `series_length_vote_enabled` (default off); when disabled, `series_length` stays
-- null and `series_length_k_multiplier` stays at its no-op default of 1, so the bot behaves
-- exactly as it did before this migration.
--
-- `series_length` doubles as both the recorded outcome and the atomic resolution claim flag,
-- mirroring `vote_result`'s existing role for the Balanced/Captains vote (0005_team_formation.sql).
alter table crl6mansqueuebot_series add column series_length text null check (series_length in ('bo3', 'bo5', 'bo7'));
alter table crl6mansqueuebot_series add column series_length_k_multiplier numeric not null default 1;

-- Tracks when the *currently active* vote phase began, so the Balanced/Captains vote gets its own
-- fresh vote_timeout_seconds window starting from when it actually begins, rather than racing the
-- same series.created_at the series-length vote (if enabled) already spent part of. Stamped by
-- both startSeriesLengthVote and startTeamFormation whenever either actually posts/takes over the
-- vote message — with the feature disabled, this is stamped at the same moment created_at
-- effectively would be (pop time), so existing timeout behavior is unchanged.
alter table crl6mansqueuebot_series add column vote_started_at timestamptz null;

-- Set true only while the series-length vote is the currently active, unresolved phase (by
-- startSeriesLengthVote), and back to false the moment it resolves (by resolveSeriesLengthVote,
-- alongside writing series_length/series_length_k_multiplier) or if the feature was off to begin
-- with (always false, series_length_vote_active never gets touched). This is what lets the sweep
-- route's two timeout checks (series-length vote vs. Balanced/Captains vote) target disjoint sets
-- of 'forming' series instead of both racing the same vote_started_at/series_length IS NULL
-- combination, which alone can't tell "never had a series-length vote" apart from "has one in
-- progress right now."
alter table crl6mansqueuebot_series add column series_length_vote_active boolean not null default false;

-- Same shape as crl6mansqueuebot_series_votes (0005_team_formation.sql) — kept as a separate
-- table rather than widening that one's `choice in ('balanced','captains')` constraint, matching
-- this codebase's additive-migration convention and keeping the two independent vote types from
-- sharing a table.
create table crl6mansqueuebot_series_length_votes (
  series_id uuid not null references crl6mansqueuebot_series(id) on delete cascade,
  player_id uuid not null references crl6mansqueuebot_players(id) on delete cascade,
  choice text not null check (choice in ('bo3', 'bo5', 'bo7')),
  primary key (series_id, player_id)
);

alter table crl6mansqueuebot_series_length_votes enable row level security;
create policy "public read" on crl6mansqueuebot_series_length_votes for select using (true);
