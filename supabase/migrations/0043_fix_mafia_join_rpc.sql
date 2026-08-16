-- Diagnostic/repair for production. Original symptom (table DDL applied fine, RPC calls failing)
-- turned out to be a genuine bug in 0035_mafia.sql's function bodies, not a partial-migration
-- issue: `returns table (status text, player_count int)` implicitly declares `status` as a
-- PL/pgSQL variable, which collides with the `crl6mansqueuebot_mafia_games.status` column in the
-- bare `select status into v_status from crl6mansqueuebot_mafia_games where id = p_game_id`
-- lines — Postgres error 42702 "column reference \"status\" is ambiguous". Fixed here by
-- qualifying the column reference. Re-creating the two functions and their grants is idempotent
-- (create or replace function / grant are both safe to re-run).

create or replace function crl6mansqueuebot_mafia_join(
  p_game_id uuid,
  p_discord_id text,
  p_display_name text,
  p_interaction_token text,
  p_max_size int default 6
)
returns table (status text, player_count int)
as $$
declare
  v_status text;
  v_count int;
begin
  perform pg_advisory_xact_lock(hashtext(p_game_id::text));

  select crl6mansqueuebot_mafia_games.status into v_status from crl6mansqueuebot_mafia_games where id = p_game_id;
  if v_status is null or v_status <> 'waiting' then
    select count(*) into v_count from crl6mansqueuebot_mafia_players where game_id = p_game_id;
    return query select 'not_open'::text, v_count;
    return;
  end if;

  if exists (select 1 from crl6mansqueuebot_mafia_players where game_id = p_game_id and discord_id = p_discord_id) then
    select count(*) into v_count from crl6mansqueuebot_mafia_players where game_id = p_game_id;
    return query select 'already_joined'::text, v_count;
    return;
  end if;

  select count(*) into v_count from crl6mansqueuebot_mafia_players where game_id = p_game_id;
  if v_count >= p_max_size then
    return query select 'full'::text, v_count;
    return;
  end if;

  insert into crl6mansqueuebot_mafia_players (game_id, discord_id, display_name, interaction_token)
  values (p_game_id, p_discord_id, p_display_name, p_interaction_token);
  v_count := v_count + 1;

  if v_count >= p_max_size then
    update crl6mansqueuebot_mafia_games set status = 'starting' where id = p_game_id;
  end if;

  return query select 'joined'::text, v_count;
end;
$$ language plpgsql;

create or replace function crl6mansqueuebot_mafia_leave(
  p_game_id uuid,
  p_discord_id text
)
returns table (status text, player_count int)
as $$
declare
  v_status text;
  v_count int;
  v_deleted int;
begin
  perform pg_advisory_xact_lock(hashtext(p_game_id::text));

  select crl6mansqueuebot_mafia_games.status into v_status from crl6mansqueuebot_mafia_games where id = p_game_id;
  if v_status is null or v_status <> 'waiting' then
    select count(*) into v_count from crl6mansqueuebot_mafia_players where game_id = p_game_id;
    return query select 'not_open'::text, v_count;
    return;
  end if;

  delete from crl6mansqueuebot_mafia_players where game_id = p_game_id and discord_id = p_discord_id;
  get diagnostics v_deleted = row_count;
  select count(*) into v_count from crl6mansqueuebot_mafia_players where game_id = p_game_id;

  if v_deleted = 0 then
    return query select 'not_joined'::text, v_count;
    return;
  end if;

  return query select 'left'::text, v_count;
end;
$$ language plpgsql;

revoke all on function crl6mansqueuebot_mafia_join from public;
grant execute on function crl6mansqueuebot_mafia_join to service_role;

revoke all on function crl6mansqueuebot_mafia_leave from public;
grant execute on function crl6mansqueuebot_mafia_leave to service_role;
