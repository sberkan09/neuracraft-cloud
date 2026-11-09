# GM Cebi integration

How the GM Cebi app (Flutter) draws battle maps with NeuraCraft Cloud: the game master sketches the
terrain, the service turns it into a picture, and the app puts tokens on top. Everything here is the
public API; GM Cebi is a partner account (issue #21).

## Setup (operator)

```
node apps/api/dist/src/cli/create-token.js --email gm-cebi@… --kind app --name "GM Cebi app" \
    --scopes jobs:submit,jobs:read,assets:read
node apps/api/dist/src/cli/partner.js --email gm-cebi@… --daily-jobs 20 --timezone Europe/Istanbul
```

- The **app token** (`nc_app_…`) ships in the app. It can only act for one end user at a time.
- A second token with `partner:manage` is for GM Cebi's own server, if it ever has one. It grants
  allowances and deletes end users' data. It never goes into the app.

## Every request

```
Authorization: Bearer nc_app_…
X-End-User: <install id>        1-64 of A-Z a-z 0-9 . _ : @ -   (a random id made at install time)
```

- Everything the app makes belongs to (GM Cebi, that end user). Another install cannot see it.
- The rate limit is 240 requests per minute per end user.
- Errors are `{"error": {"code": "…", "params": {…}}}` with an HTTP status. Show a message per
  `code`; the list is under "Errors" below.

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
    allowances.

## Errors

| Status | `code` | What the app does |
|---|---|---|
| 400 | `preset.params_invalid` (`field`, `reason`) | a bug in the request: fix it; log the field |
| 400 | `content.text_refused` (`field`) | the text was refused: ask for a different description |
| 400 | `partner.end_user_required` | missing or malformed `X-End-User` (a bug) |
| 401 | `auth.required`, `auth.token_revoked`, `auth.token_expired` | the online feature is off until an app update |
| 402 | `allowance.insufficient` (`needed`, `balance`) | out of credits for this user |
| 402 | `credits.insufficient` | GM Cebi's account is out of credits: "temporarily unavailable" |
| 404 | `not_found` | the job or picture is gone (or deleted after 7 days) |
| 410 | `session.closed` (`reason`) | open a new session |
| 429 | `quota.end_user_daily` (`limit`, `resetsAt`) | today's maps are used up: show when they reset |
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
  - the sketch for 24 hours;
  - the result for 7 days;
  - the narrative or prompt until 24 hours after the job finishes.
- **What is not collected**: no account, name or email. The install id is the only identifier.
- **Where**: interactive jobs run on EU GPUs (`INTERACTIVE_REGIONS=eu`).
- **Sub-processor**: with `ANTHROPIC_API_KEY` set, the narrative text (without any id) goes to
  Anthropic (US) to write the English prompt. Without it, a built-in template writes the prompt and
  the narrative stays in the service.
- **Deleting**: "Delete my data" means `DELETE /v1/partner/end-users/{id}` from GM Cebi's server. If
  there is no server, the app should not keep any result it doesn't need, and it should say that
  everything expires after 7 days.

## Design notes

- The feature is optional. The app works offline and the battle map works without it (a plain grid
  or the bare sketch). The online picture is a bonus.
- Open the session early, when the game starts, not when the sketch is sent: the GPU then has
  minutes to start. A rented GPU is ready ~15 s after it is rented and warms up its models for
  another ~25 s, which is enough when the session opens as the game starts.
