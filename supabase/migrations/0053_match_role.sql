-- Temporary per-match Discord role, so a pop pings `@Match #263` once instead of listing six
-- individual `<@user>` mentions in the message content.
--
-- Created when the queue pops (queue.ts's createMatchChannels, before the formation message is
-- posted — a role mention is resolved against the role's membership at send time, so all six
-- have to be wearing it *before* the post or nobody is notified) and deleted at teardown, which
-- strips it from all six members in a single API call.
--
-- Per-match rather than a fixed pool of reusable roles: a pool needs an allocation race, a
-- fallback for more concurrent matches than it has slots, and a stale-holder strip before reuse,
-- and getting any of those wrong pings the wrong players. A freshly created role cannot
-- contaminate a later match. The cost is that a leak consumes a role slot, and this guild is at
-- 204 of Discord's hard 250-role limit — hitting the cap would block *all* role creation
-- server-wide, band roles included — so the sweep route's reclaim pass is load-bearing, not
-- optional. It deletes any `Match #<n>` role older than a few minutes that no series row points
-- at (the age floor is what keeps it from deleting a role created seconds earlier whose id has
-- not been written back here yet).
alter table crl6mansqueuebot_series add column match_role_id text;

-- The "Teams formed!" message is tracked with keep_permanently = true, so it stays in the queue
-- channel as the match's record long after the series is over. Its content line carries the ping,
-- and once the role is deleted Discord renders `<@&id>` as `@deleted-role` — which would leave
-- every past match in the channel reading "@deleted-role — teams are formed!". Storing the
-- message id lets teardown rewrite that line back to the six plain mentions before dropping the
-- role, so channel history reads exactly as it does today. (Discord does not re-notify on edit,
-- so rewriting it cannot re-ping anyone.)
alter table crl6mansqueuebot_series add column teams_formed_message_id text;
