// The worker protocol (docs/ARCHITECTURE.md). Workers hold a token from WORKER_TOKENS.
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CompleteRequest, FailRequest, HeartbeatRequest, UploadRequest, WorkerCapabilities, WorkerClaimRequest } from "@neuracraft/shared";
import type { Services } from "../app.js";
import { tx } from "../db.js";
import { fail } from "../errors.js";
import { publish } from "../events.js";
import { settleJob } from "../ledger.js";
import { cost } from "../plans.js";
import { claim, LEASE_SECONDS } from "../scheduler.js";
import { OUTPUT_NAME } from "../workflow.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_OUTPUT = 2 * 1024 ** 3;
// Failures that are the workflow's own (charged for the time used); others are the service's (free).
const userFault = (code: string) => /^(workflow|limit|model)\./.test(code) || code === "cancelled";

export async function workerRoutes(app: FastifyInstance, s: Services) {
  const tokens = s.config.workerTokens.map((t) => Buffer.from(t));
  const authorize = (req: FastifyRequest) => {
    const h = req.headers.authorization ?? "";
    const got = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
    if (!tokens.some((t) => t.length === got.length && timingSafeEqual(t, got))) fail(401, "worker.unauthorized");
  };
  const lease = async (jobId: string, workerId: string) => {
    if (!UUID.test(jobId) || !UUID.test(workerId)) fail(404, "not_found");
    const r = await s.db.query<{ user_id: string; worker_class: string; cancel: boolean; started_at: Date | null }>(
      "SELECT user_id, worker_class, cancel, started_at FROM jobs WHERE id = $1 AND worker_id = $2 AND state IN ('leased', 'running')",
      [jobId, workerId],
    );
    return r.rows[0] ?? fail(409, "worker.lease_lost");
  };

  app.post<{ Body: WorkerCapabilities }>("/v1/worker/register", async (req) => {
    authorize(req);
    const cap = req.body;
    if (!cap || (cap.class !== "cpu" && cap.class !== "gpu")) fail(400, "request.invalid");
    const r = await s.db.query<{ id: string }>("INSERT INTO workers (class, capabilities) VALUES ($1, $2) RETURNING id", [cap.class, JSON.stringify(cap)]);
    return { workerId: r.rows[0]!.id };
  });

  // Long poll: waits up to waitSeconds (≤ 25) for a job.
  app.post<{ Body: WorkerClaimRequest }>("/v1/worker/claim", async (req) => {
    authorize(req);
    const { workerId, loadedModels = [] } = req.body ?? ({} as WorkerClaimRequest);
    if (!UUID.test(String(workerId))) fail(400, "request.invalid");
    const w = await s.db.query<{ class: string }>("UPDATE workers SET last_seen_at = now(), loaded = $2 WHERE id = $1 RETURNING class", [
      workerId,
      loadedModels.filter((m) => UUID.test(m)),
    ]);
    const workerClass = w.rows[0]?.class ?? fail(401, "worker.unauthorized");
    const deadline = Date.now() + Math.min(25, Math.max(0, Number(req.body.waitSeconds ?? 20))) * 1000;
    for (;;) {
      const job = await claim(s.db, s.storage, workerId, workerClass, loadedModels.filter((m) => UUID.test(m)));
      if (job || Date.now() >= deadline) return { job };
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  app.post<{ Params: { id: string }; Body: HeartbeatRequest }>("/v1/worker/jobs/:id/heartbeat", async (req) => {
    authorize(req);
    const { workerId, progress } = req.body ?? ({} as HeartbeatRequest);
    const j = await lease(req.params.id, workerId);
    await s.db.query(
      `UPDATE jobs SET lease_until = now() + make_interval(secs => $3), progress = coalesce($4::jsonb, progress),
              state = 'running', started_at = coalesce(started_at, now())
        WHERE id = $1 AND worker_id = $2`,
      [req.params.id, workerId, LEASE_SECONDS, progress ? JSON.stringify(progress) : null],
    );
    if (!j.started_at) await publish(s.db, req.params.id, { type: "state", state: "running" });
    if (progress) await publish(s.db, req.params.id, { type: "progress", progress });
    return { cancel: j.cancel };
  });

  app.post<{ Params: { id: string }; Body: UploadRequest }>("/v1/worker/jobs/:id/uploads", async (req) => {
    authorize(req);
    const { workerId, outputs = [] } = req.body ?? ({} as UploadRequest);
    await lease(req.params.id, workerId);
    if (outputs.length > 64) fail(400, "request.invalid");
    return {
      uploads: outputs.map((o, i) => {
        if (!OUTPUT_NAME.test(o.name) || !(o.bytes > 0) || o.bytes > MAX_OUTPUT) fail(400, "request.invalid", { output: o.name });
        const key = `uploads/${req.params.id}/${i}-${o.name}`;
        return { name: o.name, key, url: s.storage.uploadUrl(key, o.bytes, 3600) };
      }),
    };
  });

  app.post<{ Params: { id: string }; Body: CompleteRequest }>("/v1/worker/jobs/:id/complete", async (req) => {
    authorize(req);
    const body = req.body ?? ({} as CompleteRequest);
    const j = await lease(req.params.id, body.workerId);
    const prefix = `uploads/${req.params.id}/`;
    const stored: (CompleteRequest["outputs"][number] & { sha256: string; bytes: number })[] = [];
    for (const o of body.outputs ?? []) {
      if (!o.key?.startsWith(prefix) || !OUTPUT_NAME.test(o.name)) fail(400, "request.invalid");
      stored.push({ ...o, ...(await s.storage.finalize(o.key)) });
    }
    const seconds = Math.max(0, Number(body.workerSeconds) || 0);
    await tx(s.db, async (c) => {
      for (const o of stored) {
        await c.query("INSERT INTO blobs (sha256, bytes) VALUES ($1, $2) ON CONFLICT DO NOTHING", [o.sha256, o.bytes]);
        const a = await c.query<{ id: string }>(
          "INSERT INTO assets (owner_id, kind, name, content_type, sha256, bytes) VALUES ($1, 'output', $2, $3, $4, $5) RETURNING id",
          [j.user_id, o.name, String(o.contentType ?? "application/octet-stream").slice(0, 100), o.sha256, o.bytes],
        );
        await c.query("INSERT INTO job_outputs (job_id, name, asset_id) VALUES ($1, $2, $3)", [req.params.id, o.name, a.rows[0]!.id]);
        await publish(c, req.params.id, { type: "output", output: { name: o.name, assetId: a.rows[0]!.id, kind: o.contentType.startsWith("image/") ? "image" : o.contentType.startsWith("video/") ? "video" : "file", bytes: o.bytes } });
      }
      await c.query(
        `UPDATE jobs SET state = 'succeeded', finished_at = now(), worker_seconds = $2, lease_until = NULL,
                started_at = coalesce(started_at, now() - make_interval(secs => $2)) WHERE id = $1`,
        [req.params.id, seconds],
      );
      await settleJob(c, req.params.id, cost(j.worker_class, seconds));
      await publish(c, req.params.id, { type: "state", state: "succeeded" });
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: FailRequest }>("/v1/worker/jobs/:id/fail", async (req) => {
    authorize(req);
    const body = req.body ?? ({} as FailRequest);
    const j = await lease(req.params.id, body.workerId);
    const code = String(body.code ?? "internal").slice(0, 64);
    const seconds = Math.max(0, Number(body.workerSeconds) || 0);
    const state = code === "cancelled" || j.cancel ? "cancelled" : "failed";
    await tx(s.db, async (c) => {
      await c.query(
        `UPDATE jobs SET state = $2, finished_at = now(), worker_seconds = $3, error = $4, lease_until = NULL,
                started_at = coalesce(started_at, now() - make_interval(secs => $3)) WHERE id = $1`,
        [
          req.params.id,
          state,
          seconds,
          state === "cancelled" ? null : JSON.stringify({ code, detail: String(body.detail ?? "").slice(0, 2000) }),
        ],
      );
      await settleJob(c, req.params.id, userFault(code) ? cost(j.worker_class, seconds) : 0);
      if (state === "failed") await publish(c, req.params.id, { type: "error", error: { code, detail: body.detail } });
      await publish(c, req.params.id, { type: "state", state });
    });
    return { ok: true };
  });
}
