-- Partner apps and their end users (issue #21). An end user is an opaque id the partner chooses (an
-- install id); NeuraCraft never sees their email or store account. Ownership is (account, end user):
-- through an app token, an end user sees only their own jobs and assets.
ALTER TABLE assets ADD COLUMN end_user text;
ALTER TABLE jobs ADD COLUMN end_user text;
CREATE INDEX assets_end_user ON assets(owner_id, end_user) WHERE end_user IS NOT NULL;
CREATE INDEX jobs_end_user ON jobs(user_id, end_user, created_at DESC) WHERE end_user IS NOT NULL;

-- Per-partner settings (cli/partner.js). end_user_daily_jobs: jobs an end user may start per calendar
-- day in quota_timezone (null: no quota).
CREATE TABLE partners (
    user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    end_user_daily_jobs int CHECK (end_user_daily_jobs IS NULL OR end_user_daily_jobs >= 0),
    quota_timezone      text NOT NULL DEFAULT 'Europe/Istanbul',
    updated_at          timestamptz NOT NULL DEFAULT now()
);
