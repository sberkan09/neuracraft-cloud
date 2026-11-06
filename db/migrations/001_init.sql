-- Accounts, sessions, files, jobs, workers and the credit ledger (docs/ARCHITECTURE.md).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text NOT NULL UNIQUE,            -- lower-cased
    password_hash text,                            -- scrypt$N$r$p$salt$hash; null for OAuth-only accounts
    locale        text NOT NULL DEFAULT 'en',
    plan          text NOT NULL DEFAULT 'free',
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    id_hash    bytea PRIMARY KEY,                  -- sha256 of the cookie value
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Stored bytes, content-addressed. Never reached directly by users: only through assets.
CREATE TABLE blobs (
    sha256     text PRIMARY KEY,
    bytes      bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- What a user owns: an upload, a job's output, or a catalog model (owner null).
-- kind: input (a picture), output, model. A model folder is a bundle: its files in asset_files.
CREATE TABLE assets (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id     uuid REFERENCES users(id) ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN ('input', 'output', 'model')),
    model_kind   text,                             -- the engine's model kinds: sd, sdxl, onnx, esrgan, ...
    name         text NOT NULL,
    content_type text NOT NULL DEFAULT 'application/octet-stream',
    sha256       text REFERENCES blobs(sha256),    -- null for a bundle or while uploading
    bytes        bigint NOT NULL DEFAULT 0,
    license      text,                             -- declared by the uploader / recorded for the catalog
    status       text NOT NULL DEFAULT 'ready' CHECK (status IN ('uploading', 'ready', 'held', 'removed')),
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assets_owner ON assets(owner_id, created_at DESC);

CREATE TABLE asset_files (
    asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    path     text NOT NULL,                        -- inside the bundle folder, no ".."
    sha256   text NOT NULL REFERENCES blobs(sha256),
    bytes    bigint NOT NULL,
    PRIMARY KEY (asset_id, path)
);

CREATE TABLE workers (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    class        text NOT NULL CHECK (class IN ('cpu', 'gpu')),
    capabilities jsonb NOT NULL,
    loaded       text[] NOT NULL DEFAULT '{}',     -- model asset ids in memory
    registered_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state          text NOT NULL DEFAULT 'queued'
                   CHECK (state IN ('queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled')),
    worker_class   text NOT NULL DEFAULT 'cpu',
    priority       int NOT NULL DEFAULT 0,
    workflow       jsonb NOT NULL,
    limits         jsonb NOT NULL,
    models         uuid[] NOT NULL DEFAULT '{}',   -- model assets it needs (claim prefers workers holding them)
    files          uuid[] NOT NULL DEFAULT '{}',   -- every asset it reads
    worker_id      uuid REFERENCES workers(id) ON DELETE SET NULL,
    lease_until    timestamptz,
    attempts       int NOT NULL DEFAULT 0,
    cancel         boolean NOT NULL DEFAULT false,
    progress       jsonb,
    error          jsonb,
    worker_seconds double precision,
    created_at     timestamptz NOT NULL DEFAULT now(),
    started_at     timestamptz,
    finished_at    timestamptz
);
CREATE INDEX jobs_queue ON jobs(worker_class, priority DESC, created_at) WHERE state = 'queued';
CREATE INDEX jobs_user ON jobs(user_id, created_at DESC);
CREATE INDEX jobs_lease ON jobs(lease_until) WHERE state IN ('leased', 'running');

CREATE TABLE job_outputs (
    job_id   uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    name     text NOT NULL,
    asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    PRIMARY KEY (job_id, name)
);

-- Append-only credit ledger (millicredits). Balance = sum(amount).
CREATE TABLE ledger (
    id         bigserial PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       text NOT NULL CHECK (kind IN ('grant', 'purchase', 'reserve', 'settle', 'release', 'refund')),
    amount     bigint NOT NULL,
    job_id     uuid REFERENCES jobs(id) ON DELETE SET NULL,
    reference  text,                               -- payment provider id, ...
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_user ON ledger(user_id);
