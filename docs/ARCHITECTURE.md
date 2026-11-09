# NeuraCraft Cloud — architecture

NeuraCraft Cloud runs NeuraCraft workflows (image, video and ONNX pipelines) for many people at
once, on a pool of CPU and GPU machines that grows and shrinks with demand. It is a paid product for
everyone. This document records the decisions taken so far and why; change it when a decision
changes.

## Decisions

| topic | decision | why |
|---|---|---|
| repositories | `neuracraft` (the engine, Apache-2.0) and `neuracraft-cloud` (this service, private once launched) | different release cycles; the service carries deployment, billing and secrets the engine must not |
| engine dependency | the worker builds NeuraCraft at a pinned tag (CMake FetchContent) | an engine change reaches the service only by a deliberate version bump |
| first hardware | CPU workers; GPU workers on Runpod once the engine has a CUDA backend | the engine's GPU backend is Metal only today |
| web + API language | TypeScript (Node 22): Fastify API, React (Vite) web | the Studio UI is TypeScript already; workflow and API types are shared; mature payment / auth libraries |
| worker | C++, linking the engine | runs `runWorkflow` in-process, keeps models warm |
| database / queue | PostgreSQL only (jobs claimed with `FOR UPDATE SKIP LOCKED`, progress with `LISTEN/NOTIFY`) | one stateful component to run and back up; Redis only when measurements ask for it |
| files | S3 API: Cloudflare R2 in production (no egress fees), MinIO in development, a local folder in tests | pictures and videos are the product; serving them must stay cheap |
| hosting | control plane on a small VM (Hetzner) with Docker Compose + Caddy; managed Postgres; workers anywhere | no Kubernetes until the team or the load needs it |
| payments | a merchant of record (Paddle, Lemon Squeezy or Dodo — chosen at sign-up) | Stripe does not serve Turkish companies directly; a MoR also files VAT worldwide |
| languages | English and Turkish first; every string behind a key; the API returns codes, not sentences | more languages are a translation file each |
| product name | NeuraCraft Cloud (for now) | |

## Components

```
 Browser ── web (React) ──HTTPS──▶ API (Fastify, stateless, N copies)
                                    │  sessions · validation · quotas · jobs · signed URLs · SSE
                                    ├────────▶ PostgreSQL  users · assets · jobs · events · workers · ledger
                                    ├────────▶ Object storage (R2 / MinIO)  inputs · outputs · models
                                    │
                  worker protocol (HTTPS, worker token; workers dial out)
                                    │
        ┌───────────────────────────┼────────────────────────────┐
   CPU workers (Hetzner)     GPU workers (Runpod, later)     a developer's Mac (Metal)
   NeuraCraft runWorkflow    NeuraCraft runWorkflow          NeuraCraft runWorkflow
```

* **API** — the only component with database or storage credentials. Validates workflows against
  the engine's schema (`workflowSchemaJson`, exported at build time into `packages/shared`),
  enforces quotas, creates jobs, hands out signed URLs, streams progress to browsers (SSE). It also
  runs the scheduler loop (lease expiry, retries) under a Postgres advisory lock, so exactly one copy
  does it.
