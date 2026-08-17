-- Correct votes: one row per player per series, tracks who wants to flip a mis-reported
-- match's result via /correct. Once 5 of that series' 6 participants vote, the winner flips
-- and a new report message is posted — see CLAUDE.md, "Self-service correction (/correct)".
-- Existence = pending, same convention as crl6mansqueuebot_cancel_votes/abandon_votes.

create table crl6mansqueuebot_correct_votes (
  series_id uuid not null references crl6mansqueuebot_series(id) on delete cascade,
  player_id uuid not null references crl6mansqueuebot_players(id) on delete cascade,
  voted_at timestamptz not null default now(),
  primary key (series_id, player_id)
);

alter table crl6mansqueuebot_correct_votes enable row level security;
create policy "public read" on crl6mansqueuebot_correct_votes for select using (true);

-- One-time claim flag: a series can only ever be flipped once via player vote (prevents a
-- flip-flop/griefing vector from repeated re-votes). Series stays status='reported' throughout
-- — this is a separate sentinel column rather than a status transition, since /report's and
-- /admin correct-report's own status handling must be unaffected.
alter table crl6mansqueuebot_series add column correction_claimed_at timestamptz null;
