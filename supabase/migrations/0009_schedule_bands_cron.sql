-- CRL 6 Mans — schedules the Phase 5 band recompute route to run once daily via pg_cron +
-- pg_net, mirroring 0003's sweep job. Runs at 09:00 UTC (a low-traffic window for this
-- server's playerbase) so band-change DMs land at a reasonable hour rather than mid-match
-- or the middle of the night.
--
-- Reuses the same shared secret as the sweep job ('crl6mansqueuebot_cron_sweep_secret' in
-- Vault) since both are pg_net-triggered background jobs with no interaction to hang off of
-- — no need to provision a second secret just to distinguish them.

select cron.schedule(
  'crl6mansqueuebot-recompute-bands',
  '0 9 * * *',
  $$
  select net.http_post(
    url := 'https://crl6mans-queue-bot.vercel.app/api/discord/recompute-bands',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sweep-secret', (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'crl6mansqueuebot_cron_sweep_secret'
      )
    ),
    body := '{}'::jsonb
  );
  $$
);
