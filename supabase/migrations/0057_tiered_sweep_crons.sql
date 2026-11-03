-- CRL 6 Mans — splits the single every-minute sweep job (0003) into tiers, so the sweep route
-- (and the Vercel function behind it) only runs when there is something for it to do.
--
--   crl6mansqueuebot-sweep-minute   every minute, but only calls the route while a series is
--                                   forming (vote / draft timers), a /sub request is pending, or
--                                   a Mafia lobby is waiting for players.
--   crl6mansqueuebot-sweep-quarter  every 15 minutes, but only while a series is forming/active or
--                                   someone is queued: the 2-hour series expiry and queue
--                                   inactivity removal.
--   crl6mansqueuebot-sweep-hourly   every hour, always: leftover channel / match-role / Mafia
--                                   lobby backstops, the Match Times day counter, and the safety
--                                   net for an overdue scheduled season reset.
--   crl6mansqueuebot-season-reset   a one-off job /schedule-reset creates for the reset's minute
--                                   (via the functions below) and that is removed when it fires.
--
-- The gates are plain EXISTS checks against the live tables rather than a counter the app keeps
-- in step, so they can't drift: if the data says nothing is pending, nothing is.
--
-- The quarter and hourly jobs sit on off-minutes so they don't land in the same minute as each
-- other or as a season reset (midnight Pacific is always minute 0 UTC, and the one-off job runs
-- the minute after, i.e. minute 1). The route claims the reset atomically regardless.
--
-- Same Vault secret / x-sweep-secret header convention as 0003, 0009 and 0027. The route treats
-- a request with no "tier" as the full old sweep, so it's safe to deploy the code before this
-- migration is applied.

select cron.unschedule('crl6mansqueuebot-sweep')
where exists (select 1 from cron.job where jobname = 'crl6mansqueuebot-sweep');

select cron.schedule(
  'crl6mansqueuebot-sweep-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://crl6mans-queue-bot.vercel.app/api/discord/sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sweep-secret', (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'crl6mansqueuebot_cron_sweep_secret'
      )
    ),
    body := '{"tier":"minute"}'::jsonb
  )
  where exists (select 1 from public.crl6mansqueuebot_series where status = 'forming')
     or exists (select 1 from public.crl6mansqueuebot_sub_requests)
     or exists (select 1 from public.crl6mansqueuebot_mafia_games where status = 'waiting');
  $$
);

select cron.schedule(
  'crl6mansqueuebot-sweep-quarter',
  '7,22,37,52 * * * *',
  $$
  select net.http_post(
    url := 'https://crl6mans-queue-bot.vercel.app/api/discord/sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sweep-secret', (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'crl6mansqueuebot_cron_sweep_secret'
      )
    ),
    body := '{"tier":"quarter"}'::jsonb
  )
  where exists (select 1 from public.crl6mansqueuebot_series where status in ('forming', 'active'))
     or exists (select 1 from public.crl6mansqueuebot_queue_members);
  $$
);

select cron.schedule(
  'crl6mansqueuebot-sweep-hourly',
  '41 * * * *',
  $$
  select net.http_post(
    url := 'https://crl6mans-queue-bot.vercel.app/api/discord/sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sweep-secret', (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'crl6mansqueuebot_cron_sweep_secret'
      )
    ),
    body := '{"tier":"hourly"}'::jsonb
  );
  $$
);

-- One-off season reset job. pg_cron schedules have no year field, so the job is pinned to the
-- minute/hour/day/month (UTC, pg_cron's default cron.timezone) of the minute AFTER the reset
-- instant — never early, even if pg_cron's and Vercel's clocks disagree slightly — and is
-- removed once it fires. Scheduling again replaces it, since cron.schedule upserts by name.
create or replace function public.crl6mansqueuebot_schedule_season_reset_cron(p_reset_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_fire timestamp := date_trunc('minute', p_reset_at at time zone 'UTC') + interval '1 minute';
begin
  perform cron.schedule(
    'crl6mansqueuebot-season-reset',
    format(
      '%s %s %s %s *',
      extract(minute from v_fire)::int,
      extract(hour from v_fire)::int,
      extract(day from v_fire)::int,
      extract(month from v_fire)::int
    ),
    $cmd$
    select net.http_post(
      url := 'https://crl6mans-queue-bot.vercel.app/api/discord/sweep',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-sweep-secret', (
          select decrypted_secret from vault.decrypted_secrets
          where name = 'crl6mansqueuebot_cron_sweep_secret'
        )
      ),
      body := '{"tier":"season-reset"}'::jsonb
    );
    $cmd$
  );
end;
$fn$;

-- Returns whether a job was removed. cron.unschedule raises on a missing name, hence the check.
create or replace function public.crl6mansqueuebot_unschedule_season_reset_cron()
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if exists (select 1 from cron.job where jobname = 'crl6mansqueuebot-season-reset') then
    perform cron.unschedule('crl6mansqueuebot-season-reset');
    return true;
  end if;
  return false;
end;
$fn$;

-- These can create and delete cron jobs, so only the bot's service role may call them.
revoke all on function public.crl6mansqueuebot_schedule_season_reset_cron(timestamptz) from public, anon, authenticated;
revoke all on function public.crl6mansqueuebot_unschedule_season_reset_cron() from public, anon, authenticated;
grant execute on function public.crl6mansqueuebot_schedule_season_reset_cron(timestamptz) to service_role;
grant execute on function public.crl6mansqueuebot_unschedule_season_reset_cron() to service_role;

-- A reset already scheduled before this migration gets its one-off job now.
select public.crl6mansqueuebot_schedule_season_reset_cron(value::timestamptz)
from public.crl6mansqueuebot_config
where key = 'scheduled_season_reset_at'
  and value::timestamptz > now();
