-- Game prediction tracking for Rank Queue
create table if not exists crl6mansqueuebot_rank_game_predictions (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references crl6mansqueuebot_series(id) on delete cascade,
  reported_at timestamptz not null,
  team_blue_mmr_1 real not null,
  team_blue_mmr_2 real not null,
  team_blue_mmr_3 real not null,
  team_orange_mmr_1 real not null,
  team_orange_mmr_2 real not null,
  team_orange_mmr_3 real not null,
  team_blue_win_probability numeric(5, 2) not null check (team_blue_win_probability >= 0 and team_blue_win_probability <= 100),
  actual_winner text not null check (actual_winner in ('blue', 'orange')),
  created_at timestamptz default now()
);

-- Game prediction tracking for Universal Queue
create table if not exists crl6mansqueuebot_universal_game_predictions (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references crl6mansqueuebot_series(id) on delete cascade,
  reported_at timestamptz not null,
  team_blue_mmr_1 real not null,
  team_blue_mmr_2 real not null,
  team_blue_mmr_3 real not null,
  team_orange_mmr_1 real not null,
  team_orange_mmr_2 real not null,
  team_orange_mmr_3 real not null,
  team_blue_win_probability numeric(5, 2) not null check (team_blue_win_probability >= 0 and team_blue_win_probability <= 100),
  actual_winner text not null check (actual_winner in ('blue', 'orange')),
  created_at timestamptz default now()
);

-- RLS: public read-only (config)
alter table crl6mansqueuebot_rank_game_predictions enable row level security;
create policy "rank_game_predictions_public_read" on crl6mansqueuebot_rank_game_predictions
  for select using (true);

alter table crl6mansqueuebot_universal_game_predictions enable row level security;
create policy "universal_game_predictions_public_read" on crl6mansqueuebot_universal_game_predictions
  for select using (true);
