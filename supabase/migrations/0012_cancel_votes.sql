-- Cancel votes: one row per player per series, tracks who wants to cancel the match.
-- Once 4 players vote to cancel, the match is cancelled (void).

create table crl6mansqueuebot_cancel_votes (
  series_id uuid not null references crl6mansqueuebot_series(id) on delete cascade,
  player_id uuid not null references crl6mansqueuebot_players(id) on delete cascade,
  voted_at timestamptz not null default now(),
  primary key (series_id, player_id)
);

alter table crl6mansqueuebot_cancel_votes enable row level security;
create policy "public read" on crl6mansqueuebot_cancel_votes for select using (true);
