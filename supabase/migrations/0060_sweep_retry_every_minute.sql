-- CRL 6 Mans — the gated sweep cron (0059) retries a reason that is still due after a wake on the
-- next minute instead of after 10 minutes, for every reason. The user chose this over the
-- throttle: in normal operation the first wake clears the work, so it costs nothing extra, and
-- the failures a retry can't fix were judged not worth throttling for.
--
-- 50 seconds rather than exactly one minute, so pg_cron's start-time jitter can't make a retry
-- skip a tick. The in-flight guard in tick() still stops a new wake while one is running.
-- Per-reason intervals can be added here with a case on p_reason later if needed.

create or replace function crl6mansqueuebot_cron.retry_after(p_reason text)
returns interval
language sql
immutable
set search_path = ''
as $$
  select interval '50 seconds'
$$;

revoke all on function crl6mansqueuebot_cron.retry_after(text) from public, anon, authenticated;
