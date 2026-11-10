-- End-user sign-in for partner apps without a server (issue #48, phase 1). The app ships a public
-- client id; the end user signs in with an emailed code and gets short-lived access tokens plus a
-- rotating refresh token, bound to (partner, end user, client). No plaintext email is stored: only
-- an HMAC of the normalized address, per partner.

-- A partner app's public id (nc_client_...). It grants nothing on its own.
CREATE TABLE partner_clients (
    id         text PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- the partner
    name       text NOT NULL,                                          -- shown in the code email ("GM Cebi")
    scopes     text[] NOT NULL DEFAULT '{jobs:submit,jobs:read,assets:read}',
    enabled    boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partner_clients_user ON partner_clients(user_id);

-- A verified end user of one partner. end_user (eu_...) is what jobs, assets, allowances and
-- sessions already record in their end_user column.
CREATE TABLE partner_end_users (
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    end_user     text NOT NULL,
    identity_key bytea NOT NULL,              -- HMAC-SHA256(server key, normalized email)
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    blocked_at   timestamptz,
    PRIMARY KEY (user_id, end_user),
    UNIQUE (user_id, identity_key)
);

-- Emailed codes: 10 minutes, at most 5 attempts. Only a hash of the code is kept.
CREATE TABLE sign_in_codes (
    id           bigserial PRIMARY KEY,
    client_id    text NOT NULL REFERENCES partner_clients(id) ON DELETE CASCADE,
    identity_key bytea NOT NULL,
    code_hash    bytea NOT NULL,
    attempts     int NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    used_at      timestamptz
);
CREATE INDEX sign_in_codes_identity ON sign_in_codes(identity_key, created_at DESC);

-- Access tokens (nc_eu_...) and refresh tokens (nc_rt_...). A sign-in starts a family; every refresh
-- rotates the refresh token within it. Presenting a rotated refresh token again revokes the family.
CREATE TABLE end_user_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL,
    end_user    text NOT NULL,
    client_id   text NOT NULL REFERENCES partner_clients(id) ON DELETE CASCADE,
    kind        text NOT NULL CHECK (kind IN ('access', 'refresh')),
    family      uuid NOT NULL,
    secret_hash bytea NOT NULL UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,                  -- a refresh token: when it was rotated
    revoked_at  timestamptz,
    FOREIGN KEY (user_id, end_user) REFERENCES partner_end_users(user_id, end_user) ON DELETE CASCADE
);
CREATE INDEX end_user_tokens_family ON end_user_tokens(family);
CREATE INDEX end_user_tokens_end_user ON end_user_tokens(user_id, end_user);

-- partner_daily_jobs: a ceiling across all of a partner's end users per day (quota_timezone), so a
-- burst of new identities cannot drain the balance. require_end_user_tokens: the partner's app tokens
-- no longer act for end users (X-End-User); only signed-in end users' tokens do.
ALTER TABLE partners
    ADD COLUMN partner_daily_jobs int CHECK (partner_daily_jobs IS NULL OR partner_daily_jobs >= 0),
    ADD COLUMN require_end_user_tokens boolean NOT NULL DEFAULT false;
