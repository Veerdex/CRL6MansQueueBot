-- Notification roles: tracks which role is used for Rank/Universal queue notifications
create table if not exists crl6mansqueuebot_notification_roles (
  queue_type text primary key,
  role_id text not null,
  updated_at timestamptz default now()
);

-- RLS: public read-only (config)
alter table crl6mansqueuebot_notification_roles enable row level security;
create policy "notification_roles_public_read" on crl6mansqueuebot_notification_roles
  for select using (true);
