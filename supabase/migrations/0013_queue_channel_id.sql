-- Rename text_channel_id -> queue_channel_id on crl6mansqueuebot_series. Per-match text
-- channels were removed from the architecture (only two voice channels are created per
-- series now — see CLAUDE.md, "Match channels"), but several code paths (sub.ts, abandon.ts,
-- teamFormation.ts's captains-draft continuation, adminTools.ts, testMatch.ts, the sweep
-- route) still resolve a series from, or post follow-up messages to, "the match's channel".
-- That channel is actually the queue channel the series popped from (rank or universal —
-- each tracked independently via crl6mansqueuebot_queue_messages), not a per-match text
-- channel, so this migration renames the column to reflect what it actually holds. queue.ts's
-- handlePop now populates it at series creation with the queueChannelId the pop happened in.
alter table crl6mansqueuebot_series rename column text_channel_id to queue_channel_id;
