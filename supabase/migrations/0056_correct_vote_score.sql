-- /correct votes now carry the result they propose, so a series-score match can have its score
-- fixed (not just its winner flipped), and the threshold drops from 5 of 6 to 4 of 6 votes for
-- the *same* proposal — see CLAUDE.md, "Reporting, substitutes, and teardown". At 4 of 6, two
-- different proposals can never both reach the threshold.
--
-- proposed_winner is the winning team the voter says is correct. proposed_winner_games /
-- proposed_loser_games are winner-relative like crl6mansqueuebot_series.winner_games/loser_games
-- (migration 0055): null for a plain flip of a match reported without a score; for a flip of a
-- scored match they carry the existing margin over unchanged.
alter table crl6mansqueuebot_correct_votes add column proposed_winner text;
alter table crl6mansqueuebot_correct_votes add column proposed_winner_games smallint;
alter table crl6mansqueuebot_correct_votes add column proposed_loser_games smallint;

-- Any vote pending from before this migration was a plain flip vote.
update crl6mansqueuebot_correct_votes v
set proposed_winner = case s.winner_team when 'A' then 'B' else 'A' end,
    proposed_winner_games = s.winner_games,
    proposed_loser_games = s.loser_games
from crl6mansqueuebot_series s
where s.id = v.series_id;

alter table crl6mansqueuebot_correct_votes alter column proposed_winner set not null;
alter table crl6mansqueuebot_correct_votes add constraint crl6mansqueuebot_correct_votes_proposed_winner_check check (proposed_winner in ('A', 'B'));
