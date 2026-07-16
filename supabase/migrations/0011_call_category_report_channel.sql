-- CRL 6 Mans — Phase 9 (channel redesign) schema.
-- Extends 0010 (additive only). Moves from per-match categories to a single admin-specified
-- category for all voice channels, and adds a dedicated report channel (see CLAUDE.md,
-- "Discord bot commands & channels").

-- ---------------------------------------------------------------------------
-- Admin-specified call category and report channel configuration.
-- Stored as Discord ID strings in the config table (same pattern as other Discord IDs).
-- ---------------------------------------------------------------------------

insert into crl6mansqueuebot_config (key, value) values
  ('6mans_call_category_id', ''),
  ('report_channel_id', '');