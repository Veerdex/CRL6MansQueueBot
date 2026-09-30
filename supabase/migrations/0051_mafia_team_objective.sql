-- /mafia mode 'team_objective' (Team Mafia) — see CLAUDE.md, "Mafia mini-game".
--
-- A third mode with no mafia at all: the six players are split into two balanced 3v3 teams (Blue
-- and Orange) by their 6-mans rank MMR, and each team is privately dealt one objective. A team
-- scores 2 points for completing its objective and 1 for winning the game, so a team can complete
-- its objective, lose the match, and still finish ahead.

alter table crl6mansqueuebot_mafia_games
  drop constraint crl6mansqueuebot_mafia_games_mode_check;

alter table crl6mansqueuebot_mafia_games
  add constraint crl6mansqueuebot_mafia_games_mode_check
    check (mode in ('classic', 'hidden_objective', 'team_objective'));

-- Null for every classic/hidden_objective game and for any team game still in the lobby: like
-- is_mafia/objective (0050), this is only meaningful once status = 'started'. The join RPC
-- (0035/0043) names its insert columns explicitly and knows nothing about teams, so a freshly
-- joined player is correctly unassigned until runMafiaFinalizeSequence splits the lobby.
alter table crl6mansqueuebot_mafia_players
  add column team text null;

alter table crl6mansqueuebot_mafia_players
  add constraint crl6mansqueuebot_mafia_players_team_check
    check (team in ('blue', 'orange'));
