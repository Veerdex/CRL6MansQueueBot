-- Lets a queue_type's tracked-message row exist with no live Discord message attached, so
-- freezeQueueRosterMessage (hybrid/rich queue_message_mode, at pop time) can null out message_id
-- in place instead of posting a fresh "Current Queue Members: 0" placeholder message just to keep
-- this row (the sole channel<->queue_type mapping /q, /l, and /status resolve against) populated.
-- See CLAUDE.md's "Queue channels" section.
alter table crl6mansqueuebot_queue_messages alter column message_id drop not null;
