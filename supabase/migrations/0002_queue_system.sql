-- CRL 6 Mans — Phase 2 (queue system) schema.
-- Extends 0001_init.sql (never edit that file — additive only, same convention as before).
-- Adds: admin-tunable config, queue membership, persistent queue-status-message tracking,
-- and match-channel tracking columns on crl6mansqueuebot_series.

-- ---------------------------------------------------------------------------
-- Config: admin-tunable values from CLAUDE.md's "Config values" table.
-- Stored as text, parsed to number/etc. in application code — small table, no need for
-- per-type columns. `/admin config get|set` (Phase 8) reads/writes this directly.
-- ---------------------------------------------------------------------------

create table crl6mansqueuebot_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

insert into crl6mansqueuebot_config (key, value) values
  ('k_factor', '32'),
  ('s_scale', '400'),
  ('hysteresis_pct', '5'),
  ('grace_games', '3'),
  ('provisional_games', '10'),
  ('provisional_k_multiplier', '1.75'),
  ('placement_games_required', '10'),
  ('decay_factor', '0.25'),
  ('top10_min_games', '8'),
  ('series_timeout_hours', '2'),
  ('vote_timeout_seconds', '180'),
  ('sub_request_timeout_minutes', '10'),
  ('season_rank_display_min_games', '10'),
  ('mod_role_id', '');

-- ---------------------------------------------------------------------------
-- Queue membership: who's currently sitting in which queue.
-- Row is deleted on leave, pop, or lockout removal — no is_active flag needed.
-- ---------------------------------------------------------------------------

create table crl6mansqueuebot_queue_members (
  queue_type text not null check (queue_type in ('rank', 'universal')),
  player_id uuid not null references crl6mansqueuebot_players(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (queue_type, player_id)
);

create index crl6mansqueuebot_queue_members_player_id_idx on crl6mansqueuebot_queue_members (player_id);

-- ---------------------------------------------------------------------------
-- Queue status messages: one persistent bot-edited message per queue channel.
-- Bot looks up channel_id -> message_id here instead of reposting on every join/leave.
-- ---------------------------------------------------------------------------

create table crl6mansqueuebot_queue_messages (
  queue_type text primary key check (queue_type in ('rank', 'universal')),
  channel_id text not null,
  message_id text not null
);

-- ---------------------------------------------------------------------------
-- Series lobby: the 6 players locked into a series between pop and team formation.
-- crl6mansqueuebot_series_players (0001) requires a team on every row, which isn't known
-- until Phase 3's vote/draft resolves — so pop populates this lobby table instead, and
-- Phase 3 later inserts the final series_players rows (with team) once teams are set,
-- at which point the series flips from 'forming' to 'active'. Also doubles as the
-- "is this player locked in an active series" check for queue-join validation.
-- ---------------------------------------------------------------------------

create table crl6mansqueuebot_series_lobby (
  series_id uuid not null references crl6mansqueuebot_series(id) on delete cascade,
  player_id uuid not null references crl6mansqueuebot_players(id) on delete cascade,
  primary key (series_id, player_id)
);

create index crl6mansqueuebot_series_lobby_player_id_idx on crl6mansqueuebot_series_lobby (player_id);

-- ---------------------------------------------------------------------------
-- Match channel tracking: the per-series Discord category/channels created on pop.
-- Nullable since the text channel exists before teams are finalized, and the two voice
-- channels don't exist until team formation completes (see CLAUDE.md, "Match channels").
-- The 2-hour timeout sweep uses these columns to find and delete orphaned categories.
-- ---------------------------------------------------------------------------

alter table crl6mansqueuebot_series
  add column category_id text null,
  add column text_channel_id text null,
  add column voice_channel_a_id text null,
  add column voice_channel_b_id text null;

-- ---------------------------------------------------------------------------
-- Atomic join/leave: simultaneous button clicks at 5/6 must not over-pop a queue past 6.
-- A single check-then-insert from application code has a TOCTOU race under concurrent
-- requests; pg_advisory_xact_lock serializes calls per queue_type within one transaction
-- (auto-released at commit) so the count check and insert are effectively atomic.
-- ---------------------------------------------------------------------------

create or replace function crl6mansqueuebot_join_queue(p_queue_type text, p_player_id uuid, p_max_size int default 6)
returns table (status text, queue_size int) as $$
declare
  v_count int;
begin
  perform pg_advisory_xact_lock(hashtext(p_queue_type));

  if exists (
    select 1 from crl6mansqueuebot_queue_members
    where queue_type = p_queue_type and player_id = p_player_id
  ) then
    select count(*) into v_count from crl6mansqueuebot_queue_members where queue_type = p_queue_type;
    return query select 'already_queued'::text, v_count;
    return;
  end if;

  select count(*) into v_count from crl6mansqueuebot_queue_members where queue_type = p_queue_type;

  if v_count >= p_max_size then
    return query select 'full'::text, v_count;
    return;
  end if;

  insert into crl6mansqueuebot_queue_members (queue_type, player_id) values (p_queue_type, p_player_id);

  return query select 'joined'::text, v_count + 1;
end;
$$ language plpgsql;

create or replace function crl6mansqueuebot_leave_queue(p_queue_type text, p_player_id uuid)
returns table (status text, queue_size int) as $$
declare
  v_deleted int;
  v_count int;
begin
  perform pg_advisory_xact_lock(hashtext(p_queue_type));

  delete from crl6mansqueuebot_queue_members
  where queue_type = p_queue_type and player_id = p_player_id;

  get diagnostics v_deleted = row_count;
  select count(*) into v_count from crl6mansqueuebot_queue_members where queue_type = p_queue_type;

  if v_deleted = 0 then
    return query select 'not_queued'::text, v_count;
  else
    return query select 'left'::text, v_count;
  end if;
end;
$$ language plpgsql;

revoke all on function crl6mansqueuebot_join_queue(text, uuid, int) from public;
grant execute on function crl6mansqueuebot_join_queue(text, uuid, int) to service_role;

revoke all on function crl6mansqueuebot_leave_queue(text, uuid) from public;
grant execute on function crl6mansqueuebot_leave_queue(text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- RLS: same public-read-only pattern as 0001. All writes go through the service-role key
-- (the bot, same as the dev-panel routes) and bypass RLS entirely.
-- ---------------------------------------------------------------------------

alter table crl6mansqueuebot_config enable row level security;
alter table crl6mansqueuebot_queue_members enable row level security;
alter table crl6mansqueuebot_queue_messages enable row level security;
alter table crl6mansqueuebot_series_lobby enable row level security;

create policy "public read" on crl6mansqueuebot_config for select using (true);
create policy "public read" on crl6mansqueuebot_queue_members for select using (true);
create policy "public read" on crl6mansqueuebot_queue_messages for select using (true);
create policy "public read" on crl6mansqueuebot_series_lobby for select using (true);

-- ---------------------------------------------------------------------------
-- Extensions for the Phase 2 sweep cron (series/vote/sub timeouts — see CLAUDE.md,
-- "Discord bot runtime architecture"). Enabling here; the actual cron.schedule(...) call
-- is added separately once the sweep API route is deployed and its URL is known.
-- ---------------------------------------------------------------------------

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;
