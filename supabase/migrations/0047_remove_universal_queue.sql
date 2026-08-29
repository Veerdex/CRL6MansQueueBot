-- Remove Universal Queue entirely, including historical data. Extends 0001/0002/0018/0020/0021
-- (never edit those files — additive only, same convention as before). Per CLAUDE.md, this file
-- being added here does NOT make it live: it must be applied manually to production Supabase,
-- and it irreversibly deletes rows and drops a table, so back up crl6mansqueuebot_series where
-- queue_type='universal' (and crl6mansqueuebot_universal_game_predictions) before running it.
-- Apply only after the application code that stops writing queue_type='universal' is deployed.

-- 1. Purge all Universal Queue series. Cascades (all series_id FKs are "on delete cascade") to
--    crl6mansqueuebot_series_players, series_lobby, series_votes, series_length_votes,
--    cancel_votes, correct_votes, sub_requests, abandon_votes, rank_game_predictions, and
--    universal_game_predictions.
delete from crl6mansqueuebot_series where queue_type = 'universal';

-- 2. Purge queue_type-keyed rows not linked via series_id.
delete from crl6mansqueuebot_queue_members where queue_type = 'universal';
delete from crl6mansqueuebot_queue_messages where queue_type = 'universal';
delete from crl6mansqueuebot_queue_mention_roles where queue_type = 'universal';
delete from crl6mansqueuebot_notification_roles where queue_type = 'universal';

-- 3. Drop the now-empty, purely-Universal predictions table outright.
drop table if exists crl6mansqueuebot_universal_game_predictions;

-- 4. Recompute total_games_played for real players so it reflects Rank-only history going
--    forward. Universal reports only ever incremented total_games_played and nothing else
--    (no MMR/band/streak field), so rank_games_played is an exact reconstruction of what
--    total_games_played would be had Universal never existed. Test-data players are left
--    untouched (their counters are synthetic and reset by admin test tooling anyway).
update crl6mansqueuebot_players
set total_games_played = rank_games_played
where is_test_data = false;

-- 5. Narrow queue_type to 'rank' only everywhere it's constrained. Constraint names were never
--    set explicitly in 0001/0002/0018, so look each one up by table+column instead of guessing
--    Postgres's default-generated name.
do $$
declare
  v_constraint_name text;
begin
  for v_constraint_name in
    select conname from pg_constraint
    where conrelid = 'crl6mansqueuebot_series'::regclass
      and pg_get_constraintdef(oid) ilike '%queue_type%'
  loop
    execute format('alter table crl6mansqueuebot_series drop constraint %I', v_constraint_name);
  end loop;

  for v_constraint_name in
    select conname from pg_constraint
    where conrelid = 'crl6mansqueuebot_queue_members'::regclass
      and pg_get_constraintdef(oid) ilike '%queue_type%'
  loop
    execute format('alter table crl6mansqueuebot_queue_members drop constraint %I', v_constraint_name);
  end loop;

  for v_constraint_name in
    select conname from pg_constraint
    where conrelid = 'crl6mansqueuebot_queue_messages'::regclass
      and pg_get_constraintdef(oid) ilike '%queue_type%'
  loop
    execute format('alter table crl6mansqueuebot_queue_messages drop constraint %I', v_constraint_name);
  end loop;

  for v_constraint_name in
    select conname from pg_constraint
    where conrelid = 'crl6mansqueuebot_queue_mention_roles'::regclass
      and pg_get_constraintdef(oid) ilike '%queue_type%'
  loop
    execute format('alter table crl6mansqueuebot_queue_mention_roles drop constraint %I', v_constraint_name);
  end loop;
end $$;

alter table crl6mansqueuebot_series
  add constraint crl6mansqueuebot_series_queue_type_check check (queue_type in ('rank'));
alter table crl6mansqueuebot_queue_members
  add constraint crl6mansqueuebot_queue_members_queue_type_check check (queue_type in ('rank'));
alter table crl6mansqueuebot_queue_messages
  add constraint crl6mansqueuebot_queue_messages_queue_type_check check (queue_type in ('rank'));
alter table crl6mansqueuebot_queue_mention_roles
  add constraint crl6mansqueuebot_queue_mention_roles_queue_type_check check (queue_type in ('rank'));

-- crl6mansqueuebot_notification_roles never had a CHECK (0020_notification_roles.sql) — add one
-- now for consistency with the other three queue_type-keyed tables.
alter table crl6mansqueuebot_notification_roles
  add constraint crl6mansqueuebot_notification_roles_queue_type_check check (queue_type in ('rank'));
