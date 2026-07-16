-- CRL 6 Mans — Phase 7 (seasons: soft reset + Top 10/Prism) schema.
-- Extends 0008 (additive only, same convention as before).

-- ---------------------------------------------------------------------------
-- Prism is a season-end-only Top 10 tier layered on top of the 4 real bands (see CLAUDE.md,
-- "Bands / ranks" and "Seasons") — it's never touched by the daily recompute in bands.ts, only
-- by season close. Reuses band_roles/`/setbandrole` for storage rather than a dedicated table,
-- since the mapping shape (band-like-key -> Discord role id) is identical.
-- ---------------------------------------------------------------------------

alter table crl6mansqueuebot_band_roles
  drop constraint crl6mansqueuebot_band_roles_band_check;
alter table crl6mansqueuebot_band_roles
  add constraint crl6mansqueuebot_band_roles_band_check
  check (band in ('Iron', 'Garnet', 'Emerald', 'Sapphire', 'Placed', 'Prism'));

-- ---------------------------------------------------------------------------
-- Tracks current Prism holders so season close can strip the role from last season's Top 10
-- without needing to scan Discord's live role membership.
-- ---------------------------------------------------------------------------

alter table crl6mansqueuebot_players
  add column is_prism boolean not null default false;
