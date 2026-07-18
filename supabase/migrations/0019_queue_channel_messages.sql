-- Track all messages sent to queue channels, with a flag to mark ones that should be kept permanently
create table crl6mansqueuebot_queue_channel_messages (
  id uuid primary key default gen_random_uuid(),
  channel_id text not null,
  message_id text not null,
  message_type text not null check (message_type in ('status', 'error', 'settled', 'teams_formed', 'timeout')),
  keep_permanently boolean default false,
  created_at timestamptz default now(),
  unique(channel_id, message_id)
);

alter table crl6mansqueuebot_queue_channel_messages enable row level security;
create policy "public read" on crl6mansqueuebot_queue_channel_messages for select using (true);
