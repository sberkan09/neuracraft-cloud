-- Sessions and on-demand GPU capacity.
--
-- A session is an app's signal that interactive work may come soon: GM Cebi opens one when a game
-- master starts a game, keeps it alive with heartbeats and closes it at the end. While sessions are
-- open, the capacity manager keeps enough GPU workers warm (capacity.ts); when the last one has been
-- gone for a while, it stops them.
CREATE TABLE app_sessions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    end_user      text,
    regions       text[] NOT NULL DEFAULT '{}',   -- where its interactive jobs may run
    started_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),   -- the last heartbeat
    last_job_at   timestamptz,                          -- the last interactive job it started
    ends_at       timestamptz NOT NULL,                 -- the longest it may stay open
    closed_at     timestamptz,
    close_reason  text CHECK (close_reason IN ('closed', 'expired', 'limit', 'deleted'))
);
CREATE INDEX app_sessions_open ON app_sessions(user_id, end_user) WHERE closed_at IS NULL;
CREATE INDEX app_sessions_open_all ON app_sessions(last_seen_at) WHERE closed_at IS NULL;

ALTER TABLE jobs ADD COLUMN session_id uuid REFERENCES app_sessions(id) ON DELETE SET NULL;
-- Open sessions a partner's end users may hold at once (null: the service default).
ALTER TABLE partners ADD COLUMN max_sessions int CHECK (max_sessions IS NULL OR max_sessions >= 0);

-- GPU pods the capacity manager rented. A pod's worker registers with WORKER_POD_ID = id.
CREATE TABLE gpu_pods (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider        text NOT NULL,
    provider_id     text UNIQUE,
    gpu_type        text,
    region          text,
    price_per_hour  numeric(10, 4),
    state           text NOT NULL CHECK (state IN ('requested', 'starting', 'running', 'draining', 'stopped', 'failed')),
    worker_id       uuid REFERENCES workers(id) ON DELETE SET NULL,
    requested_at    timestamptz NOT NULL DEFAULT now(),
    ready_at        timestamptz,
    drain_at        timestamptz,
    stopped_at      timestamptz,
    error           text
);
CREATE INDEX gpu_pods_live ON gpu_pods(state) WHERE state IN ('requested', 'starting', 'running', 'draining');

-- A worker told to finish its job and take no more (the capacity manager stops its pod after).
ALTER TABLE workers ADD COLUMN draining boolean NOT NULL DEFAULT false;
