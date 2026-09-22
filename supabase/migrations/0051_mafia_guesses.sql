-- /mafia guessing — see CLAUDE.md, "Mafia".
--
-- Each player's current guess at who the Mafia is, set from the "Make your guess" button on the
-- Game Started message and shown with ✅/❌ by /reveal. Null means no guess yet; an empty array
-- means "No Mafia" (only offered in a 0-or-1 coin-flip lobby); otherwise the suspects' Discord
-- ids. Players can change it freely until the game is revealed.
alter table crl6mansqueuebot_mafia_players
  add column guess text[] null;
