// Partner apps and their end users (issue #21, option C first: a per-end-user daily quota paid by
// the partner). A partner is one NeuraCraft account with an app token; its app sends X-End-User (an
// opaque install id) and every job and asset records it (auth.ts). The partner pays for all of them.
import type pg from "pg";
import type { Db } from "./db.js";
import { fail } from "./errors.js";
import { publish } from "./events.js";
import { settleJob } from "./ledger.js";
import { scrubPromptInfo, scrubWorkflow } from "./retention.js";

type Q = Db | pg.PoolClient;

export interface PartnerSettings {
  endUserDailyJobs: number | null;
  quotaTimezone: string;
}

export async function partnerSettings(q: Q, userId: string): Promise<PartnerSettings | null> {
  const r = await q.query<{ end_user_daily_jobs: number | null; quota_timezone: string }>(
    "SELECT end_user_daily_jobs, quota_timezone FROM partners WHERE user_id = $1",
    [userId],
  );
  const p = r.rows[0];
  return p ? { endUserDailyJobs: p.end_user_daily_jobs, quotaTimezone: p.quota_timezone } : null;
}

// Jobs that count against the day: everything started except jobs the service failed or that were
// cancelled (those are free); a result the classifier held counts.
const COUNTED = `(state IN ('queued', 'leased', 'running', 'succeeded') OR (state = 'failed' AND error ->> 'code' = 'content.flagged'))`;

export async function endUserDay(q: Q, userId: string, endUser: string, tz: string): Promise<{ used: number; resetsAt: Date }> {
  const r = await q.query<{ used: string; resets_at: Date }>(
    `WITH day AS (SELECT date_trunc('day', now() AT TIME ZONE $3) AT TIME ZONE $3 AS start)
     SELECT (SELECT count(*) FROM jobs, day WHERE user_id = $1 AND end_user = $2 AND created_at >= day.start AND ${COUNTED}) AS used,
            (SELECT start + interval '1 day' FROM day) AS resets_at`,
    [userId, endUser, tz],
  );
  return { used: Number(r.rows[0]!.used), resetsAt: r.rows[0]!.resets_at };
}

// Called inside the submission transaction (the per-user lock is held) before anything is reserved.
export async function checkEndUserQuota(c: pg.PoolClient, userId: string, endUser: string): Promise<void> {
  const p = await partnerSettings(c, userId);
  if (!p || p.endUserDailyJobs === null) return;
  const day = await endUserDay(c, userId, endUser, p.quotaTimezone);
  if (day.used >= p.endUserDailyJobs) fail(429, "quota.end_user_daily", { limit: p.endUserDailyJobs, resetsAt: day.resetsAt.toISOString() });
}

// Everything stored for one end user goes: assets at once (the bytes with the next cleanup), finished
// jobs, and the narrative and prompts of jobs still running (they are cancelled). Reports keep their
// record without the prompt. Idempotent: a second call finds nothing.
export async function deleteEndUser(c: pg.PoolClient, userId: string, endUser: string): Promise<{ assets: number; jobs: number }> {
  const active = await c.query<{ id: string; state: string; prompt_info: unknown; workflow: unknown }>(
    "SELECT id, state, prompt_info, workflow FROM jobs WHERE user_id = $1 AND end_user = $2 AND state IN ('queued', 'leased', 'running') FOR UPDATE",
    [userId, endUser],
  );
  for (const j of active.rows) {
    await c.query("UPDATE jobs SET cancel = true, prompt_info = $2, workflow = $3, scrubbed_at = now() WHERE id = $1", [
      j.id,
      JSON.stringify(scrubPromptInfo(j.prompt_info)),
      JSON.stringify(scrubWorkflow(j.workflow)),
    ]);
    if (j.state === "queued") {
      await c.query("UPDATE jobs SET state = 'cancelled', finished_at = now() WHERE id = $1", [j.id]);
      await settleJob(c, j.id, 0);
      await publish(c, j.id, { type: "state", state: "cancelled" });
    }
  }
  await c.query(
    `UPDATE reports SET snapshot = (snapshot - 'prompt' - 'workflow') || '{"scrubbed": true}'::jsonb
      WHERE job_id IN (SELECT id FROM jobs WHERE user_id = $1 AND end_user = $2) AND NOT (snapshot ? 'scrubbed')`,
    [userId, endUser],
  );
  const assets = await c.query("DELETE FROM assets WHERE owner_id = $1 AND end_user = $2", [userId, endUser]);
  const jobs = await c.query("DELETE FROM jobs WHERE user_id = $1 AND end_user = $2 AND state IN ('succeeded', 'failed', 'cancelled')", [userId, endUser]);
  return { assets: assets.rowCount ?? 0, jobs: jobs.rowCount ?? 0 };
}

// One end user's jobs with what each cost the partner (millicredits), newest first.
export async function endUserUsage(q: Q, userId: string, endUser: string, limit = 500) {
  const r = await q.query<{ id: string; preset: string | null; state: string; error: { code?: string } | null; created_at: Date; finished_at: Date | null; worker_seconds: number | null; charged: string | null }>(
    `SELECT j.id, j.preset, j.state, j.error, j.created_at, j.finished_at, j.worker_seconds,
            -(SELECT sum(l.amount) FROM ledger l WHERE l.job_id = j.id AND l.kind = 'settle') AS charged
       FROM jobs j WHERE j.user_id = $1 AND j.end_user = $2 ORDER BY j.created_at DESC LIMIT $3`,
    [userId, endUser, Math.min(Math.max(limit, 1), 5000)],
  );
  return r.rows.map((j) => ({
    jobId: j.id,
    preset: j.preset,
    state: j.state,
    errorCode: j.error?.code ?? null,
    createdAt: j.created_at.toISOString(),
    finishedAt: j.finished_at?.toISOString() ?? null,
    workerSeconds: j.worker_seconds,
    charged: Number(j.charged ?? 0),
  }));
}
