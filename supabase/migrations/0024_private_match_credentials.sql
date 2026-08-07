-- Private match credentials + report cooldown — see CLAUDE.md, "Team formation (on pop)" and
-- "Reporting & disputes". teams_formed_at marks the moment a series flips from 'forming' to
-- 'active' (teamFormation.ts's finalizeTeams) — /report checks this against report_cooldown_minutes
-- (config, default 15) before allowing a settle, to prevent a false/premature report right after
-- teams are decided. private_match_password is a 4-random-digit string (leading zeros allowed,
-- generated fresh per series in finalizeTeams) DMed to each of the 6 players alongside the fixed
-- lobby name "crlw6m", so they can actually find and join the private match.
alter table crl6mansqueuebot_series
  add column teams_formed_at timestamptz null,
  add column private_match_password text null;
