# Usage log

What the service records so that, after a few weeks of real use, one can answer questions such as
"would a hosted service (fal.ai, Replicate, ...) have been cheaper than renting our own GPUs for
these jobs, at these times?". Migration `013_usage_log.sql`; export with `usage.ts`.

## What is recorded

**`usage_jobs`**: one row per finished job, written by a database trigger.
- What the GPU was asked to do:
  - preset and variant (`map` / `atmosphere`);
  - the generation step's op, size, steps and sampler;
  - whether it used a ControlNet, and how many LoRAs and model files;
  - whether an LLM wrote the prompt.
- Where it ran: the pod, its GPU type and its price per hour.
- How it went: the state and error code (`content.flagged`, ...), attempts, and the times
  (created, claimed, started, finished).
- The worker's timings (warm, fetch, load, run, upload).

**`usage_sessions`**: one row per app session when it closes (start, end, close reason, last job).

**`capacity_events`**: what the capacity manager did and why.

| `kind` | `detail` |
|---|---|
| `pod.requested` | GPU type, region, price per hour, provider id, how long the rent call took |
| `pod.rent_failed` | whether the provider had no GPU, the error |
| `pod.registered` | seconds from renting to the worker registering |
| `pod.warm` | seconds the warm-up took |
| `pod.draining` | why: `idle`, `budget`, `max_age` |
| `pod.stopped` | why (`drained`, `idle`, `budget`, `start_timeout`, `worker_dead`, `exited`, `gone`), billed seconds, cost, jobs, busy seconds |
| `pod.orphan_terminated` | a pod at the provider the database did not know |
| `capacity.demand` | open sessions, waiting jobs, pods wanted and there (on every change) |
| `capacity.blocked` / `capacity.unblocked` | a budget reached, no GPU at the provider, ... |

**Also kept:**
- `gpu_pods`: every rented pod with its price and times.
- `workers.warmed_at`: when a worker's warm-up ended.

## Privacy

The log holds no narratives, prompts, pictures, accounts or end-user ids. The session id is a random
id. Because nothing in it identifies a person:
- it is kept after retention scrubs the jobs;
- it is kept after a user or an end user deletes their data;
- it has no expiry. It grows by a few hundred bytes per job.

## Export

For a period (default: the last 30 days), as five files:
- `jobs.csv`: one line per job, with queue, fetch, load, run, upload, GPU-busy and end-to-end seconds;
- `pods.csv`: one line per pod, with seconds to its worker and to warm, billed seconds and cost in the
  period, jobs, busy seconds and why it stopped;
- `sessions.csv`: length, jobs, when the first job came and how long it took;
- `events.csv`: the capacity events;
- `summary.json`, the totals:
  - jobs: by state, error, variant, day and hour (Istanbul), and the peak per minute;
  - GPU: billed and busy hours, utilisation, cost, idle cost;
  - cost per successful image, with the fixed monthly costs given;
  - latency: overall, warm and cold;
  - session patterns;
  - `forHostedComparison`: each distinct job shape with its image count, ready to price with a hosted
    service's per-image, per-megapixel or per-GPU-second rate.

How to get it:
- From the server:
  ```
  docker compose exec api node apps/api/dist/src/cli/usage-report.js --from 2026-11-10 --out /data/storage/usage --fixed-usd-month 10
  ```
- Over HTTP, with an operator token (`ADMIN_TOKENS`):
  ```
  curl -H "Authorization: Bearer $ADMIN_TOKEN" "https://<host>/v1/admin/usage-report?from=2026-11-10&fixedUsdMonth=10" > usage.json
  ```
