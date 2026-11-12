-- A short reuse grace window for rotated refresh tokens (issue #52). When a refresh answer is lost
-- on the way to the app, the app presents the previous token again; within the window it gets the
-- same successor back instead of losing the sign-in. The successor's secret is kept encrypted on the
-- previous token only for that window (retention clears it).
ALTER TABLE end_user_tokens
    ADD COLUMN successor uuid,              -- a rotated refresh token: the refresh token issued in its place
    ADD COLUMN successor_secret bytea;      -- AES-256-GCM of that token's secret, during the grace window
