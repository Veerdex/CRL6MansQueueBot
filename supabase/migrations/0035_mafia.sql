-- /mafia mini-game: fully independent of crl6mansqueuebot_players (raw Discord ids/display
-- names/interaction tokens only) — see CLAUDE.md, "Mafia". One lobby per channel while
-- waiting/starting; join/leave are advisory-lock-guarded RPCs mirroring
-- crl6mansqueuebot_join_queue/leave_queue (0002_queue_system.sql).

create table crl6mansqueuebot_mafia_games (
  id uuid primary key default gen_random_uuid(),
  channel_id text not null,
  guild_id text not null,
  message_id text,
  host_discord_id text not null,
  status text not null default 'waiting' check (status in ('waiting', 'starting', 'started', 'cancelled')),
  created_at timestamptz not null default now(),
  started_at timestamptz
);

-- Only one lobby may be waiting/starting in a given channel at a time — a fresh /mafia run
-- while one's already in flight there should be rejected, not silently spawn a second lobby
-- sharing the same channel's Join/Leave buttons.
create unique index crl6mansqueuebot_mafia_games_active_channel_idx
  on crl6mansqueuebot_mafia_games (channel_id)
  where status in ('waiting', 'starting');

create table crl6mansqueuebot_mafia_players (
  game_id uuid not null references crl6mansqueuebot_mafia_games(id) on delete cascade,
  discord_id text not null,
  display_name text not null,
  -- Captured at join time so the mafia-reveal step (game start) can deliver a genuinely
  -- private message via each player's own interaction webhook token (sendFollowupMessage,
  -- rest.ts) — there is no bot-token REST call that can send an arbitrary ephemeral message
  -- out of band, only a response/followup tied to the token that created it. The lobby's
  -- whole lifecycle (<=2 minutes to fill, +5s grace) is comfortably inside the 15-minute
  -- token window.
  interaction_token text not null,
  joined_at timestamptz not null default now(),
  primary key (game_id, discord_id)
);

alter table crl6mansqueuebot_mafia_games enable row level security;
create policy "public read" on crl6mansqueuebot_mafia_games for select using (true);

alter table crl6mansqueuebot_mafia_players enable row level security;
create policy "public read" on crl6mansqueuebot_mafia_players for select using (true);

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

  select status into v_status from crl6mansqueuebot_mafia_games where id = p_game_id;
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

  select status into v_status from crl6mansqueuebot_mafia_games where id = p_game_id;
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
