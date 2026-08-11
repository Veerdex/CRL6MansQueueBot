-- Resync crl6mansqueuebot_match_number_seq — see CLAUDE.md's "Match #N voice-channel naming"
-- note for the original fix (migration 0030_fix_match_number_race.sql). That migration's setval
-- only synced the sequence past whatever match_number values existed AT THAT MOMENT; a row that
-- later gets a match_number some way other than the sequence default (a manual edit/restore via
-- Supabase's Table Editor, not through queue.ts's handlePop insert, which never sets this column
-- itself) can leave the sequence pointing below the table's real max. The sequence then
-- eventually collides once nextval() counts back up to that manually-set value — hit live:
-- "duplicate key value violates unique constraint... Key (match_number)=(18) already exists"
-- with matches up to #27 already existing but the sequence still only counting up to 18.
--
-- Same setval() logic 0030 already used, just re-run to catch the sequence up past whatever
-- currently exists (is_called=true, so the next nextval() call returns max+1, not max).
select setval(
  'crl6mansqueuebot_match_number_seq',
  coalesce((select max(match_number) from crl6mansqueuebot_series), 0),
  true
);