* **Workers** — dial out to the API with a worker token; they never see database credentials or
  other users' data. They claim a job, download the files it names (cached on local disk by content
  hash), rewrite the workflow's asset ids into local paths (`mapWorkflowFiles`), run it inside
  `WorkflowLimits` (files only in the job's folders, bounded size and time), upload the outputs to
  signed URLs and report progress. A worker runs one job at a time per device and keeps recently
  used models loaded.
* **GPU workers** — the same worker built with the engine's CUDA backend
  (`deploy/worker-gpu.Dockerfile`, `WORKER_CLASS=gpu`). Jobs with diffusion steps (txt2img, img2img,
  inpaint, t2v, morph, zoom, outpaint, upscale, interpolate) are GPU jobs; a GPU worker takes them
  first and CPU jobs when there are none, and CPU workers take GPU jobs only while no GPU worker has
  been seen for a minute (slow, but nothing waits forever). GPU time is billed at the GPU rate.
* **Interactive jobs** (issue #20) — presets used at the table (`latency: "interactive"`, such as
  `sketch_to_scene`) are claimed before batch jobs of the same priority and never by a CPU worker.
  When no GPU worker (in `INTERACTIVE_REGIONS`, if set) has been seen for `INTERACTIVE_GRACE_SECONDS`
  (60), they are refused at submission with `job.no_gpu_worker` instead of waiting. A worker counts
  as seen while it claims work or heartbeats a running job. `INTERACTIVE_ON_CPU=1`, for development
  and the e2e test only, lets CPU workers take them. The compose stack sets it; production must not. A worker started with
  `INTERACTIVE_ONLY=1` takes nothing else, so it keeps the preset's models loaded and never sits
  behind a long batch job.
  - **Timings**: each job records where its time went (`jobs.timings`). The server measures queue wait
    and the total from submission to finish. The worker reports fetching files, loading models (the
    engine's `modelLoadSeconds()`), running and uploading, and the claim notes whether the worker
    already held the job's models (`warm`).
  - **Operators**: `cli/latency.js` prints p50 / p95 per preset and mode.
  - **Warm capacity**: warm GPU workers kept for interactive jobs (`INTERACTIVE_ONLY=1`,
    `KEEP_MODELS=8`) while apps have sessions open (below), rather than always on or scaled to zero.
    Measured on an RTX 4090 ([docs/reports/sketch-to-scene.md](reports/sketch-to-scene.md)):
    - warm: about 2.5 s for a map-mode picture; 50 jobs while a batch job shared the GPU: p50 3.8 s,
      p95 6.3 s;
    - cold: 35 s (downloading 3.3 GB of models, then loading them).

    Cheap 16–24 GB cards are enough. Two worker processes on one GPU each need
    `NEURACRAFT_CUDA_WEIGHTS_GB`.
* **3D GPU workers** — a GPU worker with the engine's services beside it
  (`deploy/worker-gpu3d.Dockerfile`, on 127.0.0.1): the 3D service (TRELLIS.2, `NEURACRAFT_3D_URL`)
  and the rigging service (SkinTokens, `NEURACRAFT_RIG_URL`). Once a service has loaded its model the
  worker registers with its feature (`features: ["3d", "rig"]`). Jobs record the services their steps
  need (`jobs.features`: `image_to_3d` → 3d, `rig` → rig); only workers reporting all of them take
  such a job, before their other work, and never a CPU worker. A job is refused at submission
  (`job.no_3d_worker`) when no worker with its services has been seen for ten minutes. Billed at the
  GPU rate.
* **Warm models** — a worker keeps the models of its last jobs loaded (`KEEP_MODELS`, default 2),
  their weights resident in GPU memory, and reports them when it asks for work; the scheduler then
  prefers jobs that need those models.
* **Sessions and on-demand GPUs** (`apps/api/src/capacity.ts`, `routes/sessions.ts`) — an app opens a
  session when interactive work may come soon. GM Cebi opens one when a game master starts a game:
  the first sketch usually comes minutes later, enough for a pod to start.
  - **API** (scope `jobs:submit`; partner apps send `X-End-User`):
    - `POST /v1/sessions` opens a session, or returns the one already open for this user / end user
      (200).
    - `POST /v1/sessions/:id/heartbeat` keeps it open; send one every `heartbeatSeconds` (120).
    - `DELETE /v1/sessions/:id` closes it.
    - Every answer carries `capacity`: `ready`, `warming` with `etaSeconds`, or `unavailable` with a
      reason.
  - **Rules**:
    - A session without a heartbeat for `SESSION_EXPIRE_SECONDS` (600) is closed, and so is one past
      `SESSION_MAX_HOURS` (8). A closed session answers `session.closed` (410).
    - A session stops asking for capacity after `SESSION_IDLE_MINUTES` (45) without an interactive
      job.
    - One session per user / end user. A partner may hold `partners.max_sessions` open at once
      (default `SESSION_MAX_PER_ACCOUNT`, 50); past that: `session.limit` (429).
    - Interactive jobs record their session and keep it asking.
  - **Capacity manager** (every `CAPACITY_EVERY_SECONDS`, one replica at a time):
    - **How many pods**: none without demand; otherwise one per `CAPACITY_SESSIONS_PER_WORKER` (20)
      asking sessions, at least one, plus one when interactive jobs wait, up to `CAPACITY_MAX_PODS`.
    - **Renting**: pods are rented through the provider (Runpod REST API v2: `RUNPOD_GPU_TYPES`
      tried in order, `RUNPOD_DATA_CENTERS`, the worker image `RUNPOD_IMAGE`). Pod workers register
      with `WORKER_POD_ID` and the settings in `RUNPOD_WORKER_ENV` (`INTERACTIVE_ONLY=1`,
      `KEEP_MODELS=8`, `WARMUP=1`). With `RUNPOD_NETWORK_VOLUME_ID`, their model cache lives on a shared network
      volume, so a new pod does not download the models again.
    - **Giving back**: after the last demand, pods stay `CAPACITY_GRACE_MINUTES` (15). Then they drain:
      the worker takes no more jobs and is told to stop, and the pod is deleted once it is idle.
    - **Replacing**: a pod whose worker has not registered within `CAPACITY_START_TIMEOUT_SECONDS`
      (600), whose worker stopped answering, or that ran `CAPACITY_MAX_POD_HOURS` (12) is replaced.
    - **Clean-up**: pods the provider has under the `nc-gpu-` prefix that this service does not know
      of are deleted.
    - **Budget**: no new pods once today's pods have cost `CAPACITY_DAILY_BUDGET_USD`; sessions then
      answer `unavailable`.
  - **Warm-up** (`apps/api/src/warmup.ts`, `WARMUP=1` in `RUNPOD_WORKER_ENV`): a new pod's worker
    first runs each interactive preset once on a blank sketch, for itself (`POST /v1/worker/warmup`;
    no lease, nothing stored or charged). It counts as ready only from its first claim, so sessions
    say `warming` until the models are loaded.
  - **While a pod starts**: interactive jobs are accepted and wait for it, instead of
    `job.no_gpu_worker`.
  - **Measured** (RTX 4090, Runpod EU-RO-1, models on a network volume;
    [docs/reports/session-cold-start.md](reports/session-cold-start.md)): from renting a pod to its
    worker registering, 15 s when the host has the image; loading the models from the volume, 25 s.
    Without the warm-up, a game's first picture takes ~30 s; with it ~3 s, if the first sketch comes
    at least ~45 s after the session opens.
  - **Without `CAPACITY_PROVIDER`**: sessions still work, but GPU workers are started by hand.
  - How GM Cebi uses sessions and the sketch_to_scene preset: [docs/partners/gm-cebi.md](partners/gm-cebi.md).
  Workers are cattle: any can die at any moment.

## Jobs

```
queued ──claim──▶ leased ──first event──▶ running ──▶ succeeded
   ▲                 │                       │    └──▶ failed
   └── lease expired (attempt < 3) ──────────┘    └──▶ cancelled
```

* A job is one workflow (the engine's JSON) plus the limits of the user's plan.
* **Claiming**: a worker asks for work naming its class (cpu / gpu, features such as 3d, memory, engine version) and the
  models it has loaded. The scheduler picks, among jobs the worker can run:
  1. higher plan priority first;
  2. users with fewer running jobs first (fairness: nobody fills the pool alone);
  3. jobs whose models the worker already holds (no reload: seconds saved per job);
  4. oldest first.
* **Leases**: a claimed job carries a lease renewed by the worker's heartbeats (every few seconds,
  with its progress). An expired lease puts the job back in the queue (at most 3 attempts) — a
  machine that vanished costs a retry, never a lost job.
* **Cancellation**: the heartbeat answer says "cancel"; the worker's `WorkflowEvents::cancelled`
  returns true and the engine stops between denoising steps or frames.
* **Results** are assets owned by the job's user: pictures and clips, and 3D models (`.glb` is shown in
  a 3D viewer in the browser; `.obj` comes with its `.mtl` and texture, `.ply` with vertex colours).
* **Presets** (`apps/api/src/presets.ts`): native clients do not build workflows. They name a preset and
  its parameters, and the server builds the workflow, so settings are tuned once for every client and
  an app in the stores cannot be broken by a model or field change. `GET /v1/presets` lists them with
  their parameter schemas and versions. `POST /v1/presets/:id/jobs` takes `{params, inputs, version?}`:
  - Inputs are an `asset:<id>`, or an inline PNG (base64, up to 512 KB and 1024 x 1024) stored as the
    caller's asset in the same transaction. That is one round trip instead of three.
  - A preset's `maxSeconds` sizes the reservation and the time limit, not the plan's maximum: a 1 s job
    no longer needs 300 s of credits.
  - Parameters of older versions are mapped (`upgrade`) for at least one version.
  - Models are catalog slugs; the job records the preset and its version.

  `sketch_to_scene` v1 turns a terrain sketch plus an English prompt into a 512 x 512 scene (scribble
  ControlNet on DreamShaper 8). `map` uses 4 LCM steps and keeps the layout (30 s reserved);
  `atmosphere` uses 20 steps and is freer (60 s).

  Instead of `prompt`, a client can send a `narrative` in any language (`apps/api/src/prompts.ts`):
  - **Writing the prompt**: Claude (`ANTHROPIC_API_KEY`, `PROMPT_MODEL`; only the API holds the key)
    writes an English prompt about the terrain and setting only, since creatures are tokens the app
    draws. The prompt carries the mode's style words, stays under 60 words and comes with a negative
    prompt. Instructions are versioned (`sketch_to_scene/1`).
  - **Cleaning**: phrases naming creatures are dropped, and missing style words are added.
  - **Fallback**: when the LLM is not set, takes over 3 s or answers badly, a template built from a
    Turkish / English terrain dictionary is used, so the job always runs.
  - **Text filter**: both the narrative and the prompt go through it before anything is stored or
    reserved (`content.text_refused`).
  - **Record**: the job keeps the narrative, the prompt, who wrote it and the instruction version
    (`jobs.prompt_info`).
  - **Price**: the LLM call is part of the preset's price.

## Worker protocol (HTTP + JSON, `Authorization: Bearer <worker token>`)

| call | what |
|---|---|
| `POST /v1/worker/register` | capabilities (class, cores, memory, GPU, engine version) → worker id |
| `POST /v1/worker/claim` | long poll (≤ 25 s) with loaded models → a job: workflow, limits, files (id, sha256, size, signed GET URL) |
| `POST /v1/worker/jobs/:id/heartbeat` | progress events since the last call → `{cancel: bool}`; renews the lease |
| `POST /v1/worker/jobs/:id/uploads` | names and sizes of outputs → signed PUT URLs |
| `POST /v1/worker/jobs/:id/complete` | outputs (key, size, sha256, kind), worker seconds |
| `POST /v1/worker/jobs/:id/fail` | error code + detail (`workflow.invalid`, `limit.pixels`, `model.unsupported`, ...) |

## Files and models

* Stored content-addressed (`blobs/<sha256>`), owned through an `assets` table (user, name, kind,
  license, size, hash). The same bytes uploaded twice are stored once, but **access is always by
  ownership**: a user's upload is visible to that user only.
* Workflows name files as `asset:<id>`; the API checks ownership before queuing; the worker maps
  ids to its cache paths. Paths of the server's disk never appear in a workflow.
* **Catalog models** are assets owned by the service, each with its license recorded; only models
  whose licenses allow commercial hosted use are listed.
* **Partner apps** (issue #21; `apps/api/src/partners.ts`): an app such as GM Cebi sells to its own
  users, who never sign up here. The partner is one account and pays for everything its app does.
  - **End users**: the app's token sends `X-End-User: <opaque id ≤ 64>` (an install id; no email, no
    store account) on every request, or gets `partner.end_user_required`. Jobs and assets record it,
    and ownership is (account, end user): an end user sees and uses only their own jobs and files.
  - **Daily quota** (option C, the first closed test): `cli/partner.js --daily-jobs N` limits each end
    user to N jobs per calendar day (`--timezone`, default Europe/Istanbul). Past it, submissions get
    `quota.end_user_daily` (429, with `limit` and `resetsAt`) before anything is reserved. Jobs the
    service failed or that were cancelled do not count; held results do.
  - **Partner endpoints**: `GET /v1/partner/end-users/:id/usage` (jobs, cost, today's quota) and
    `DELETE /v1/partner/end-users/:id` (everything stored for them; idempotent). The app itself may
    call them for its own end user, and the partner's server with a `partner:manage` token (an app
    token for servers only, which needs no `X-End-User`) for any end user.
  - **Allowance grants** (option A): with `cli/partner.js --allowance on`, an end user's jobs draw on
    an allowance. After validating a store receipt, the partner's server grants credits with
    `POST /v1/partner/end-users/:id/allowance {credits, reason?, externalRef}`. The call needs
    `partner:manage`, so an app token gets `auth.scope_missing`, and it is idempotent on
    `externalRef`.
    - **Ledger**: entries go to `end_user_allowance` (grant, reserve, release, use; millicredits),
      tagged with the end user and the store reference.
    - **Jobs**: a job reserves its maximum from the allowance and keeps only what it used. Held
      results and the service's failures cost nothing. With too little allowance, the job is refused
      before anything is reserved (`allowance.insufficient`, 402).
    - **Billing**: the partner still pays NeuraCraft for every job from its own account ledger.
    - **Visibility**: the usage endpoint shows the balance and the entries.
* **User models**: the uploader declares the license and confirms they may use it; private to them;
  removed on a valid takedown notice.

## Safety and abuse

What is stored, for how long and where, and the sub-processors: [PRIVACY.md](PRIVACY.md). A cleanup
(`apps/api/src/retention.ts`, every 10 minutes) deletes expired preset inputs (24 h) and results
(7 days), the narratives on finished preset jobs, removed assets and the bytes nothing refers to any
more. `DELETE /v1/me` deletes an account with everything it owns.

* Every generated picture or video frame passes an output classifier (an ONNX model run by the
  engine itself) and every prompt a text filter before results are released; flagged results are
  held for review. This is independent of which model made them. Today this covers preset jobs
  (`apps/api/src/moderation.ts`):
  - **Classifier**: every preset workflow ends with the engine's `classify` step on its result
    (catalog slug `nsfw-classifier`: Falconsai's ViT NSFW model, Apache-2.0), which writes
    `moderation.json`. When the job completes, a score at or above `MODERATION_THRESHOLDS`
    (`nsfw=0.5`) holds the result: the asset is `held` (listed, never downloadable), the job fails
    with `content.flagged` and nothing is charged. A preset job without scores is held the same way
    (`content.unchecked`). The scores are kept on the job (`jobs.moderation`); the file is not an output.
  - **Text filter**: the prompt, negative prompt and narrative (and the prompt written from it) are
    checked before anything is stored or reserved (`content.text_refused`).
  - **Reports**: `POST /v1/assets/:id/report` with `{reason: sexual | violence_gore | hate |
    minor_safety | other, note?: ≤ 500 characters}` answers 202 for the picture's owner, once per
    asset and reporter (a repeat returns the same report), and 404 for anyone else or anything that
    is not a generated picture. Scope `assets:read`. The report keeps a snapshot of the job: preset,
    narrative and prompt, input assets, classifier scores.
  - **Review**: held results land in the same queue as reports. Operators use `cli/review.js`
    (`list`, `show` with links to the output and inputs, `dismiss`, `remove`, `flag-account`); every
    action is logged in `moderation_log` with the operator's name. Flagging an account has no automatic
    effect (bans and appeals are out of scope).
* Acceptable-use policy and terms (users warrant rights to what they upload; repeat infringers are
  removed); notice-and-takedown (Turkey 5651 hosting-provider duties, DMCA, DSA); abuse reports.
* Workers run in containers as non-root with a read-only root, memory / CPU / time limits, no
  network except the API and storage, and nothing secret but their worker token. The engine's file
  readers are fuzzed (`neuracraft/fuzz`).
* Rate limits per account and IP; sessions in httpOnly cookies; CSRF tokens on state changes.
* **Bearer tokens** for native clients and scripts (`Authorization: Bearer nc_pat_…` / `nc_app_…`):
  - **Kinds**: personal access tokens (made and revoked in the web app, `/v1/tokens`) and app tokens
    issued to a client application (`create-token` CLI).
  - **Storage**: only a SHA-256 of the secret is stored, and the secret is shown once. The prefixes
    let secret scanners find leaked tokens.
  - **Scopes**: `jobs:submit` (presets included), `jobs:read`, `assets:write` and `assets:read`, plus
    `partner:manage` for a partner's server (app tokens only). Nothing
    that changes the account, billing or tokens is a scope; those need a session.
  - **Revocation and expiry** take effect on the next request (`auth.token_revoked`,
    `auth.token_expired`); a missing scope gives `auth.scope_missing`.
  - **Rate limit**: 240 requests a minute per token, per API process.
  - **CSRF**: token requests carry no ambient credential, so they need no CSRF token.

## Billing

* Credits. Payments arrive through the merchant of record's webhooks and become ledger entries.
* The ledger is append-only: `grant`, `purchase`, `reserve`, `settle`, `refund`. Balance = sum.
* Submitting a job reserves its maximum cost (the plan's time limit × the worker class's rate);
  completion settles the measured worker seconds × rate and releases the rest; failures caused by
  the service refund everything.

## Languages

* Web: i18next with one JSON file per language (`apps/web/src/locales/<lang>.json`), English as the
  fallback. The language comes from the user's setting, else the browser's.
* API errors are `{error: {code, params}}`; the web turns codes into sentences. Emails and
  notifications use the same keys.
* The engine's operation titles and field docs are English in its schema; the web looks for
  `studio.ops.<op>`, `studio.docs.<op>` and `studio.fields.<field>` keys first and falls back to the
  schema text, so a new engine operation appears at once and is translated when its keys are added.

## Repository layout

```
apps/api        Fastify API + scheduler (TypeScript)
apps/web        web app (React, Vite, i18next)
packages/shared types shared by API and web: API shapes, job states, error codes, the engine schema
worker          C++ worker (CMake; NeuraCraft at a pinned tag)
db/migrations   SQL migrations, applied in order
deploy          Dockerfiles, docker-compose (development), production compose + Caddy
docs            this file, the roadmap, runbooks
```

## Roadmap

1. **Engine readiness** (neuracraft): Apache-2.0, workflow sandbox and limits, file mapping, fuzzed
   readers. *Done in NeuraCraft #62.*
2. **Local MVP**: accounts (email + password, Google later), upload, submit a workflow, live
   progress, results gallery; one CPU worker; English + Turkish; runs with `docker compose up`.
   *In: API, scheduler (claims, fairness, leases, retries, cancellation), credit ledger, worker,
   the web app's ready-made tasks and the Studio workflow editor (node graph, list and JSON views;
   every operation and field of the engine's schema; runs as ordinary jobs).*
3. **Many workers**: model-aware claiming, fairness, leases and retries, cancellation, quotas,
   credit ledger, usage metering, worker container hardening.
4. **Product**: payments (MoR), content safety, terms / takedown flows, production deployment
   (Hetzner + R2 + managed Postgres), monitoring, CPU autoscaling.
5. **GPU**: CUDA backend in the engine; Runpod GPU workers and their autoscaling.
