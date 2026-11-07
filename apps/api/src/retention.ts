// Retention (issue #19, docs/PRIVACY.md): what the service keeps, and for how long.
//
// The cleanup (every 10 minutes, one API replica at a time) deletes:
// - assets past their expires_at (preset jobs set it: inline inputs after `inputHours`, outputs after
//   `outputDays`), assets their owner or an operator removed, and uploads never completed in a day;
//   never while an open report needs the asset as evidence or an unfinished job still reads it;
// - blobs (the bytes) no asset refers to any more: content-addressed bytes shared by several assets go
//   with the last of them. Deleting an account (cascade) leaves its blobs to this step too;
// - the narrative and prompts of finished preset jobs once their inputs' time is up (the job row keeps
//   timing, cost, the preset and the prompt instructions' version);
// - the prompt in resolved reports' snapshots, RESOLVED_REPORT_DAYS after the resolution.
import type { Db } from "./db.js";
import { tx } from "./db.js";
import { findPreset, presets } from "./presets.js";
import { blobKey, type Storage } from "./storage.js";

export interface Retention {
  inputHours: number; // inline inputs (the sketch) and the narrative / prompts on the job
  outputDays: number; // results
}

export const UPLOAD_GRACE_HOURS = 24; // an upload never completed
export const RESOLVED_REPORT_DAYS = 30;
const BLOB_GRACE_MS = 60 * 60 * 1000; // a blob row younger than this is left alone (its asset may be on its way)
const BATCH = 500;

const hoursFrom = (now: Date, hours: number) => new Date(now.getTime() + hours * 3600_000);
// When an asset of a preset job expires (null: the preset keeps it, or there is no such preset).
export function inputExpiry(presetId: string | null | undefined, now = new Date()): Date | null {
  const r = presetId ? findPreset(presetId)?.retention : undefined;
  return r ? hoursFrom(now, r.inputHours) : null;
}
export function outputExpiry(presetId: string | null | undefined, now = new Date()): Date | null {
  const r = presetId ? findPreset(presetId)?.retention : undefined;
  return r ? hoursFrom(now, r.outputDays * 24) : null;
}

// A job's workflow without the texts a user wrote (prompts, negative prompts).
export function scrubWorkflow(workflow: unknown): unknown {
  if (typeof workflow !== "object" || workflow === null) return workflow;
  const wf = workflow as { steps?: unknown };
  if (!Array.isArray(wf.steps)) return workflow;
  return {
    ...wf,
    steps: wf.steps.map((st) => {
      if (typeof st !== "object" || st === null) return st;
      const { prompt: _p, negative: _n, prompts: _ps, ...rest } = st as Record<string, unknown>;
      return rest;
    }),
  };
}

export function scrubPromptInfo(info: unknown): Record<string, unknown> | null {
  if (typeof info !== "object" || info === null) return null;
  const i = info as Record<string, unknown>;
  return { source: i.source, instructions: i.instructions, ...(i.fallback ? { fallback: i.fallback } : {}), scrubbed: true };
}

export interface CleanupResult {
  assets: number;
  blobs: number;
  jobs: number;
  reports: number;
}

export async function runRetention(db: Db, storage: Storage, now = new Date()): Promise<CleanupResult> {
  const out: CleanupResult = { assets: 0, blobs: 0, jobs: 0, reports: 0 };
  // One replica at a time.
  const lock = await db.connect();
  try {
    if (!(await lock.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(727004) AS ok")).rows[0]?.ok) return out;
    try {
      await cleanup(db, storage, now, out);
    } finally {
      await lock.query("SELECT pg_advisory_unlock(727004)");
    }
  } finally {
    lock.release();
  }
  return out;
}

async function cleanup(db: Db, storage: Storage, now: Date, out: CleanupResult) {
  // 1. Assets.
  for (;;) {
    const gone = await db.query<{ id: string; status: string }>(
      `DELETE FROM assets WHERE id IN (
         SELECT a.id FROM assets a
          WHERE (a.expires_at <= $1 OR a.status = 'removed' OR (a.status = 'uploading' AND a.created_at < $1 - make_interval(hours => $2)))
            AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.asset_id = a.id AND r.status = 'open')
            AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.state IN ('queued', 'leased', 'running') AND a.id = ANY(j.files))
          LIMIT $3)
       RETURNING id, status`,
      [now, UPLOAD_GRACE_HOURS, BATCH],
    );
    for (const a of gone.rows) if (a.status === "uploading") await storage.remove(`uploads/${a.id}`);
    out.assets += gone.rowCount ?? 0;
    if ((gone.rowCount ?? 0) < BATCH) break;
  }

  // 2. Bytes nothing refers to. Row and file go together; a row that gained a reference in the
  // meantime fails its foreign key and stays.
  for (;;) {
    const orphans = await db.query<{ sha256: string }>(
      `SELECT b.sha256 FROM blobs b
        WHERE b.created_at < $1
          AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.sha256 = b.sha256)
          AND NOT EXISTS (SELECT 1 FROM asset_files f WHERE f.sha256 = b.sha256)
        LIMIT $2`,
      [new Date(now.getTime() - BLOB_GRACE_MS), BATCH],
    );
    let removed = 0;
    for (const { sha256 } of orphans.rows) {
      const ok = await tx(db, async (c) => {
        try {
          const d = await c.query("DELETE FROM blobs WHERE sha256 = $1", [sha256]);
          return (d.rowCount ?? 0) > 0;
        } catch {
          return false;  // referenced again
        }
      });
      if (!ok) continue;
      await storage.remove(blobKey(sha256));
      removed++;
    }
    out.blobs += removed;
    if (orphans.rows.length < BATCH || removed === 0) break;
  }

  // 3. Narratives and prompts of finished preset jobs.
  for (const p of presets) {
    if (!p.retention) continue;
    for (;;) {
      const r = await db.query<{ id: string; prompt_info: unknown; workflow: unknown }>(
        `SELECT j.id, j.prompt_info, j.workflow FROM jobs j
          WHERE j.preset = $1 AND j.scrubbed_at IS NULL AND j.state IN ('succeeded', 'failed', 'cancelled')
            AND coalesce(j.finished_at, j.created_at) <= $2
            AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.job_id = j.id AND r.status = 'open')
          LIMIT $3`,
        [p.id, hoursFrom(now, -p.retention.inputHours), BATCH],
      );
      for (const j of r.rows)
        await db.query("UPDATE jobs SET prompt_info = $2, workflow = $3, scrubbed_at = $4 WHERE id = $1", [
          j.id,
          JSON.stringify(scrubPromptInfo(j.prompt_info)),
          JSON.stringify(scrubWorkflow(j.workflow)),
          now,
        ]);
      out.jobs += r.rows.length;
      if (r.rows.length < BATCH) break;
    }
  }

  // 4. The prompt in resolved reports (the reason, the note and the decision stay).
  const rep = await db.query(
    `UPDATE reports SET snapshot = (snapshot - 'prompt' - 'workflow') || '{"scrubbed": true}'::jsonb
      WHERE status <> 'open' AND resolved_at <= $1 AND NOT (snapshot ? 'scrubbed')`,
    [new Date(now.getTime() - RESOLVED_REPORT_DAYS * 86400_000)],
  );
  out.reports += rep.rowCount ?? 0;
}
