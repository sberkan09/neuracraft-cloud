// Moderation (issue #18, ARCHITECTURE.md "Safety and abuse").
//
// Output classifier: every preset workflow ends with the engine's `classify` step, which runs an
// ONNX content classifier (catalog slug "nsfw-classifier") on the result and writes its scores to
// moderation.json. When the worker completes the job, the scores decide: a flagged result is held
// (never downloadable), the job fails with content.flagged, the reservation is given back, and a
// report row puts it in front of an operator. A preset job without scores is held the same way
// (content.unchecked): nothing is released unchecked.
//
// Reports: the owner of a generated picture reports it (POST /v1/assets/:id/report); the report keeps
// a snapshot of the job (preset, prompt, inputs, scores) for the review.
//
// Review: operators list reports, look at the inputs and the output, and dismiss the report, remove
// the asset or flag the account (cli/review.ts); every action is logged in moderation_log.
import type pg from "pg";
import type { Db } from "./db.js";
import { blobKey, type Storage } from "./storage.js";

type Q = Db | pg.PoolClient;

export const MODERATION_FILE = "moderation.json";
export const CLASSIFIER_SLUG = "nsfw-classifier";
export const REPORT_REASONS = ["sexual", "violence_gore", "hate", "minor_safety", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export interface Verdict {
  checked: boolean; // scores were found and read
  flagged: boolean;
  scores?: Record<string, number>;
  model?: string;
  reason?: string; // why it is flagged or unchecked
}

export interface StoredOutput {
  name: string;
  sha256: string;
  bytes: number;
  contentType?: string;
}

export interface Moderator {
  judge(outputs: StoredOutput[], storage: Storage): Promise<Verdict>;
}

// "nsfw=0.5,violence=0.8" -> thresholds per label: a score at or above one flags the result.
export function parseThresholds(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of text.split(",")) {
    const [label, value] = part.split("=").map((x) => x.trim());
    const v = Number(value);
    if (label && Number.isFinite(v) && v > 0 && v <= 1) out[label] = v;
  }
  return out;
}

// Reads the scores the engine's classify step wrote (moderation.json among the outputs).
export class EngineModerator implements Moderator {
  constructor(private readonly thresholds: Record<string, number>) {}

  async judge(outputs: StoredOutput[], storage: Storage): Promise<Verdict> {
    const file = outputs.find((o) => o.name === MODERATION_FILE);
    if (!file) return { checked: false, flagged: false, reason: "no classifier scores" };
    if (file.bytes > 256 * 1024) return { checked: false, flagged: false, reason: "classifier scores too large" };
    let doc: { model?: unknown; scores?: unknown };
    try {
      doc = JSON.parse((await storage.get(blobKey(file.sha256))).toString("utf8"));
    } catch {
      return { checked: false, flagged: false, reason: "classifier scores unreadable" };
    }
    if (typeof doc.scores !== "object" || doc.scores === null) return { checked: false, flagged: false, reason: "classifier scores missing" };
    const scores: Record<string, number> = {};
    for (const [k, v] of Object.entries(doc.scores as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v)) scores[k.slice(0, 40)] = v;
    const known = Object.keys(this.thresholds).filter((l) => l in scores);
    if (!known.length) return { checked: false, flagged: false, scores, reason: "no score for a moderated label" };
    const over = known.filter((l) => scores[l]! >= this.thresholds[l]!);
    return {
      checked: true,
      flagged: over.length > 0,
      scores,
      model: typeof doc.model === "string" ? doc.model.slice(0, 100) : undefined,
      ...(over.length ? { reason: over.join(", ") } : {}),
    };
  }
}

// What a review needs about the job that made an asset (kept with the report).
export async function jobSnapshot(q: Q, jobId: string | null): Promise<Record<string, unknown>> {
  if (!jobId) return {};
  const r = await q.query<{ preset: string | null; preset_version: number | null; prompt_info: unknown; moderation: unknown; files: string[]; workflow: unknown; created_at: Date }>(
    "SELECT preset, preset_version, prompt_info, moderation, files, workflow, created_at FROM jobs WHERE id = $1",
    [jobId],
  );
  const j = r.rows[0];
  if (!j) return {};
  const inputs = await q.query<{ id: string; name: string; sha256: string | null }>(
    "SELECT id, name, sha256 FROM assets WHERE id = ANY($1::uuid[]) AND kind = 'input'",
    [j.files],
  );
  return {
    preset: j.preset,
    presetVersion: j.preset_version,
    prompt: j.prompt_info,
    moderation: j.moderation,
    inputs: inputs.rows.map((i) => ({ assetId: i.id, name: i.name, sha256: i.sha256 })),
    workflow: j.preset ? undefined : j.workflow, // a preset's workflow is known from its version
    jobCreatedAt: j.created_at.toISOString(),
  };
}

