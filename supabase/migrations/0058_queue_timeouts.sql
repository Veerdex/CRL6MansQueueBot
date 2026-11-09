-- Admin queue timeouts and strikes — see CLAUDE.md, "Queue timeouts and strikes".
--
-- queue_timeout_until: the player can't /q until this instant. null = no timeout. A permanent
-- ban (strike level 5+) is stored as 'infinity', which compares greater than every real
-- timestamp and comes back from PostgREST as the string "infinity".
--
-- strike_count: the player's current strike level, set by /strike. Independent of
-- queue_timeout_until — a plain /timeout never changes it, and a timeout expiring never resets it.
alter table crl6mansqueuebot_players add column queue_timeout_until timestamptz;
alter table crl6mansqueuebot_players add column strike_count integer not null default 0;
alter table crl6mansqueuebot_players add constraint crl6mansqueuebot_players_strike_count_check check (strike_count >= 0);
