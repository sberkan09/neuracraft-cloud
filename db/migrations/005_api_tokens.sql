-- Bearer tokens for native clients and scripts (issue #16): personal access tokens (nc_pat_...) made
-- by a user, app tokens (nc_app_...) issued to a registered client application. Only a hash of the
-- secret is stored; `prefix` (the first characters) helps a user tell tokens apart.
CREATE TABLE api_tokens (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN ('pat', 'app')),
    name         text NOT NULL,
    prefix       text NOT NULL,
    secret_hash  bytea NOT NULL UNIQUE,
    scopes       text[] NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    expires_at   timestamptz,
    revoked_at   timestamptz
);
CREATE INDEX api_tokens_user ON api_tokens(user_id, created_at DESC);
