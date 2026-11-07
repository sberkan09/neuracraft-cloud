import type { FastifyInstance } from "fastify";
import { outputKind, type Job, type JobEvent } from "@neuracraft/shared";
import type { Services } from "../app.js";
import { requireUser } from "../auth.js";
import { tx } from "../db.js";
import { fail } from "../errors.js";
import { publish } from "../events.js";
import { balance, entry, settleJob } from "../ledger.js";
import { cost, planFor } from "../plans.js";
import { checkSubmittedWorkflow, type CheckedWorkflow } from "../workflow.js";
import { checkEndUserQuota } from "../partners.js";
import type { JobLimits } from "@neuracraft/shared";
import type pg from "pg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface JobRow {
  id: string;
  state: Job["state"];
  workflow: unknown;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  progress: Job["progress"];
  error: Job["error"];
  worker_seconds: number | null;
}

export async function jobJson(s: Services, row: JobRow): Promise<Job> {
  const outs = await s.db.query<{ name: string; asset_id: string; content_type: string; bytes: string }>(
    "SELECT o.name, o.asset_id, a.content_type, a.bytes FROM job_outputs o JOIN assets a ON a.id = o.asset_id WHERE o.job_id = $1 AND a.status = 'ready' ORDER BY o.name",
    [row.id],
  );
  return {
    id: row.id,
    state: row.state,
    workflow: row.workflow,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    progress: row.progress,
    outputs: outs.rows.map((o) => ({
      name: o.name,
      assetId: o.asset_id,
      kind: outputKind(o.content_type),
      bytes: Number(o.bytes),
    })),
    error: row.error,
    workerSeconds: row.worker_seconds,
  };
}

const SERVICE_GRACE_SECONDS = 600;
const GPU_WORKER =
  "SELECT 1 FROM workers WHERE class = 'gpu' AND (cardinality($1::text[]) = 0 OR capabilities ->> 'region' = ANY($1::text[])) AND last_seen_at > now() - make_interval(secs => $2) LIMIT 1";
const SERVICE_WORKER =
  "SELECT 1 FROM workers WHERE class = 'gpu' AND capabilities -> 'features' ?& $1::text[] AND last_seen_at > now() - make_interval(secs => $2) LIMIT 1";

