-- CRL 6 Mans — Phase 1 (leaderboard) schema.
-- Lives in the shared "public" schema of a Supabase project also used by another app —
-- every table is prefixed "crl6mansqueuebot_" to avoid any naming collisions there.
-- Forward-compatible subset of the full data model in CLAUDE.md; later bot phases extend
-- this rather than replacing it.

create extension if not exists pgcrypto;

create table crl6mansqueuebot_players (
  id uuid primary key default gen_random_uuid(),
  discord_id text unique not null,
  display_name text not null,
  mmr real not null default 0,
  band text null check (band in ('Iron', 'Garnet', 'Emerald', 'Sapphire')),
  is_placed boolean not null default false,
  total_games_played int not null default 0,
  is_test_data boolean not null default false,
  created_at timestamptz not null default now()
);

create table crl6mansqueuebot_seasons (
  id uuid primary key default gen_random_uuid(),
  season_number int not null unique,
  start_date date not null,
  end_date date null,
  is_active boolean not null default false
);

create table crl6mansqueuebot_series (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references crl6mansqueuebot_seasons(id) on delete cascade,
  queue_type text not null check (queue_type in ('rank', 'universal')),
  status text not null default 'reported' check (status in ('forming', 'active', 'reported', 'cancelled', 'void')),
  winner_team text null check (winner_team in ('A', 'B')),
  is_test_data boolean not null default false,
  created_at timestamptz not null default now(),
  reported_at timestamptz null
);

create table crl6mansqueuebot_series_players (
  series_id uuid not null references crl6mansqueuebot_series(id) on delete cascade,
  player_id uuid not null references crl6mansqueuebot_players(id) on delete cascade,
  team text not null check (team in ('A', 'B')),
  primary key (series_id, player_id)
);

create table crl6mansqueuebot_season_history (
  season_id uuid not null references crl6mansqueuebot_seasons(id) on delete cascade,
  player_id uuid not null references crl6mansqueuebot_players(id) on delete cascade,
  mmr_at_close real not null,
  season_games_played int not null,
  season_rank int not null,
  made_top10 boolean not null default false,
  primary key (season_id, player_id)
);

create index crl6mansqueuebot_series_season_id_idx on crl6mansqueuebot_series (season_id);
create index crl6mansqueuebot_series_queue_type_idx on crl6mansqueuebot_series (queue_type);
create index crl6mansqueuebot_series_players_player_id_idx on crl6mansqueuebot_series_players (player_id);
create index crl6mansqueuebot_season_history_player_id_idx on crl6mansqueuebot_season_history (player_id);

-- Public, read-only site: RLS allows SELECT to anyone, no anon/authenticated writes.
-- All writes (dev-panel seed/reset now, the bot later) go through the service-role key,
-- which bypasses RLS entirely.

alter table crl6mansqueuebot_players enable row level security;
alter table crl6mansqueuebot_seasons enable row level security;
alter table crl6mansqueuebot_series enable row level security;
alter table crl6mansqueuebot_series_players enable row level security;
alter table crl6mansqueuebot_season_history enable row level security;

create policy "public read" on crl6mansqueuebot_players for select using (true);
create policy "public read" on crl6mansqueuebot_seasons for select using (true);
create policy "public read" on crl6mansqueuebot_series for select using (true);
create policy "public read" on crl6mansqueuebot_series_players for select using (true);
create policy "public read" on crl6mansqueuebot_season_history for select using (true);
