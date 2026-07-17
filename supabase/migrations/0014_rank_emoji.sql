-- Store custom emoji IDs for each rank band, used in embed displays
create table crl6mansqueuebot_rank_emoji (
  band text primary key check (band in ('Iron', 'Garnet', 'Emerald', 'Sapphire')),
  emoji_id text not null unique,
  set_by text not null, -- discord_id of the admin who set it
  set_at timestamptz default now()
);

alter table crl6mansqueuebot_rank_emoji enable row level security;
create policy "rank_emoji_public_read" on crl6mansqueuebot_rank_emoji for select using (true);
