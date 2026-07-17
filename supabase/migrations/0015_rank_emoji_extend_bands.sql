-- Extend rank emoji to support Prism (Top 10) and Unranked
alter table crl6mansqueuebot_rank_emoji drop constraint crl6mansqueuebot_rank_emoji_band_check;
alter table crl6mansqueuebot_rank_emoji add constraint crl6mansqueuebot_rank_emoji_band_check check (band in ('Iron', 'Garnet', 'Emerald', 'Sapphire', 'Prism', 'Unranked'));
