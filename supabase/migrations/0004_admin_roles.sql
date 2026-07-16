-- CRL 6 Mans — owner-managed admin roles + audit log.
-- Replaces the single mod_role_id config value (Phase 2 stopgap) with a proper multi-role
-- table: any number of Discord roles can be granted admin access + match-channel visibility,
-- not just one. The guild owner (checked live via the Discord API, not stored here) always
-- has admin access regardless of this table's contents — that's what makes the bootstrap
-- case ("only the owner can use admin commands until roles are granted") fall out naturally
-- from the permission check (owner OR has an admin role) instead of needing special-case logic.

create table crl6mansqueuebot_admin_roles (
  role_id text primary key,
  added_by text not null,
  added_at timestamptz not null default now()
);

-- Per CLAUDE.md, "All admin actions get a basic audit log entry" — starting this now since
-- add/remove-admin-role is the first admin action being implemented.
create table crl6mansqueuebot_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_discord_id text not null,
  action text not null,
  target text null,
  details text null,
  created_at timestamptz not null default now()
);

alter table crl6mansqueuebot_admin_roles enable row level security;
alter table crl6mansqueuebot_audit_log enable row level security;

create policy "public read" on crl6mansqueuebot_admin_roles for select using (true);
create policy "public read" on crl6mansqueuebot_audit_log for select using (true);

-- mod_role_id is superseded by crl6mansqueuebot_admin_roles above (single-role -> multi-role).
delete from crl6mansqueuebot_config where key = 'mod_role_id';
