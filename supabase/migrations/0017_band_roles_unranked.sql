-- Update band_roles check constraint to use 'Unranked' instead of 'Placed'
alter table crl6mansqueuebot_band_roles
  drop constraint crl6mansqueuebot_band_roles_band_check;
alter table crl6mansqueuebot_band_roles
  add constraint crl6mansqueuebot_band_roles_band_check
  check (band in ('Iron', 'Garnet', 'Emerald', 'Sapphire', 'Unranked', 'Prism'));
