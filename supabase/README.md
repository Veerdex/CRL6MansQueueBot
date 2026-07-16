# Supabase schema

This project's Supabase instance is shared with another app, so every table here is prefixed
`crl6mansqueuebot_` to avoid collisions — there's no dedicated Postgres schema involved.

## Applying a migration

No Supabase CLI project link is set up (kept things simple — one project, no local Supabase
stack). To apply `migrations/0001_init.sql` (or any future migration file):

1. Open the Supabase dashboard for the project → **SQL Editor**.
2. Paste the contents of the migration file.
3. Run it.

Migration files are numbered and additive — never edit an already-applied one; add a new
`NNNN_description.sql` file instead, same as any other migration history.
