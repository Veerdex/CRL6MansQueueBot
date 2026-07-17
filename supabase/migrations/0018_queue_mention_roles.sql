-- Store mention roles for queue announcements (first join in an empty queue)
create table crl6mansqueuebot_queue_mention_roles (
  queue_type text primary key check (queue_type in ('rank', 'universal')),
  role_id text not null,
  set_by text not null,
  set_at timestamptz default now()
);

alter table crl6mansqueuebot_queue_mention_roles enable row level security;
create policy "public read" on crl6mansqueuebot_queue_mention_roles for select using (true);
