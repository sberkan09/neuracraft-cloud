-- Allowance grants for partner end users (issue #21, option A). The partner's server grants an end
-- user credits after validating an in-app purchase; jobs of that end user draw on them. A ledger of
-- its own per (partner, end user), in millicredits like the account ledger: grant, reserve, release,
-- use. The partner still pays NeuraCraft from its account ledger for every job.
CREATE TABLE end_user_allowance (
    id           bigserial PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- the partner
    end_user     text NOT NULL,
    kind         text NOT NULL CHECK (kind IN ('grant', 'reserve', 'release', 'use')),
    amount       bigint NOT NULL,
    job_id       uuid REFERENCES jobs(id) ON DELETE SET NULL,
    reason       text,
    external_ref text,                                                  -- the store transaction, for grants
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX end_user_allowance_ref ON end_user_allowance(user_id, external_ref) WHERE kind = 'grant';
CREATE INDEX end_user_allowance_user ON end_user_allowance(user_id, end_user);
CREATE INDEX end_user_allowance_job ON end_user_allowance(job_id) WHERE job_id IS NOT NULL;

-- Jobs of end users draw on their allowance (no allowance: refused with allowance.insufficient).
ALTER TABLE partners ADD COLUMN allowance_required boolean NOT NULL DEFAULT false;
