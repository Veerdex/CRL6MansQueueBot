-- CRL 6 Mans — schedules the Phase 2 sweep route (series/vote/sub timeouts) to run every
-- minute via pg_cron + pg_net, per CLAUDE.md's "Discord bot runtime architecture". The
-- extensions themselves were enabled in 0002; this adds the actual scheduled job now that
-- the sweep route is deployed and its production URL is known.
--
-- The shared secret is looked up from Supabase Vault by name at cron-run time rather than
-- hardcoded here, since migration files are git-tracked and a plaintext secret in one would
-- be a permanent credential leak. The vault entry itself ('crl6mansqueuebot_cron_sweep_secret')
-- is created out-of-band via vault.create_secret(), not by this file.

select cron.schedule(
  'crl6mansqueuebot-sweep',
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
    body := '{}'::jsonb
  );
  $$
);
