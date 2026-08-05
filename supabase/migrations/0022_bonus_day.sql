-- Weekly bonus day: the actual K-factor multiplier is locked in on the series row at pop time
-- (not recomputed at report time), since eligibility is "the queue completed before the window
-- ended," not "the match happened to be reported during the window." 1 = no bonus.
alter table crl6mansqueuebot_series add column bonus_day_multiplier numeric not null default 1;
