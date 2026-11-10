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
  allowanceRequired: boolean;
  partnerDailyJobs: number | null; // across all end users (issue #48)
  requireEndUserTokens: boolean;
}

export async function partnerSettings(q: Q, userId: string): Promise<PartnerSettings | null> {
  const r = await q.query<{ end_user_daily_jobs: number | null; quota_timezone: string; allowance_required: boolean; partner_daily_jobs: number | null; require_end_user_tokens: boolean }>(
    "SELECT end_user_daily_jobs, quota_timezone, allowance_required, partner_daily_jobs, require_end_user_tokens FROM partners WHERE user_id = $1",
    [userId],
  );
  const p = r.rows[0];
  return p
    ? { endUserDailyJobs: p.end_user_daily_jobs, quotaTimezone: p.quota_timezone, allowanceRequired: p.allowance_required, partnerDailyJobs: p.partner_daily_jobs, requireEndUserTokens: p.require_end_user_tokens }
    : null;
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

// All end users of a partner today, for the partner-wide ceiling.
export async function partnerDay(q: Q, userId: string, tz: string): Promise<{ used: number; resetsAt: Date }> {
  const r = await q.query<{ used: string; resets_at: Date }>(
    `WITH day AS (SELECT date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2 AS start)
     SELECT (SELECT count(*) FROM jobs, day WHERE user_id = $1 AND end_user IS NOT NULL AND created_at >= day.start AND ${COUNTED}) AS used,
            (SELECT start + interval '1 day' FROM day) AS resets_at`,
    [userId, tz],
  );
  return { used: Number(r.rows[0]!.used), resetsAt: r.rows[0]!.resets_at };
}

// Called inside the submission transaction (the per-user lock is held) before anything is reserved:
// the daily quota, and with allowances on, that the end user's allowance covers the reservation.
// Returns whether the job draws on the allowance (reserveAllowance after the job row exists).
export async function checkEndUserQuota(c: pg.PoolClient, userId: string, endUser: string, reserve = 0): Promise<boolean> {
  const p = await partnerSettings(c, userId);
  if (!p) return false;
  if (p.endUserDailyJobs !== null) {
    const day = await endUserDay(c, userId, endUser, p.quotaTimezone);
    if (day.used >= p.endUserDailyJobs) fail(429, "quota.end_user_daily", { limit: p.endUserDailyJobs, resetsAt: day.resetsAt.toISOString() });
  }
  if (p.partnerDailyJobs !== null) {
    const day = await partnerDay(c, userId, p.quotaTimezone);
    if (day.used >= p.partnerDailyJobs) fail(429, "quota.partner_daily", { resetsAt: day.resetsAt.toISOString() });
  }
  if (!p.allowanceRequired) return false;
  const left = await allowanceBalance(c, userId, endUser);
  if (left < reserve) fail(402, "allowance.insufficient", { needed: reserve, balance: left });
  return true;
}

export async function reserveAllowance(c: pg.PoolClient, userId: string, endUser: string, jobId: string, amount: number): Promise<void> {
  await c.query("INSERT INTO end_user_allowance (user_id, end_user, kind, amount, job_id) VALUES ($1, $2, 'reserve', $3, $4)", [userId, endUser, -amount, jobId]);
}

// ---- Allowance grants (option A) ----

export async function allowanceBalance(q: Q, userId: string, endUser: string): Promise<number> {
  const r = await q.query<{ b: string | null }>("SELECT sum(amount) AS b FROM end_user_allowance WHERE user_id = $1 AND end_user = $2", [userId, endUser]);
  return Number(r.rows[0]?.b ?? 0);
}

// A grant from the partner's server after it validated a store receipt; idempotent on externalRef
// (a repeat returns the first grant, created = false).
export async function grantAllowance(
  c: pg.PoolClient,
  userId: string,
  endUser: string,
  amount: number,
  reason: string | null,
  externalRef: string,
): Promise<{ id: string; endUser: string; amount: number; reason: string | null; externalRef: string; createdAt: string; created: boolean }> {
  const ins = await c.query<{ id: string; end_user: string; amount: string; reason: string | null; external_ref: string; created_at: Date }>(
    `INSERT INTO end_user_allowance (user_id, end_user, kind, amount, reason, external_ref) VALUES ($1, $2, 'grant', $3, $4, $5)
     ON CONFLICT (user_id, external_ref) WHERE kind = 'grant' DO NOTHING
     RETURNING id, end_user, amount, reason, external_ref, created_at`,
    [userId, endUser, amount, reason, externalRef],
  );
  const created = ins.rows.length > 0;
  const row =
    ins.rows[0] ??
    (await c.query<{ id: string; end_user: string; amount: string; reason: string | null; external_ref: string; created_at: Date }>(
      "SELECT id, end_user, amount, reason, external_ref, created_at FROM end_user_allowance WHERE user_id = $1 AND external_ref = $2 AND kind = 'grant'",
      [userId, externalRef],
    )).rows[0]!;
  return { id: String(row.id), endUser: row.end_user, amount: Number(row.amount), reason: row.reason, externalRef: row.external_ref, createdAt: row.created_at.toISOString(), created };
}

export async function allowanceEntries(q: Q, userId: string, endUser: string, limit = 500) {
  const r = await q.query<{ kind: string; amount: string; job_id: string | null; reason: string | null; external_ref: string | null; created_at: Date }>(
    "SELECT kind, amount, job_id, reason, external_ref, created_at FROM end_user_allowance WHERE user_id = $1 AND end_user = $2 ORDER BY id DESC LIMIT $3",
    [userId, endUser, limit],
  );
  return r.rows.map((e) => ({ kind: e.kind, amount: Number(e.amount), jobId: e.job_id, reason: e.reason, externalRef: e.external_ref, at: e.created_at.toISOString() }));
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
  await c.query("DELETE FROM end_user_allowance WHERE user_id = $1 AND end_user = $2", [userId, endUser]);  // the partner keeps its receipts
  const assets = await c.query("DELETE FROM assets WHERE owner_id = $1 AND end_user = $2", [userId, endUser]);
  const jobs = await c.query("DELETE FROM jobs WHERE user_id = $1 AND end_user = $2 AND state IN ('succeeded', 'failed', 'cancelled')", [userId, endUser]);
  // A signed-in end user's identity and tokens (issue #48): signing in again makes a new end user.
  await c.query("DELETE FROM partner_end_users WHERE user_id = $1 AND end_user = $2", [userId, endUser]);
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
