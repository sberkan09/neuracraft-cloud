// Handing jobs to workers (docs/ARCHITECTURE.md, "Jobs"): claims, leases, retries.
import type { ClaimedFile, ClaimedJob, JobLimits } from "@neuracraft/shared";
import type { Db } from "./db.js";
import { tx } from "./db.js";
import { publish } from "./events.js";
import { settleJob } from "./ledger.js";
import { plans } from "./plans.js";
import { blobKey, type Storage } from "./storage.js";

export const LEASE_SECONDS = 30;
export const MAX_ATTEMPTS = 3;

// The next job for a worker of `workerClass` holding `loaded` models, or null. Claims are serialised
// (a transaction-wide advisory lock) so per-user concurrency holds exactly.
export async function claim(db: Db, storage: Storage, workerId: string, workerClass: string, loaded: string[]): Promise<ClaimedJob | null> {
  const concurrency = Object.fromEntries(Object.entries(plans).map(([k, p]) => [k, p.concurrentJobs]));
  const job = await tx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(727002)");
    const r = await c.query<{ id: string; workflow: unknown; limits: JobLimits; files: string[] }>(
      `WITH busy AS (SELECT user_id, count(*) AS n FROM jobs WHERE state IN ('leased', 'running') GROUP BY user_id)
       SELECT j.id, j.workflow, j.limits, j.files FROM jobs j
         JOIN users u ON u.id = j.user_id
         LEFT JOIN busy b ON b.user_id = j.user_id
        WHERE j.state = 'queued' AND j.worker_class = $1 AND NOT j.cancel
          AND coalesce(b.n, 0) < coalesce(($3::jsonb ->> u.plan)::int, 1)
        ORDER BY j.priority DESC, coalesce(b.n, 0), (j.models <@ $2::uuid[]) DESC, j.created_at
        LIMIT 1
          FOR UPDATE OF j SKIP LOCKED`,
      [workerClass, loaded, JSON.stringify(concurrency)],
    );
    const row = r.rows[0];
    if (!row) return null;
    await c.query(
      "UPDATE jobs SET state = 'leased', worker_id = $2, lease_until = now() + make_interval(secs => $3), attempts = attempts + 1 WHERE id = $1",
      [row.id, workerId, LEASE_SECONDS],
    );
    await publish(c, row.id, { type: "state", state: "leased" });
    return row;
  });
  if (!job) return null;
  return { jobId: job.id, workflow: job.workflow, limits: job.limits, files: await claimedFiles(db, storage, job.files), leaseSeconds: LEASE_SECONDS };
}

async function claimedFiles(db: Db, storage: Storage, ids: string[]): Promise<ClaimedFile[]> {
  if (!ids.length) return [];
  const assets = await db.query<{ id: string; kind: string; name: string; sha256: string | null; bytes: string; entry: string | null }>(
    "SELECT id, kind, name, sha256, bytes, entry FROM assets WHERE id = ANY($1::uuid[])",
    [ids],
  );
  const files = await db.query<{ asset_id: string; path: string; sha256: string; bytes: string }>(
    "SELECT asset_id, path, sha256, bytes FROM asset_files WHERE asset_id = ANY($1::uuid[]) ORDER BY path",
    [ids],
  );
  const hour = 3600;
  return assets.rows.map((a) => {
    const parts = files.rows.filter((f) => f.asset_id === a.id);
    const out: ClaimedFile = {
      assetId: a.id,
      name: a.name,
      sha256: a.sha256 ?? "",
      bytes: Number(a.bytes),
      url: a.sha256 ? storage.downloadUrl(blobKey(a.sha256), hour) : "",
      kind: a.kind === "model" ? "model" : "input",
    };
    if (a.entry) out.entry = a.entry;
    if (parts.length)
      out.files = parts.map((f) => ({ path: f.path, sha256: f.sha256, bytes: Number(f.bytes), url: storage.downloadUrl(blobKey(f.sha256), hour) }));
    return out;
  });
}

// Jobs whose worker stopped renewing the lease go back to the queue, or fail after MAX_ATTEMPTS.
export async function reapLeases(db: Db): Promise<number> {
  return tx(db, async (c) => {
    const got = await c.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(727003) AS ok");
    if (!got.rows[0]?.ok) return 0;
    const expired = await c.query<{ id: string; attempts: number; cancel: boolean }>(
      "SELECT id, attempts, cancel FROM jobs WHERE state IN ('leased', 'running') AND lease_until < now() FOR UPDATE SKIP LOCKED",
    );
    for (const j of expired.rows) {
      if (j.cancel || j.attempts >= MAX_ATTEMPTS) {
        const state = j.cancel ? "cancelled" : "failed";
        await c.query("UPDATE jobs SET state = $2, finished_at = now(), worker_id = NULL, error = $3 WHERE id = $1", [
          j.id,
          state,
          j.cancel ? null : JSON.stringify({ code: "internal", detail: "the worker stopped responding" }),
        ]);
        await settleJob(c, j.id, 0);
        await publish(c, j.id, { type: "state", state });
      } else {
        await c.query("UPDATE jobs SET state = 'queued', worker_id = NULL, lease_until = NULL WHERE id = $1", [j.id]);
        await publish(c, j.id, { type: "state", state: "queued" });
      }
    }
    return expired.rowCount ?? 0;
  });
}
