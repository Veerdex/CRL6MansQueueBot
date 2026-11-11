-- CRL 6 Mans — replaces the tiered sweep jobs (0057) with ONE every-minute pg_cron job that asks
-- Postgres what is actually due and calls the sweep route only when something is, passing the
-- reasons so the route runs just those passes (web/lib/discord/sweepReasons.ts). The aim is Vercel
-- Active CPU: on a quiet minute nothing calls the route at all, and a wake runs only the passes
-- that have work. Same pattern as the CRL6Mans site's crl_cron schema (docs/cron-cpu.md there);
-- this bot uses its own schema since both projects share this database.
--
-- Rules, all in tick() below:
--   * A reason wakes as soon as one of its rows became due after the reason's last wake, so a new
--     deadline is handled within a minute.
--   * A reason still due after a wake (e.g. a Discord failure the route couldn't clear) waits
--     retry_after (10 min) before waking again, rather than every minute. (0060 changes this to
--     every minute.)
--   * A wake still in flight (no pg_net response yet, under 5 min old) blocks the next one.
--
-- What moves elsewhere:
--   * The one-off season reset job and its two RPCs are gone: the reset is just a due() row.
--   * The stray match-role reclaim and the Match Times day counter compare against Discord / the
--     calendar rather than table rows, so they now run in the daily refresh-avatars job (0027,
--     09:30 UTC). See web/lib/discord/dailyBackstops.ts.
--
-- Every reason in due() must exist in sweepReasons.ts and vice versa. The route treats a body with
-- no recognised reason as the whole sweep, so deploying the code before or after this migration
-- is safe either way.
--
-- Dry run before trusting it:  select * from crl6mansqueuebot_cron.due();

create schema if not exists crl6mansqueuebot_cron;
revoke all on schema crl6mansqueuebot_cron from public, anon, authenticated;

create table if not exists crl6mansqueuebot_cron.wakes (
  id         bigserial primary key,
  reasons    text[] not null,
  request_id bigint,
  woken_at   timestamptz not null default now()
);
create index if not exists wakes_woken_at on crl6mansqueuebot_cron.wakes (woken_at desc);

-- A numeric config value, or the app's default when it's missing or not a number — mirrors
-- getConfigNumber, so a bad value can't make the gate disagree with the route (or raise).
create or replace function crl6mansqueuebot_cron.cfg_num(p_key text, p_default numeric)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select c.value::numeric from public.crl6mansqueuebot_config c
      where c.key = p_key and c.value ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'),
    p_default
  )
$$;

-- The scheduled season reset instant, or null when none is set or the value doesn't parse.
create or replace function crl6mansqueuebot_cron.scheduled_reset_at()
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v_raw text;
begin
  select c.value into v_raw from public.crl6mansqueuebot_config c
   where c.key = 'scheduled_season_reset_at';
  if v_raw is null then
    return null;
  end if;
  return v_raw::timestamptz;
exception when others then
  return null;
end $$;

-- Each row is something the sweep route would act on right now, with the moment it became due
-- (null = no timestamp; only the retry interval can re-wake it). Each condition mirrors the query
-- of the matching pass in web/app/api/discord/sweep/route.ts — keep them in step.
create or replace function crl6mansqueuebot_cron.due()
returns table (reason text, due_at timestamptz)
language sql
stable
set search_path = ''
as $$
  with cfg as (
    select
      make_interval(secs => crl6mansqueuebot_cron.cfg_num('vote_timeout_seconds', 180))          as vote,
      make_interval(mins => crl6mansqueuebot_cron.cfg_num('sub_request_timeout_minutes', 10)::int) as sub,
      make_interval(secs => crl6mansqueuebot_cron.cfg_num('mafia_timeout_seconds', 120))         as mafia,
      crl6mansqueuebot_cron.cfg_num('series_timeout_hours', 2) * interval '1 hour'               as series,
      crl6mansqueuebot_cron.cfg_num('queue_member_timeout_minutes', 30) * interval '1 minute'    as queue
  )
  -- BO3/5/7 vote ran out of time.
  select 'series_length_vote', s.vote_started_at + cfg.vote
    from public.crl6mansqueuebot_series s, cfg
   where s.status = 'forming' and s.series_length_vote_active
     and s.vote_started_at + cfg.vote <= now()
  union all
  -- Nobody voted Balanced/Captains in time.
  select 'vote_silence', s.vote_started_at + cfg.vote
    from public.crl6mansqueuebot_series s, cfg
   where s.status = 'forming' and s.vote_result is null and not s.series_length_vote_active
     and s.vote_started_at + cfg.vote <= now()
     and not exists (select 1 from public.crl6mansqueuebot_series_votes v where v.series_id = s.id)
  union all
  -- A captain's pick timer ran out (vote_started_at is re-stamped on every pick prompt).
  select 'draft_pick', s.vote_started_at + cfg.vote
    from public.crl6mansqueuebot_series s, cfg
   where s.status = 'forming' and s.vote_result = 'captains' and not s.series_length_vote_active
     and s.vote_started_at + cfg.vote <= now()
  union all
  select 'sub_expiry', r.created_at + cfg.sub
    from public.crl6mansqueuebot_sub_requests r, cfg
   where r.created_at + cfg.sub <= now()
  union all
  select 'mafia_lobby', g.created_at + cfg.mafia
    from public.crl6mansqueuebot_mafia_games g, cfg
   where g.status = 'waiting' and g.created_at + cfg.mafia <= now()
  union all
  select 'series_expiry', s.created_at + cfg.series
    from public.crl6mansqueuebot_series s, cfg
   where s.status in ('forming', 'active') and s.created_at + cfg.series <= now()
  union all
  select 'queue_inactivity', q.joined_at + cfg.queue
    from public.crl6mansqueuebot_queue_members q, cfg
   where q.queue_type = 'rank' and q.joined_at + cfg.queue <= now()
  union all
  -- A reported series still holding match channels. report.ts tears them down itself ~30s after
  -- the report; the 2-minute grace keeps a normal report from waking the route at all.
  select 'orphan_channels', s.reported_at + interval '2 minutes'
    from public.crl6mansqueuebot_series s
   where s.status = 'reported' and s.reported_at + interval '2 minutes' <= now()
     and (s.category_id is not null or s.voice_channel_a_id is not null or s.voice_channel_b_id is not null)
  union all
  -- A settled series still holding its @Match role. Same grace for a report; a void has no
  -- timestamp, so after its first wake it is picked up on the retry interval.
  select 'match_role_release',
         case when s.status = 'reported' then s.reported_at + interval '2 minutes' end
    from public.crl6mansqueuebot_series s
   where s.match_role_id is not null and s.status not in ('forming', 'active')
     and (s.status <> 'reported' or s.reported_at + interval '2 minutes' <= now())
  union all
  select 'stuck_mafia', g.created_at + cfg.mafia + interval '10 minutes'
    from public.crl6mansqueuebot_mafia_games g, cfg
   where g.status = 'starting' and g.created_at + cfg.mafia + interval '10 minutes' <= now()
  union all
  select 'season_reset', r.at
    from (select crl6mansqueuebot_cron.scheduled_reset_at() as at) r
   where r.at <= now()