// The classifier held these outputs: one report each, for the review queue.
export async function reportHeld(c: pg.PoolClient, jobId: string, ownerId: string, assetIds: string[], verdict: Verdict): Promise<void> {
  const snapshot = await jobSnapshot(c, jobId);
  for (const id of assetIds)
    await c.query(
      "INSERT INTO reports (asset_id, job_id, owner_id, reporter_id, source, reason, note, snapshot) VALUES ($1, $2, $3, NULL, 'classifier', 'classifier', $4, $5)",
      [id, jobId, ownerId, verdict.reason ?? null, JSON.stringify(snapshot)],
    );
}

// ---- The operators' side (cli/review.ts) ----

export interface ReportRow {
  id: string;
  asset_id: string | null; // null once the asset was cleaned up (a resolved report)
  job_id: string | null;
  owner_id: string | null;
  owner_email: string | null;
  owner_flagged: Date | null;
  source: string;
  reason: string;
  note: string | null;
  snapshot: Record<string, unknown>;
  status: string;
  created_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  asset_status: string | null;
  asset_name: string | null;
  sha256: string | null;
}

const REPORT_SELECT = `SELECT r.*, u.email AS owner_email, u.flagged_at AS owner_flagged, a.status AS asset_status, a.name AS asset_name, a.sha256
  FROM reports r LEFT JOIN assets a ON a.id = r.asset_id LEFT JOIN users u ON u.id = r.owner_id`;

export async function listReports(q: Q, opts: { status?: "open" | "all"; limit?: number } = {}): Promise<ReportRow[]> {
  const r = await q.query<ReportRow>(
    `${REPORT_SELECT} WHERE ($1::text = 'all' OR r.status = 'open') ORDER BY r.created_at LIMIT $2`,
    [opts.status ?? "open", Math.min(Math.max(opts.limit ?? 50, 1), 500)],
  );
  return r.rows;
}

// A report with short-lived links to its output and inputs (signed storage URLs, `seconds` long).
export async function showReport(q: Q, storage: Storage, id: string, seconds = 3600) {
  const r = await q.query<ReportRow>(`${REPORT_SELECT} WHERE r.id = $1`, [id]);
  const row = r.rows[0];
  if (!row) return null;
  const others = await q.query<{ n: string }>("SELECT count(*) AS n FROM reports WHERE asset_id = $1", [row.asset_id ?? "00000000-0000-0000-0000-000000000000"]);
  const inputs = (row.snapshot.inputs as { assetId: string; name: string; sha256: string | null }[] | undefined) ?? [];
  return {
    report: row,
    reportsOnAsset: Number(others.rows[0]!.n),
    output: row.sha256 && row.asset_status !== "removed" ? storage.downloadUrl(blobKey(row.sha256), seconds, row.asset_name ?? undefined) : null,
    inputs: inputs.map((i) => ({ ...i, url: i.sha256 ? storage.downloadUrl(blobKey(i.sha256), seconds, i.name) : null })),
  };
}

async function log(c: Q, operator: string, action: string, report: ReportRow, note?: string, userId?: string | null) {
  await c.query("INSERT INTO moderation_log (operator, action, report_id, asset_id, user_id, note) VALUES ($1, $2, $3, $4, $5, $6)", [
    operator,
    action,
    report.id,
    report.asset_id,
    userId ?? report.owner_id,
    note ?? null,
  ]);
}

async function openReport(c: Q, id: string): Promise<ReportRow> {
  const r = await c.query<ReportRow>(`${REPORT_SELECT} WHERE r.id = $1`, [id]);
  if (!r.rows[0]) throw new Error(`no report ${id}`);
  return r.rows[0];
}

// Nothing wrong: the report is closed, the asset stays as it is (a held output stays held).
export async function dismissReport(c: Q, id: string, operator: string, note?: string): Promise<void> {
  const rep = await openReport(c, id);
  if (rep.status !== "open") throw new Error(`report ${id} is already ${rep.status}`);
  await c.query("UPDATE reports SET status = 'dismissed', resolved_at = now(), resolved_by = $2 WHERE id = $1", [id, operator]);
  await log(c, operator, "dismiss", rep, note);
}

// The asset is removed for its owner (status removed: no listing, no download) and every open report
// on it is closed. The bytes go with the retention cleanup once nothing refers to them.
export async function removeReportedAsset(c: Q, id: string, operator: string, note?: string): Promise<void> {
  const rep = await openReport(c, id);
  if (!rep.asset_id) throw new Error(`report ${id}: the asset is already gone`);
  await c.query("UPDATE assets SET status = 'removed' WHERE id = $1", [rep.asset_id]);
  await c.query("UPDATE reports SET status = 'removed', resolved_at = now(), resolved_by = $2 WHERE asset_id = $1 AND status = 'open'", [rep.asset_id, operator]);
  await log(c, operator, "remove_asset", rep, note);
}

// The asset's owner is flagged for attention (no automatic effect).
export async function flagAccount(c: Q, id: string, operator: string, note?: string): Promise<void> {
  const rep = await openReport(c, id);
  if (!rep.owner_id) throw new Error(`report ${id} has no owner`);
  await c.query("UPDATE users SET flagged_at = coalesce(flagged_at, now()), flag_note = coalesce($2, flag_note) WHERE id = $1", [rep.owner_id, note ?? null]);
  await log(c, operator, "flag_account", rep, note);
}
