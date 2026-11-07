# Data, retention and sub-processors

What NeuraCraft Cloud stores, for how long, where, who can see it and how it is deleted. Partner
apps (GM Cebi first) can link to this page from their privacy policies and store forms. The
code it describes: `apps/api/src/retention.ts`, `moderation.ts`, `prompts.ts`.

## What is stored

| Data | Example | Kept | Who can see it |
| --- | --- | --- | --- |
| Account | email, password hash (scrypt), language, plan | until the account is deleted | the user; operators |
| Partner end user | an opaque id chosen by the partner app (an install id); no email, no store account | until the partner deletes it | the partner app acting for that end user |
| Preset input | the sketch (PNG) | **24 hours** after the job is submitted | its owner; operators while a report is open |
| Narrative and prompts | "Nehrin üzerinde ahşap bir köprü", the English prompt written from it | until **24 hours** after the job finishes | its owner (job details); operators while a report is open |
| Preset result | the generated scene (PNG) | **7 days** | its owner; operators while a report is open |
| Uploads and results outside presets | pictures, 3D models, clips the user uploads or makes with workflows | until the user deletes them | the user |
| Job record | timing, cost, preset and version, prompt instruction version, classifier scores | as long as the account | the user; operators |
| Reports | reason, note, a snapshot of the job (preset, narrative and prompt, input ids, scores) | the prompt until 30 days after the report is resolved; the reason and decision stay | operators |
| Credit ledger | grants, reservations, charges, refunds | as long as the account | the user; operators |
| Request logs | method, path (signed tokens cut out), status, time | rotated: at most 100 MB per service, the oldest dropped first | operators |

The logs never hold request bodies (narratives, prompts, pictures), query strings, headers or signed
storage URLs.

### How deletion works

- **Automatically**: a cleanup runs every 10 minutes. It deletes expired assets (database rows and
  stored bytes) and removes narratives and prompts from finished preset jobs. Stored bytes are
  content-addressed: identical files share one copy, which is deleted when its last asset goes.
- **Exceptions**:
  - Results under an **open report** are kept as evidence until an operator resolves the report.
  - A file an unfinished job still reads waits until that job ends.
- **By the user**:
  - `DELETE /v1/assets/:id` removes one file.
  - `DELETE /v1/me` (password confirmation) deletes the account and everything it owns. The rows go at
    once; the stored bytes go within two hours.
- **By a partner**: `DELETE /v1/partner/end-users/:id` deletes everything stored for one end user.
  The partner's server can call it, or the app for its own end user, for example from a "delete my
  data" button. Running jobs are cancelled. A second call finds nothing.

## Where

These are the production choices (`docs/ARCHITECTURE.md`, deployment milestone). This table changes
first if any of them changes.

| Part | Provider | Region |
| --- | --- | --- |
| Stored files (inputs, results, models) | Cloudflare R2 | EU jurisdiction bucket (data stays in the EU) |
| Control plane (API, database, web app) | Hetzner Cloud | Germany (Falkenstein / Nuremberg) |
| CPU workers | Hetzner Cloud | Germany |
| GPU workers | Runpod | EU data centres where available (EU-RO-1, EU-SE-1, EU-CZ-1, EU-NL-1, EU-FR-1); otherwise the EEA (Iceland, Norway) or, at peak load, the US |

**Keeping work in a region:**
- Each worker reports its region (`WORKER_REGION`).
- `INTERACTIVE_REGIONS=eu` keeps interactive presets such as `sketch_to_scene` on EU workers only.
  The production configuration sets it (`deploy/.env.example`).
- Without it, a GPU job can run outside the EU. The worker then receives the sketch and the
  English prompt (never the narrative) for the length of the job, and deletes them afterwards.
- Transfers outside the EEA rely on the providers' Standard Contractual Clauses. For Turkish users
  (KVKK art. 9), the partner's privacy policy names these transfers.

## Sub-processors

| Sub-processor | Purpose | Data | Region |
| --- | --- | --- | --- |
| Cloudflare, Inc. | file storage (R2), TLS and DNS | stored files; request metadata | EU (R2 jurisdiction); global edge |
| Hetzner Online GmbH | servers for the API, database and CPU workers | everything the service stores | Germany |
| Runpod, Inc. | GPU servers for image generation | a job's inputs and prompt while it runs | EU / EEA; US only when allowed |
| Anthropic, PBC | writing the English prompt from a narrative (Claude) | the narrative text, without account or end-user ids | US. Anthropic does not train on API data and keeps API inputs for a limited time for abuse monitoring |
| Payment provider (merchant of record: Paddle, Lemon Squeezy or Dodo, chosen at sign-up) | selling credits to NeuraCraft's own users | email, country, purchase | the provider's regions |

Partner apps that sell in-app purchases handle their store payments themselves. NeuraCraft never
sees their end users' store accounts.

Without `ANTHROPIC_API_KEY`, narratives never leave the service: a built-in template writes the prompt.

## Safety processing

- Every preset result passes an automatic content classifier that runs on NeuraCraft's own workers.
- Every text passes a word filter before anything is stored (`docs/ARCHITECTURE.md`, "Safety and
  abuse").
- Flagged results are held for review and never shown. Operators see a held or reported result, its
  inputs and its prompt only to resolve the report.
