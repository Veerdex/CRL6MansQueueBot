-- Player avatar caching — see CLAUDE.md, "Discord bot commands & channels" / website leaderboard.
-- The website reads from Supabase, not live from Discord on every page load, so each player's
-- current server (guild) avatar is cached here and refreshed daily by a cron job, the same way
-- display_name/mmr/band are already columns rather than fetched live. Stores a ready-to-use CDN
-- URL (not a raw hash) so the website never needs Discord-specific URL-building logic.
alter table crl6mansqueuebot_players
  add column avatar_url text null;
