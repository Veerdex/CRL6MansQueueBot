-- /mafia game modes, a configurable mafia count, and /reveal — see CLAUDE.md, "Mafia".
--
-- Role assignments were never persisted before this: runMafiaFinalizeSequence picked the mafia in
-- memory and delivered every role as an ephemeral followup, so nothing about who drew what
-- survived the interaction. /reveal has to name the mafia after the fact, so the assignment is now
-- written to crl6mansqueuebot_mafia_players when the lobby finalizes.

alter table crl6mansqueuebot_mafia_games
  add column mode text not null default 'classic',
  add column mafia_count smallint not null default 1,
  add column revealed_at timestamptz null;

-- 'classic' keeps the original behaviour (the mafia is simply told they're the mafia).
-- 'hidden_objective' gives each mafia a specific sabotage objective instead.
alter table crl6mansqueuebot_mafia_games
  add constraint crl6mansqueuebot_mafia_games_mode_check
    check (mode in ('classic', 'hidden_objective'));

-- The count the host *requested*, never the outcome. 0 is a deliberate special case meaning "coin
-- flip between one mafia and none", resolved at finalize time so nobody — including the host — can
-- know which way it landed. The outcome only ever lives in mafia_players.is_mafia.
alter table crl6mansqueuebot_mafia_games
  add constraint crl6mansqueuebot_mafia_games_mafia_count_check
    check (mafia_count between 0 and 6);

-- Defaults are deliberately the innocent case: crl6mansqueuebot_mafia_join inserts a player row
-- with an explicit column list (0035/0043) and knows nothing about roles, so a freshly joined
-- player is correctly non-mafia until runMafiaFinalizeSequence marks the chosen ones. That also
-- means these columns are only meaningful once the game reaches status = 'started'.
alter table crl6mansqueuebot_mafia_players
  add column is_mafia boolean not null default false,
  add column objective text null;
