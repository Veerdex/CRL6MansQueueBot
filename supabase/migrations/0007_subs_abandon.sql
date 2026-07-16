-- CRL 6 Mans — Phase 6 (subs + abandon-vote) schema.
-- Extends 0001-0006 (additive only, same convention as before).

-- ---------------------------------------------------------------------------
-- Sub requests: one pending row per (series, leaving player) — PK enforces a leaving player
-- can't have two outstanding nominations at once. Deleted (not status-flagged) on
-- acceptance/expiry/series-settlement, same "existence = pending" convention as
-- crl6mansqueuebot_series_lobby / crl6mansqueuebot_queue_members. message_id lets the accept
-- prompt be edited in place once resolved, mirroring series.formation_message_id.
-- See CLAUDE.md, "Substitutes".
-- ---------------------------------------------------------------------------

create table crl6mansqueuebot_sub_requests (
  series_id uuid not null references crl6mansqueuebot_series(id) on delete cascade,
  leaving_player_id uuid not null references crl6mansqueuebot_players(id) on delete cascade,
  nominee_discord_id text not null,
  team text not null check (team in ('A', 'B')),
  message_id text null,
  created_at timestamptz not null default now(),
  primary key (series_id, leaving_player_id)
);

-- ---------------------------------------------------------------------------
-- Abandon votes: one row per (series, voter) — PK makes re-running /abandon with a
-- different target overwrite the voter's earlier pick (upsert) rather than stacking votes,
-- mirroring crl6mansqueuebot_series_votes. Resolution counts distinct voter rows per target;
-- self-targeting is rejected in application code so the "3 of the remaining 5" semantics in
-- CLAUDE.md hold without a DB constraint for it. See CLAUDE.md, "Mid-series abandonment".
-- ---------------------------------------------------------------------------

create table crl6mansqueuebot_abandon_votes (
  series_id uuid not null references crl6mansqueuebot_series(id) on delete cascade,
  voter_player_id uuid not null references crl6mansqueuebot_players(id) on delete cascade,
  target_player_id uuid not null references crl6mansqueuebot_players(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (series_id, voter_player_id)
);

alter table crl6mansqueuebot_sub_requests enable row level security;
alter table crl6mansqueuebot_abandon_votes enable row level security;

create policy "public read" on crl6mansqueuebot_sub_requests for select using (true);
create policy "public read" on crl6mansqueuebot_abandon_votes for select using (true);
