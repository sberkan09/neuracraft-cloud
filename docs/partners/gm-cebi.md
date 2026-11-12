# GM Cebi integration

How the GM Cebi app (Flutter) draws battle maps with NeuraCraft Cloud: the game master sketches the
terrain, the service turns it into a picture, and the app puts tokens on top. Everything here is the
public API; GM Cebi is a partner account (issue #21) whose end users sign in with an emailed code
(issue #48).

## Setup (operator)

```
node apps/api/dist/src/cli/partner-client.js --email gm-cebi@… --name "GM Cebi"     # prints nc_client_…
node apps/api/dist/src/cli/partner.js --email gm-cebi@… --daily-jobs 20 --partner-daily-jobs 300 \
    --timezone Europe/Istanbul
```

- The **client id** (`nc_client_…`) ships in the app. It is public and grants nothing on its own: the
  end user signs in with an emailed code (issue #48), and the app gets short-lived tokens for that end
  user. Its name ("GM Cebi") appears in the code email.
- `--daily-jobs` limits each signed-in end user; `--partner-daily-jobs` caps all of them together, so
  a burst of new accounts cannot drain the balance.
- Once a build with sign-in ships, `partner.js --require-end-user-tokens on` turns the old app token
  (`nc_app_…` with `X-End-User`) off; then revoke it. Until then both work.
- A token with `partner:manage` is for GM Cebi's own server, if it ever has one. It grants allowances,
  blocks and deletes end users. It never goes into the app.

## Sign-in

All four calls take JSON and no `Authorization` header.

1. `POST /v1/auth/email/start` `{client_id, email, locale: "tr"}` → `202 {expiresIn: 600, resendAfter: 60}`.
   - A 6-digit code goes to that address, valid for 10 minutes.
   - The answer is the same whether or not the address has signed in before.
   - At most one code a minute and 5 an hour per address, and a limit per IP:
     `429 auth.code_rate_limited` (`retryAfter` seconds).
2. `POST /v1/auth/email/verify` `{client_id, email, code}` → `200`:
   ```json
   {"accessToken": "nc_eu_…", "tokenType": "Bearer", "expiresIn": 3600, "refreshToken": "nc_rt_…", "endUser": {"id": "eu_…"}}
   ```
   - The end user is created on the first sign-in.
   - The same inbox is the same end user: letter case, a `+tag` and, for Gmail, dots don't matter.
   - Errors:
     - `400 auth.code_invalid` (`attemptsLeft`): wrong code;
     - `400 auth.code_expired`: expired, used, or 5 wrong attempts; ask for a new code.
3. `POST /v1/auth/token` `{client_id, grantType: "refresh_token", refreshToken}` → `200`, same shape.
   - Do this when a request answers `401 auth.token_expired` (the access token lasts an hour).
   - The refresh token changes every time: store the new one and drop the old one.
   - Refresh one at a time. If an answer is lost (a timeout, a dropped connection, the app killed
     before it stored the new token), send the same refresh token again within 60 seconds: the answer
     carries the same new refresh token, so nothing is lost. Later, or with an older token, a reused
     refresh token ends the sign-in (`401 auth.refresh_invalid`); it may have been stolen.
   - The refresh token lasts 90 days from its last use.
4. `POST /v1/auth/revoke` `{client_id, refreshToken}` → `204`: sign out.

Keep both tokens in the platform keystore (Keychain, Android Keystore). On `401 auth.refresh_invalid`
go back to the sign-in screen. Ask for sign-in only when the online feature is first used.

**The account** (with the access token):
- `GET /v1/me` → `{endUser: {id, createdAt}, quota: {daily, used, resetsAt}}`.
- `DELETE /v1/me` → `204`: deletes the end user, everything stored for them and all their tokens.
  This is the in-app account deletion Google Play and the App Store require, and the "delete my data"
  button.

## Every request

```
Authorization: Bearer nc_eu_…      the end user's access token
```

- Everything the app makes belongs to (GM Cebi, that end user). Another end user cannot see it.
- The rate limit is 240 requests per minute per end user.
- Errors are `{"error": {"code": "…", "params": {…}}}` with an HTTP status. Show a message per
  `code`; the list is under "Errors" below.
- Builds from before sign-in send `Authorization: Bearer nc_app_…` and `X-End-User: <install id>`
  instead. This keeps working until `--require-end-user-tokens on`.

## Flow

1. **A game (or a battle map screen) starts** → `POST /v1/sessions` (no body).
   - Answer: `{session: {id, heartbeatSeconds, expiresWithoutHeartbeatSeconds, endsAt, idleMinutes}, capacity}`.
   - `capacity` is one of:
     - `{state: "ready", gpu?}`;
     - `{state: "warming", etaSeconds, gpu?}`: a GPU is starting, and a sketch sent now waits for it.
       The estimate covers the warm-up: about 75 s, or about 120 s when the GPU is in a fallback data
       centre (`gpu.modelCache: false`), whose worker first downloads the models;
     - `{state: "unavailable", reason}`: no GPU now; offer to continue without the online feature.
   - Opening again while a session is open returns the same session (200 instead of 201).
2. **While the app is in the foreground** → `POST /v1/sessions/{id}/heartbeat` every
   `heartbeatSeconds` (120). The answer carries a fresh `capacity`.
   - Stop the heartbeats in the background.
   - `410 session.closed` (the session timed out, ran 8 hours, or was closed): open a new one.
3. **The game master sends a sketch** → `POST /v1/presets/sketch_to_scene/jobs`:
   ```json
   {
     "params": { "mode": "map", "narrative": "Nehrin üzerinde ahşap bir köprü, kuzeyde orman", "seed": 1234 },
     "inputs": { "sketch": { "inline": "<base64 PNG>", "contentType": "image/png" } }
   }
   ```
   - `mode`:
     - `map` keeps the layout (~3 s on a warm GPU);
     - `atmosphere` is prettier and freer (~5 s).
   - The text:
     - `narrative`: the scene in Turkish (or any language, ≤ 500 characters); the server writes the
       English prompt;
     - or `prompt`: English, ≤ 400 characters;
     - give one of the two, not both;
     - `negative` (≤ 300) is optional.
   - `seed`: optional; the same sketch, text and seed give the same picture.
   - The sketch:
     - a PNG of dark strokes on a light background, ≤ 512 KB, ≤ 1024 px a side;
     - it becomes 512 × 512, so draw on a square canvas;
     - it shows terrain only: rivers, roads, walls, forests, buildings;
     - creatures and tokens are drawn by the app on top of the result, never sent.
   - What reads well in `map` mode (docs/reports/sketch-to-scene.md, "Map mode seen from above"):
     - trees as small circles or blobs become tree canopies; a road as one line or two close lines
       keeps its course;
     - a river drawn as two thin lines may come out as water on one side only. Paint it with the
       water brush in `regions` (below); without regions, say it in the narrative ("iki kıyı
       arasında akan nehir");
     - corridors and small furniture (tables, chairs) are the weakest: they can merge into rooms or
       turn into other round shapes. A short narrative helps more than extra strokes.
   - **Regions** (optional, `map` mode, issue #42): where the water, roads and so on are.
     - `inputs.regions`: `{inline, contentType: "image/png"}`, the same size as the sketch,
       transparent where unpainted, ≤ 512 KB. Asset references are not accepted for it.
     - Paint with these brush colours; anti-aliased edges are fine:

       | Brush | Colour |
       |---|---|
       | water | `#2060A0` |
       | road / path | `#8C6E48` |
       | forest | `#285C28` |
       | stone floor | `#808080` |
       | wall | `#404040` |
       | sand | `#D2B478` |
     - `params.ground`: the unpainted ground, one of `grass` (default), `stone`, `dirt`, `sand`,
       `snow`.
     - The server turns the layer into a soft colour picture and starts the image from it, so
       painted water stays where it was painted. A layer with nothing painted, and `atmosphere`
       mode, run as without it.
     - Detecting support: `GET /v1/presets` lists `regions` under `sketch_to_scene`'s inputs, with
       `required: false`, and `ground` under its params.
   - Answer: `201 {job}`; the job has `id` and `state`.
4. **Wait for it**: `GET /v1/jobs/{id}/events` (server-sent events, with the same headers).
   - Each event is `data: <json>`:
     - `{type: "job", job}` comes first and last;
     - in between come `{type: "progress", progress: {step, steps, op, stage, fraction}}`,
       `{type: "state", state}` and `{type: "error", error}`.
   - Without SSE, poll `GET /v1/jobs/{id}` about once a second.
   - The job's states: queued, leased, running, then succeeded, failed or cancelled.
5. **Show it**: `job.outputs[0]` is `{name: "scene.png", assetId, bytes}`, a 512 × 512 PNG.
   - `job.gpu` (`{type, region}`) says which rented GPU ran it, as `capacity.gpu` does for a session
     (`{type, region, modelCache}`). Both are for logs and debugging; the app needs neither.
   - Get it with `GET /v1/assets/{assetId}/content`: a 302 to a signed URL, so follow the redirect.
   - Keep the picture in the app's own storage: the service deletes it after 7 days.
6. **Cancel** a job nobody waits for anymore: `POST /v1/jobs/{id}/cancel`.
7. **The game ends** → `DELETE /v1/sessions/{id}`. This lets the GPU go sooner, which matters for
   cost.

## Other endpoints

- `GET /v1/presets` lists the presets and their parameters. Check that `sketch_to_scene` is there
  with a version the app knows.
- **Report a picture**: `POST /v1/assets/{assetId}/report` with `{reason, note?}`. The picture is
  then hidden, from the reporter too (no download, not in the job's outputs), until a review
  finds nothing wrong with it.
  - `reason` is one of `sexual`, `violence_gore`, `hate`, `minor_safety`, `other`.
  - `note` is at most 500 characters.
- With the `partner:manage` token (GM Cebi's server only, no `X-End-User` header):
  - `GET /v1/partner/end-users/{id}/usage`;
  - `DELETE /v1/partner/end-users/{id}` deletes that end user's data;
  - `POST /v1/partner/end-users/{id}/allowance` grants credits, when the account requires
    allowances;
  - `POST /v1/partner/end-users/{id}/block` blocks a signed-in end user (their tokens stop at once,
    and no new code is sent); `DELETE …/block` unblocks.
  - Without a server, the operator blocks: `partner.js --email … --block eu_…`.

## Errors

| Status | `code` | What the app does |
|---|---|---|
| 400 | `preset.params_invalid` (`field`, `reason`) | a bug in the request: fix it; log the field |
| 400 | `content.text_refused` (`field`) | the text was refused: ask for a different description |
| 400 | `partner.end_user_required` | missing or malformed `X-End-User` (a bug) |
| 400 | `auth.client_invalid` | the client id is wrong or disabled (a bug, or the app is switched off) |
| 400 | `auth.invalid_email` | ask for the address again |
| 400 | `auth.code_invalid` (`attemptsLeft`), `auth.code_expired` | wrong or expired code (see "Sign-in") |
| 401 | `auth.token_expired` | refresh the access token, then repeat the request |
| 401 | `auth.refresh_invalid` | sign in again |
| 401 | `auth.token_revoked` | signed out elsewhere, or the token was revoked: sign in again |
| 401 | `auth.end_user_token_required` | an old build with the app token, after the switch: update the app |
| 401 | `auth.required` | a bug: the token is missing or malformed |
| 403 | `auth.end_user_blocked` | this end user was blocked: the online feature is off for them |
| 429 | `auth.code_rate_limited` (`retryAfter`) | too many codes: wait |
| 503 | `auth.sign_in_unavailable` | sign-in is down (email): try later |
| 402 | `allowance.insufficient` (`needed`, `balance`) | out of credits for this user |
| 402 | `credits.insufficient` | GM Cebi's account is out of credits: "temporarily unavailable" |
| 404 | `not_found` | the job or picture is gone (or deleted after 7 days) |
| 410 | `session.closed` (`reason`) | open a new session |
| 429 | `quota.end_user_daily` (`limit`, `resetsAt`) | today's maps are used up: show when they reset |
| 429 | `quota.partner_daily` (`resetsAt`) | GM Cebi's maps for today are used up across all users: try tomorrow |
| 429 | `session.limit` (`max`) | too many games at once across GM Cebi: try again later |
| 429 | `limit.concurrent_jobs`, `rate_limited` | wait a few seconds and retry |
| 503 | `job.no_gpu_worker` | no GPU and none starting: retry later, or continue offline |
| 503 | `preset.unavailable` | the service is being set up: retry later |

A job can also end `failed` with `job.error.code`:

- `content.flagged`: the picture failed the content check and is not shown; nothing is charged.
  Ask the game master to try another sketch or description.
- `content.unchecked`: the check could not run; nothing is charged. Retry.
- Anything else: a service error. Retry once, then give up quietly.

## Privacy (for the store declarations)

[docs/PRIVACY.md](../PRIVACY.md) has the details:

- **What is kept**:
  - the sketch (and the colour hint made from the region layer) for 24 hours. During the closed beta
    the operator keeps them for 7 days to look at testers' results; this goes back to 24 hours before
    a public release, so declare 24 hours;
  - the result for 7 days;
  - the narrative or prompt until 24 hours after the job finishes.
- **What is collected for sign-in**: the email address is used only to send the code, through Brevo
  (EU). NeuraCraft stores an HMAC of it, never the address, plus a random end-user id (`eu_…`) and
  sign-up and last-seen times. No name, no store account.
- **Where**: interactive jobs run on EU GPUs (`INTERACTIVE_REGIONS=eu`).
- **Sub-processors**:
  - with `ANTHROPIC_API_KEY` set, the narrative text (without any id) goes to Anthropic (US) to write
    the English prompt. Without it, a built-in template writes the prompt and the narrative stays in
    the service;
  - Brevo (EU) sends the code emails: the address, the code and "GM Cebi".
- **Deleting**: "Delete my account" in the app calls `DELETE /v1/me`. It deletes the end user and
  everything stored for them at once; no GM Cebi server is needed.

## Design notes

- The feature is optional. The app works offline and the battle map works without it (a plain grid
  or the bare sketch). The online picture is a bonus.
- Open the session early, when the game starts, not when the sketch is sent: the GPU then has
  minutes to start. A rented GPU is ready ~15 s after it is rented and warms up its models for
  another ~25 s, which is enough when the session opens as the game starts.
