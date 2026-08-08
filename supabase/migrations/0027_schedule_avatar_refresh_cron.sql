-- Daily avatar refresh — see 0026_player_avatar.sql and CLAUDE.md. Mirrors
-- 0009_schedule_bands_cron.sql's pattern exactly: same Vault secret / x-sweep-secret header
-- convention (both are pg_net-triggered background jobs with the same trust boundary), offset
-- 30 minutes from the bands recompute so the two don't fire in the same instant for no reason.
select cron.schedule(
  'crl6mansqueuebot-refresh-avatars',
  '30 9 * * *',
  $$
  select net.http_post(
    url := 'https://crl6mans-queue-bot.vercel.app/api/discord/refresh-avatars',
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
