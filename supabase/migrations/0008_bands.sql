-- CRL 6 Mans — Phase 5 (bands / promotion / demotion + role sync) schema.
-- Extends 0001/0002 (additive only, same convention as before).

-- ---------------------------------------------------------------------------
-- band_games_played: Rank Queue games played since the player's current band was assigned
-- (initial placement, promotion, or demotion) — powers the grace-period demotion safeguard.
-- Distinct from rank_games_played (lifetime rank-queue count, used for provisional K) and
-- total_games_played (both queues, used for placement bootstrap). See CLAUDE.md, "Bands / ranks".
-- ---------------------------------------------------------------------------

alter table crl6mansqueuebot_players
  add column band_games_played int not null default 0;

-- ---------------------------------------------------------------------------
-- Discord role IDs to grant/revoke on band change. 'Placed' is the generic Rank Queue access
-- gate (any band) — granted once on initial placement, never revoked afterward. Admin-settable
-- via /setbandrole, mirroring /setqueuechannel's channel-mapping pattern.
-- ---------------------------------------------------------------------------

create table crl6mansqueuebot_band_roles (
  band text primary key check (band in ('Iron', 'Garnet', 'Emerald', 'Sapphire', 'Placed')),
  role_id text not null,
  updated_at timestamptz not null default now()
);

alter table crl6mansqueuebot_band_roles enable row level security;
create policy "public read" on crl6mansqueuebot_band_roles for select using (true);

-- ---------------------------------------------------------------------------
-- Percentile cutoffs for the daily band recompute — cumulative percentile-of-placed-players
-- thresholds, chosen to skew toward the lower bands (40/30/20/10 split) per the Champ+
-- population framing in CLAUDE.md: Iron = below the 40th percentile, Garnet = 40th-70th,
-- Emerald = 70th-90th, Sapphire = 90th and above. Admin-tunable like every other config value.
-- ---------------------------------------------------------------------------

insert into crl6mansqueuebot_config (key, value) values
  ('band_cutoff_garnet_pctile', '40'),
  ('band_cutoff_emerald_pctile', '70'),
  ('band_cutoff_sapphire_pctile', '90');
