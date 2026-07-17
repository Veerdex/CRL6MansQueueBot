-- Add match number for custom match ID encoding (base-71 using 0-9, a-z, A-Z, !-))
alter table crl6mansqueuebot_series add column match_number integer unique;

-- Create index for efficient lookup
create index idx_series_match_number on crl6mansqueuebot_series(match_number);
