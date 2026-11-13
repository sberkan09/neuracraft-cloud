-- The operator console (/admin): who is an operator, and which accounts let operators see their
-- content. NeuraCraft Cloud serves many accounts (GM Cebi is one partner); operators see every
-- account's metadata (jobs, timings, costs, capacity), but pictures and texts only of an account that
-- granted support access (until a date), or under an open report. Every content view is logged.
ALTER TABLE users
    ADD COLUMN operator boolean NOT NULL DEFAULT false,
    ADD COLUMN support_access_until timestamptz,      -- the account lets operators see its content until then
    ADD COLUMN support_access_note text;              -- why ("GM Cebi closed beta, testers agreed")

ALTER TABLE moderation_log DROP CONSTRAINT moderation_log_action_check;
ALTER TABLE moderation_log ADD CONSTRAINT moderation_log_action_check
    CHECK (action IN ('dismiss', 'remove_asset', 'flag_account', 'view_content', 'support_access', 'block_end_user', 'unblock_end_user'));
ALTER TABLE moderation_log ADD COLUMN job_id uuid;
CREATE INDEX moderation_log_views ON moderation_log(job_id, at) WHERE action = 'view_content';
