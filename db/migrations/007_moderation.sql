-- Moderation (issue #18): the output classifier's verdict on preset jobs, abuse reports on generated
-- pictures, and what operators did about them.

-- The classifier's scores for a preset job's outputs ({checked, flagged, scores, model}).
ALTER TABLE jobs ADD COLUMN moderation jsonb;
-- A user reported this output (it stays visible to them until an operator acts).
ALTER TABLE assets ADD COLUMN reported_at timestamptz;
-- An operator flagged the account for attention (no automatic effect: bans are out of scope).
ALTER TABLE users ADD COLUMN flagged_at timestamptz;
ALTER TABLE users ADD COLUMN flag_note text;

-- One row per report: a user's (once per asset and reporter) or the classifier's (a held output).
-- snapshot keeps what the review needs even after the job's inputs are cleaned up: the preset, the
-- prompt and how it came about, the input asset ids and the classifier's scores.
CREATE TABLE reports (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id        uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    job_id          uuid REFERENCES jobs(id) ON DELETE SET NULL,
    owner_id        uuid REFERENCES users(id) ON DELETE CASCADE,     -- the asset's owner
    reporter_id     uuid REFERENCES users(id) ON DELETE SET NULL,    -- null for the classifier
    source          text NOT NULL CHECK (source IN ('user', 'classifier')),
    reason          text NOT NULL CHECK (reason IN ('sexual', 'violence_gore', 'hate', 'minor_safety', 'other', 'classifier')),
    note            text,
    snapshot        jsonb NOT NULL,
    status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'removed')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    resolved_at     timestamptz,
    resolved_by     text
);
CREATE UNIQUE INDEX reports_once ON reports(asset_id, reporter_id) WHERE reporter_id IS NOT NULL;
CREATE INDEX reports_open ON reports(created_at) WHERE status = 'open';

-- Every operator action, kept when the asset or account is gone (no foreign keys on the ids).
CREATE TABLE moderation_log (
    id         bigserial PRIMARY KEY,
    at         timestamptz NOT NULL DEFAULT now(),
    operator   text NOT NULL,
    action     text NOT NULL CHECK (action IN ('dismiss', 'remove_asset', 'flag_account')),
    report_id  uuid,
    asset_id   uuid,
    user_id    uuid,
    note       text
);
