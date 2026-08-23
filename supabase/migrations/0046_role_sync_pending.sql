-- Discord role-sync retry flag — see CLAUDE.md, "Bands and role synchronization". recomputeBands()
-- only attempts a Discord role add/remove when a player's band/is_prism value is actually
-- *changing* this run; a transient failure partway through that attempt (rate limit or otherwise)
-- previously left Discord permanently out of sync with the DB, since the next run's "did this
-- change" guard sees the DB already matches the target state and never retries. This flag
-- decouples "did the DB write commit" from "did the Discord role actually get fixed," so a failed
-- sync gets retried on the next recompute regardless of whether band/is_prism changes again.
alter table crl6mansqueuebot_players
  add column role_sync_pending boolean not null default false;
