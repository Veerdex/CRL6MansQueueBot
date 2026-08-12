-- /mafia optional lobby password — see CLAUDE.md, "Mafia". Set once at lobby creation via the
-- command's optional password: option; if set, a player must enter the same password (via a
-- Discord modal shown on Join click) before the join RPC is even attempted. Plain nullable text,
-- no column-level access restriction — same precedent as crl6mansqueuebot_series.
-- private_match_password (0024_private_match_credentials.sql): a low-stakes access code, not a
-- real credential, so plaintext storage under the table's existing "public read" RLS policy is
-- an accepted, deliberate tradeoff rather than an oversight.
alter table crl6mansqueuebot_mafia_games
  add column password text null;
