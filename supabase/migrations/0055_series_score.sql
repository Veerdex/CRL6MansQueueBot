-- Series-score reporting (/admin report-mode mode:score). With the mode on, /report takes the
-- reporter's games won and the opponent's games won instead of a bare win/loss, the winner is
-- derived from the score, and the score's margin scales the MMR delta via
-- g = 1 - s/10 + 6s|a-b| / (35 ceil(s/2)) — a sweep pays more than 1x, the closest score less.
--
-- Stored as winner/loser rather than team A/team B: the margin doesn't change when a correction
-- (/correct or /admin correct-report) flips the winner, so a winner/loser score stays correct
-- without any swap and score_multiplier needs no recomputing (a correction that changes the
-- score itself rewrites all three — see migration 0056). Both game columns stay null for every series reported in win/loss mode (the
-- default) and for everything reported before this migration.
--
-- score_multiplier is snapshotted at report time, same precedent as series_length_k_multiplier,
-- so a correction reapplies exactly the multiplier the original report used even if an admin
-- has since toggled the mode. Defaults to 1, the no-op.
alter table crl6mansqueuebot_series add column winner_games smallint;
alter table crl6mansqueuebot_series add column loser_games smallint;
alter table crl6mansqueuebot_series add column score_multiplier numeric not null default 1;
