// The credit ledger (millicredits, append-only; balance = sum).
import type pg from "pg";
import type { Db } from "./db.js";

type Q = Db | pg.PoolClient;

export async function balance(q: Q, userId: string): Promise<number> {
  const r = await q.query<{ b: string | null }>("SELECT sum(amount) AS b FROM ledger WHERE user_id = $1", [userId]);
  return Number(r.rows[0]?.b ?? 0);
}

export async function entry(q: Q, userId: string, kind: string, amount: number, jobId?: string, reference?: string): Promise<void> {
  await q.query("INSERT INTO ledger (user_id, kind, amount, job_id, reference) VALUES ($1, $2, $3, $4, $5)", [userId, kind, amount, jobId ?? null, reference ?? null]);
}

// A finished job: give back its reservation and charge what it used (nothing when the service failed it).
export async function settleJob(q: Q, jobId: string, charged: number): Promise<void> {
  const r = await q.query<{ user_id: string; reserved: string | null }>(
    "SELECT j.user_id, -sum(l.amount) FILTER (WHERE l.kind = 'reserve') AS reserved FROM jobs j LEFT JOIN ledger l ON l.job_id = j.id WHERE j.id = $1 GROUP BY j.user_id",
    [jobId],
  );
  const row = r.rows[0];
  if (!row) return;
  const already = await q.query("SELECT 1 FROM ledger WHERE job_id = $1 AND kind IN ('release', 'settle') LIMIT 1", [jobId]);
  if (already.rowCount) return;  // settled once only
  const reserved = Number(row.reserved ?? 0);
  if (reserved) await entry(q, row.user_id, "release", reserved, jobId);
  if (charged) await entry(q, row.user_id, "settle", -charged, jobId);
}
