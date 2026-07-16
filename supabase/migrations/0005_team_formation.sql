-- CRL 6 Mans — Phase 3 (team formation) schema.
-- Extends 0001-0004 (additive only, same convention as before).
-- Adds: vote tracking, a resolution-claim column on series, captains-draft state layered
-- directly onto series_lobby (no separate draft-state table needed — see teamFormation.ts),
-- and a per-player default vote preference.

-- ---------------------------------------------------------------------------
-- Votes: one row per player per series, upsertable (a player's vote is overridable per
-- game even after an auto-cast from vote_default — see CLAUDE.md, "Team formation").
-- ---------------------------------------------------------------------------

create table crl6mansqueuebot_series_votes (
  series_id uuid not null references crl6mansqueuebot_series(id) on delete cascade,
  player_id uuid not null references crl6mansqueuebot_players(id) on delete cascade,
  choice text not null check (choice in ('balanced', 'captains')),
  primary key (series_id, player_id)
);

-- ---------------------------------------------------------------------------
-- series.vote_result doubles as both the recorded outcome and the atomic resolution
-- claim: whichever concurrent vote-cast is the one to successfully
-- `update ... where vote_result is null` is the one that runs the resolution effects
-- (draft start / balanced split) — Postgres's row-level locking on the UPDATE serializes
-- concurrent claims with no advisory lock needed, since only one WHERE clause can still
-- match once the first commits.
-- formation_message_id tracks the single message that evolves from vote prompt -> draft
-- UI -> final "teams formed" summary, mirroring the persistent-message-edit pattern
-- already used for the queue status message.
-- ---------------------------------------------------------------------------

alter table crl6mansqueuebot_series
  add column vote_result text null check (vote_result in ('balanced', 'captains')),
  add column formation_message_id text null;

-- ---------------------------------------------------------------------------
-- Captains-draft state lives directly on series_lobby rather than a separate table:
-- `is_captain` marks the two captains, `team` is filled in progressively as picks land
-- (captains get their team immediately; the other 4 start null). Whose turn it is and how
-- many picks remain is derived by counting non-null `team` values among non-captains —
-- no separate turn-tracking column needed (see teamFormation.ts, deriveDraftTurn).
-- Balanced mode uses only `team`, writing all 6 at once with no draft phase.
-- ---------------------------------------------------------------------------

alter table crl6mansqueuebot_series_lobby
  add column team text null check (team in ('A', 'B')),
  add column is_captain boolean not null default false;

-- ---------------------------------------------------------------------------
-- Per-player default vote preference (`/vote-default`), auto-cast on pop but still
-- overridable per game via the vote buttons.
-- ---------------------------------------------------------------------------

alter table crl6mansqueuebot_players
  add column vote_default text null check (vote_default in ('balanced', 'captains'));

alter table crl6mansqueuebot_series_votes enable row level security;
create policy "public read" on crl6mansqueuebot_series_votes for select using (true);