$$;

-- How long a reason that is still due after a wake waits before waking again.
create or replace function crl6mansqueuebot_cron.retry_after(p_reason text)
returns interval
language sql
immutable
set search_path = ''
as $$
  select interval '10 minutes'
$$;

-- Wakes the sweep route only when something is due; see the header for the rules.
create or replace function crl6mansqueuebot_cron.tick()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_timeout int := 300000; -- the route's maxDuration
  v_reasons text[];
  v_request bigint;
begin
  if exists (
    select 1 from crl6mansqueuebot_cron.wakes w
     where w.woken_at > now() - v_timeout * interval '1 millisecond'
       and not exists (select 1 from net._http_response r where r.id = w.request_id)
  ) then
    return;
  end if;

  select array_agg(d.reason order by d.reason) into v_reasons
    from (select x.reason, max(x.due_at) as newest
            from crl6mansqueuebot_cron.due() x group by x.reason) d
    left join lateral (select max(w.woken_at) as last from crl6mansqueuebot_cron.wakes w
                        where d.reason = any (w.reasons)) l on true
   where l.last is null
      or d.newest > l.last
      or l.last < now() - crl6mansqueuebot_cron.retry_after(d.reason);

  if v_reasons is null then
    return;
  end if;

  select net.http_post(
           url := 'https://crl6mans-queue-bot.vercel.app/api/discord/sweep',
           headers := jsonb_build_object(
             'Content-Type', 'application/json',
             'x-sweep-secret', (
               select decrypted_secret from vault.decrypted_secrets
                where name = 'crl6mansqueuebot_cron_sweep_secret'
             )
           ),
           body := jsonb_build_object('reasons', to_jsonb(v_reasons)),
           timeout_milliseconds := v_timeout
         )
    into v_request;

  insert into crl6mansqueuebot_cron.wakes (reasons, request_id) values (v_reasons, v_request);
end $$;

revoke all on all functions in schema crl6mansqueuebot_cron from public, anon, authenticated;
revoke all on all tables in schema crl6mansqueuebot_cron from public, anon, authenticated;
revoke all on all sequences in schema crl6mansqueuebot_cron from public, anon, authenticated;

-- ── Retire 0057 ────────────────────────────────────────────────────────────────────────────────
select cron.unschedule(jobname)
  from cron.job
 where jobname in (
   'crl6mansqueuebot-sweep',
   'crl6mansqueuebot-sweep-minute',
   'crl6mansqueuebot-sweep-quarter',
   'crl6mansqueuebot-sweep-hourly',
   'crl6mansqueuebot-season-reset'
 );

drop function if exists public.crl6mansqueuebot_schedule_season_reset_cron(timestamptz);
drop function if exists public.crl6mansqueuebot_unschedule_season_reset_cron();

-- ── The single job, plus housekeeping ──────────────────────────────────────────────────────────
select cron.schedule('crl6mansqueuebot-sweep', '* * * * *', $$select crl6mansqueuebot_cron.tick()$$);

-- An every-minute job writes ~1,440 job_run_details rows a day; keep three days of them, and two
-- months of wakes for looking back at what woke the route and why.
select cron.schedule('crl6mansqueuebot-cron-cleanup', '23 3 * * *', $$
  delete from cron.job_run_details
   where end_time < now() - interval '3 days'
     and jobid in (select jobid from cron.job where jobname like 'crl6mansqueuebot-%');
  delete from crl6mansqueuebot_cron.wakes where woken_at < now() - interval '60 days';
$$);
