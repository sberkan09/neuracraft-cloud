import type { FastifyInstance } from "fastify";
import type { Job, JobEvent } from "@neuracraft/shared";
import type { Services } from "../app.js";
import { requireUser } from "../auth.js";
import { tx } from "../db.js";
import { fail } from "../errors.js";
import { publish } from "../events.js";
import { balance, entry, settleJob } from "../ledger.js";
import { cost, planFor } from "../plans.js";
import { checkSubmittedWorkflow } from "../workflow.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface JobRow {
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

async function jobJson(s: Services, row: JobRow): Promise<Job> {
  const outs = await s.db.query<{ name: string; asset_id: string; content_type: string; bytes: string }>(
    "SELECT o.name, o.asset_id, a.content_type, a.bytes FROM job_outputs o JOIN assets a ON a.id = o.asset_id WHERE o.job_id = $1 ORDER BY o.name",
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
      kind: o.content_type.startsWith("image/") ? "image" : o.content_type.startsWith("video/") ? "video" : "file",
      bytes: Number(o.bytes),
    })),
    error: row.error,
    workerSeconds: row.worker_seconds,
  };
}

export async function jobRoutes(app: FastifyInstance, s: Services) {
  app.post<{ Body: { workflow?: unknown } }>("/v1/jobs", async (req, reply) => {
    const u = await requireUser(s.db, req);
    const plan = planFor(u.plan);
    const checked = await checkSubmittedWorkflow(s.db, u.id, req.body?.workflow, plan.limits);
    const workerClass = "cpu";
    const reserve = cost(workerClass, plan.limits.maxSeconds);
    const row = await tx(s.db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [u.id]);  // one submission per user at a time
      const active = await c.query<{ n: string }>("SELECT count(*) AS n FROM jobs WHERE user_id = $1 AND state IN ('queued', 'leased', 'running')", [u.id]);
      if (Number(active.rows[0]!.n) >= plan.concurrentJobs * 4) fail(429, "limit.concurrent_jobs", { max: plan.concurrentJobs * 4 });
      if ((await balance(c, u.id)) < reserve) fail(402, "credits.insufficient", { needed: reserve });
      const r = await c.query<JobRow>(
        `INSERT INTO jobs (user_id, worker_class, priority, workflow, limits, models, files)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [u.id, workerClass, plan.priority, JSON.stringify(checked.workflow), JSON.stringify(plan.limits), checked.models, checked.files],
      );
      await entry(c, u.id, "reserve", -reserve, r.rows[0]!.id);
      await publish(c, r.rows[0]!.id, { type: "state", state: "queued" });
      return r.rows[0]!;
    });
    return reply.status(201).send({ job: await jobJson(s, row) });
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/jobs", async (req) => {
    const u = await requireUser(s.db, req);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 30) || 30));
    const r = await s.db.query<JobRow>("SELECT * FROM jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2", [u.id, limit]);
    return { jobs: await Promise.all(r.rows.map((x) => jobJson(s, x))) };
  });

  const own = async (userId: string, id: string) => {
    if (!UUID.test(id)) fail(404, "not_found");
    const r = await s.db.query<JobRow>("SELECT * FROM jobs WHERE id = $1 AND user_id = $2", [id, userId]);
    return r.rows[0] ?? fail(404, "not_found");
  };

  app.get<{ Params: { id: string } }>("/v1/jobs/:id", async (req) => {
    const u = await requireUser(s.db, req);
    return { job: await jobJson(s, await own(u.id, req.params.id)) };
  });

  // Queued: cancelled at once. Running: the worker is told on its next heartbeat and stops.
  app.post<{ Params: { id: string } }>("/v1/jobs/:id/cancel", async (req) => {
    const u = await requireUser(s.db, req);
    await own(u.id, req.params.id);
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
    const u = await requireUser(s.db, req);
    const row = await own(u.id, req.params.id);
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