// Queues a checked workflow for the user inside the caller's transaction: per-user concurrency, a
// reservation for `limits.maxSeconds` of the job's worker class, the job row and its first event.
// Steps run by a service (3D models, rigging) need a GPU worker with it; without one the job would wait forever.
export async function queueJob(
  s: Services,
  c: pg.PoolClient,
  u: { id: string; plan: string; endUser: string | null },
  checked: CheckedWorkflow,
  opts: {
    limits: JobLimits;
    preset?: { id: string; version: number; variant?: string | null };
    promptInfo?: Record<string, unknown> | null;
    regions?: string[];
    latency?: "interactive" | "batch";
  },
): Promise<JobRow> {
  const plan = planFor(u.plan);
  const reserve = cost(checked.workerClass, opts.limits.maxSeconds);
  if (checked.features.length && !(await c.query(SERVICE_WORKER, [checked.features, SERVICE_GRACE_SECONDS])).rowCount)
    fail(503, "job.no_3d_worker", { services: checked.features.join(", ") });
  // Interactive jobs never wait minutes for a GPU: without one seen lately (in their regions), they are
  // refused at once so the app can say "try again in a minute".
  if (opts.latency === "interactive" && !(await c.query(GPU_WORKER, [opts.regions ?? [], s.config.interactiveGraceSeconds])).rowCount)
    fail(503, "job.no_gpu_worker");
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [u.id]);  // one submission per user at a time
  const active = await c.query<{ n: string }>("SELECT count(*) AS n FROM jobs WHERE user_id = $1 AND state IN ('queued', 'leased', 'running')", [u.id]);
  if (Number(active.rows[0]!.n) >= plan.concurrentJobs * 4) fail(429, "limit.concurrent_jobs", { max: plan.concurrentJobs * 4 });
  if (u.endUser) await checkEndUserQuota(c, u.id, u.endUser);  // before anything is reserved
  if ((await balance(c, u.id)) < reserve) fail(402, "credits.insufficient", { needed: reserve });
  const r = await c.query<JobRow>(
    `INSERT INTO jobs (user_id, worker_class, features, priority, workflow, limits, models, files, preset, preset_version, prompt_info, regions, end_user, latency, preset_variant)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
    [u.id, checked.workerClass, checked.features, plan.priority, JSON.stringify(checked.workflow), JSON.stringify(opts.limits), checked.models, checked.files,
     opts.preset?.id ?? null, opts.preset?.version ?? null, opts.promptInfo ? JSON.stringify(opts.promptInfo) : null, opts.regions ?? [], u.endUser, opts.latency ?? "batch", opts.preset?.variant ?? null],
  );
  await entry(c, u.id, "reserve", -reserve, r.rows[0]!.id);
  await publish(c, r.rows[0]!.id, { type: "state", state: "queued" });
  return r.rows[0]!;
}

export async function jobRoutes(app: FastifyInstance, s: Services) {
  app.post<{ Body: { workflow?: unknown } }>("/v1/jobs", async (req, reply) => {
    const u = await requireUser(s.db, req, "jobs:submit");
    const plan = planFor(u.plan);
    const checked = await checkSubmittedWorkflow(s.db, u.id, req.body?.workflow, plan.limits, u.endUser);
    const row = await tx(s.db, (c) => queueJob(s, c, u, checked, { limits: plan.limits }));
    return reply.status(201).send({ job: await jobJson(s, row) });
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/jobs", async (req) => {
    const u = await requireUser(s.db, req, "jobs:read");
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 30) || 30));
    const r = await s.db.query<JobRow>("SELECT * FROM jobs WHERE user_id = $1 AND end_user IS NOT DISTINCT FROM $3 ORDER BY created_at DESC LIMIT $2", [u.id, limit, u.endUser]);
    return { jobs: await Promise.all(r.rows.map((x) => jobJson(s, x))) };
  });

  const own = async (u: { id: string; endUser: string | null }, id: string) => {
    if (!UUID.test(id)) fail(404, "not_found");
    const r = await s.db.query<JobRow>("SELECT * FROM jobs WHERE id = $1 AND user_id = $2 AND end_user IS NOT DISTINCT FROM $3", [id, u.id, u.endUser]);
    return r.rows[0] ?? fail(404, "not_found");
  };

  app.get<{ Params: { id: string } }>("/v1/jobs/:id", async (req) => {
    const u = await requireUser(s.db, req, "jobs:read");
    return { job: await jobJson(s, await own(u, req.params.id)) };
  });

  // Queued: cancelled at once. Running: the worker is told on its next heartbeat and stops.
  app.post<{ Params: { id: string } }>("/v1/jobs/:id/cancel", async (req) => {
    const u = await requireUser(s.db, req, "jobs:submit");
    await own(u, req.params.id);
    const state = await tx(s.db, async (c) => {
      const r = await c.query<{ state: string }>("SELECT state FROM jobs WHERE id = $1 FOR UPDATE", [req.params.id]);
      const st = r.rows[0]!.state;
      if (st === "queued") {
        await c.query("UPDATE jobs SET state = 'cancelled', cancel = true, finished_at = now() WHERE id = $1", [req.params.id]);
        await settleJob(c, req.params.id, 0);
        await publish(c, req.params.id, { type: "state", state: "cancelled" });
        return "cancelled";
      }
      if (st === "leased" || st === "running") {
        await c.query("UPDATE jobs SET cancel = true WHERE id = $1", [req.params.id]);
        return st;
      }
      return fail(409, "job.not_cancellable");
    });
    return { state };
  });

  // Live progress as server-sent events: the current job first, then each change until it finishes.
  app.get<{ Params: { id: string } }>("/v1/jobs/:id/events", async (req, reply) => {
    const u = await requireUser(s.db, req, "jobs:read");
    const row = await own(u, req.params.id);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    const send = (e: JobEvent | { type: "job"; job: Job }) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    send({ type: "job", job: await jobJson(s, row) });
    const finished = new Set(["succeeded", "failed", "cancelled"]);
    if (finished.has(row.state)) return res.end();
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    const stop = s.events.subscribe(row.id, async (e) => {
      if (e.type === "state" && finished.has(e.state)) {
        const fresh = await s.db.query<JobRow>("SELECT * FROM jobs WHERE id = $1", [row.id]);
        send({ type: "job", job: await jobJson(s, fresh.rows[0]!) });
        close();
      } else send(e);
    });
    const close = () => {
      clearInterval(ping);
      stop();
      res.end();
    };
    req.raw.on("close", close);
  });
}
