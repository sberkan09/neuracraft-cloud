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
* **Autoscaler** (later) — watches queue depth per worker class and starts or stops machines
  through the providers' APIs (Hetzner, Runpod). Workers are cattle: any can die at any moment.

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
* **User models**: the uploader declares the license and confirms they may use it; private to them;
  removed on a valid takedown notice.

## Safety and abuse

* Every generated picture or video frame passes an output classifier (an ONNX model run by the
  engine itself) and every prompt a text filter before results are released; flagged results are
  held for review. This is independent of which model made them.
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
  - **Scopes**: `jobs:submit` (presets included), `jobs:read`, `assets:write` and `assets:read`. Nothing
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
