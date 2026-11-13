// The operator console's reads (routes/admin.ts, apps/web/src/pages/Admin.tsx).
//
// NeuraCraft Cloud serves many accounts; a partner such as GM Cebi is one of them, with its own end
// users. Operators see every account's metadata: jobs, states, timings, GPUs, costs, sessions,
// capacity. Content (sketches, hints, results, narratives, prompts) only for an account that granted
// support access until a date (`support_access_until`), or for a job under an open report; each
// content view is logged in moderation_log ("view_content").
import type pg from "pg";
import { podsSpentSince } from "./capacity.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { blobKey, type Storage } from "./storage.js";

type Q = Db | pg.PoolClient;
const URL_SECONDS = 900;

// OPERATOR_SEES_ALL_CONTENT (config.operatorSeesAllContent): during a closed beta whose testers
// agreed, operators see every account's content without support access. Views are still logged.
let seeAll = false;
export function setOperatorSeesAllContent(on: boolean) {
  seeAll = on;
}

export async function overview(db: Db, config: Config) {
  const now = new Date();
  const [pods, sessions, jobs, events, reports, day, month] = await Promise.all([
    db.query(
      `SELECT id, provider, gpu_type, region, state, price_per_hour::float8 AS price_per_hour, requested_at, ready_at, drain_at, error
         FROM gpu_pods WHERE state IN ('requested', 'starting', 'running', 'draining') ORDER BY requested_at DESC`,
    ),
    db.query(
      `SELECT u.email, s.user_id, count(*)::int AS open, max(s.last_seen_at) AS last_seen
         FROM app_sessions s JOIN users u ON u.id = s.user_id WHERE s.closed_at IS NULL GROUP BY u.email, s.user_id ORDER BY open DESC`,
    ),
    db.query(
      `SELECT u.email, j.user_id, count(*)::int AS total,
              count(*) FILTER (WHERE j.state = 'succeeded')::int AS succeeded,
              count(*) FILTER (WHERE j.state = 'failed')::int AS failed,
              count(*) FILTER (WHERE j.state IN ('queued', 'leased', 'running'))::int AS active
         FROM jobs j JOIN users u ON u.id = j.user_id WHERE j.created_at > now() - interval '24 hours'
        GROUP BY u.email, j.user_id ORDER BY total DESC`,
    ),
    db.query("SELECT at, kind, pod_id, detail FROM capacity_events ORDER BY at DESC LIMIT 30"),
    db.query<{ n: number }>("SELECT count(*)::int AS n FROM reports WHERE status = 'open'"),
    podsSpentSince(db, "day", now),
    podsSpentSince(db, "month", now),
  ]);
  const cap = config.capacity;
  return {
    capacity: {
      provider: cap.provider || null,
      maxPods: cap.maxPods,
      pods: pods.rows,
      spend: { todayUsd: round(day), monthUsd: round(month), dailyBudgetUsd: cap.dailyBudgetUsd, monthlyBudgetUsd: Number.isFinite(cap.monthlyBudgetUsd) ? cap.monthlyBudgetUsd : null },
    },
    sessions: sessions.rows,
    jobs24h: jobs.rows,
    events: events.rows,
    openReports: reports.rows[0]!.n,
    seeAllContent: seeAll,
  };
}
const round = (x: number) => Math.round(x * 10000) / 10000;

export async function accounts(db: Db) {
  const r = await db.query(
    `SELECT u.id, u.email, u.plan, u.created_at, u.operator, u.flagged_at, u.support_access_until,
            (SELECT coalesce(sum(amount), 0)::float8 / 1000 FROM ledger l WHERE l.user_id = u.id) AS credits,
            p.user_id IS NOT NULL AS partner,
            (SELECT count(*)::int FROM partner_end_users e WHERE e.user_id = u.id) AS signed_in_end_users,
            (SELECT count(*)::int FROM jobs j WHERE j.user_id = u.id AND j.created_at > now() - interval '7 days') AS jobs_7d,
            (SELECT max(created_at) FROM jobs j WHERE j.user_id = u.id) AS last_job_at
       FROM users u LEFT JOIN partners p ON p.user_id = u.id
      ORDER BY last_job_at DESC NULLS LAST, u.created_at DESC LIMIT 500`,
  );
  return r.rows;
}

export async function account(db: Db, id: string) {
  const u = await db.query(
    `SELECT u.id, u.email, u.plan, u.locale, u.created_at, u.operator, u.flagged_at, u.flag_note, u.support_access_until, u.support_access_note,
            (SELECT coalesce(sum(amount), 0)::float8 / 1000 FROM ledger l WHERE l.user_id = u.id) AS credits
       FROM users u WHERE u.id = $1`,
    [id],
  );
  if (!u.rows[0]) return null;
  const [partner, clients, tokens, endUsers, daily, ledger] = await Promise.all([
    db.query("SELECT end_user_daily_jobs, partner_daily_jobs, quota_timezone, allowance_required, require_end_user_tokens, max_sessions FROM partners WHERE user_id = $1", [id]),
    db.query("SELECT id, name, enabled, created_at FROM partner_clients WHERE user_id = $1 ORDER BY created_at", [id]),
    db.query("SELECT id, kind, name, prefix, scopes, created_at, last_used_at, expires_at, revoked_at FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC", [id]),
    db.query(
      `SELECT e.end_user, e.created_at, e.last_seen_at, e.blocked_at,
              (SELECT count(*)::int FROM jobs j WHERE j.user_id = e.user_id AND j.end_user = e.end_user AND j.created_at > now() - interval '24 hours') AS jobs_24h,
              (SELECT count(*)::int FROM jobs j WHERE j.user_id = e.user_id AND j.end_user = e.end_user) AS jobs_total
         FROM partner_end_users e WHERE e.user_id = $1 ORDER BY e.last_seen_at DESC LIMIT 200`,
      [id],
    ),
    db.query(
      `SELECT date_trunc('day', created_at) AS day, count(*)::int AS jobs, count(*) FILTER (WHERE state = 'failed')::int AS failed,
              count(DISTINCT end_user)::int AS end_users
         FROM jobs WHERE user_id = $1 AND created_at > now() - interval '14 days' GROUP BY 1 ORDER BY 1`,
      [id],
    ),
    db.query("SELECT kind, amount::float8 / 1000 AS credits, job_id, reference, created_at FROM ledger WHERE user_id = $1 AND kind NOT IN ('reserve', 'release') ORDER BY id DESC LIMIT 20", [id]),
  ]);
  return { account: u.rows[0], partner: partner.rows[0] ?? null, clients: clients.rows, tokens: tokens.rows, endUsers: endUsers.rows, daily: daily.rows, ledger: ledger.rows };
}

export interface JobFilter {
  account?: string;
  endUser?: string;
  preset?: string;
  state?: string;
  regions?: boolean;
  before?: Date;
  limit: number;
}

interface JobRow {
  id: string; user_id: string; email: string; end_user: string | null; preset: string | null; preset_variant: string | null; state: string;
  error: { code?: string } | null; created_at: Date; claimed_at: Date | null; started_at: Date | null; finished_at: Date | null;
  worker_seconds: number | null; timings: unknown; workflow: { steps?: Record<string, unknown>[] }; prompt_info: unknown; moderation: unknown;
  scrubbed_at: Date | null; gpu_type: string | null; region: string | null; charged: number | null; support: boolean; open_report: boolean;
}

const JOB_SELECT = `SELECT j.id, j.user_id, u.email, j.end_user, j.preset, j.preset_variant, j.state, j.error, j.created_at, j.claimed_at, j.started_at,
       j.finished_at, j.worker_seconds, j.timings, j.workflow, j.prompt_info, j.moderation, j.scrubbed_at,
       uj.gpu_type, p.region,
       (SELECT -sum(amount)::float8 / 1000 FROM ledger l WHERE l.job_id = j.id AND l.kind = 'settle') AS charged,
       coalesce(u.support_access_until > now(), false) AS support,
       EXISTS (SELECT 1 FROM reports r WHERE r.job_id = j.id AND r.status = 'open') AS open_report
  FROM jobs j JOIN users u ON u.id = j.user_id
  LEFT JOIN usage_jobs uj ON uj.job_id = j.id LEFT JOIN gpu_pods p ON p.id = uj.pod_id`;

const drawStep = (j: JobRow) => (j.workflow.steps ?? []).find((s) => s.op === "txt2img" || s.op === "img2img");

// The list: metadata for every job; content links only where allowed (and then logged).
export async function jobs(db: Db, storage: Storage, operator: string, f: JobFilter) {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => (params.push(v), `$${params.length}`);
  if (f.account) where.push(`j.user_id = ${p(f.account)}`);
  if (f.endUser) where.push(`j.end_user = ${p(f.endUser)}`);
  if (f.preset) where.push(`j.preset = ${p(f.preset)}`);
  if (f.state) where.push(`j.state = ${p(f.state)}`);
  if (f.regions !== undefined) where.push(`${f.regions ? "" : "NOT "}jsonb_path_exists(j.workflow, '$.steps[*] ? (@.op == "img2img")')`);
  if (f.before) where.push(`j.created_at < ${p(f.before)}`);
  const r = await db.query<JobRow>(
    `${JOB_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY j.created_at DESC LIMIT ${p(f.limit)}`,
    params,
  );
  const out = [];
  for (const j of r.rows) out.push(await jobView(db, storage, operator, j, false));
  return out;
}

export async function job(db: Db, storage: Storage, operator: string, id: string) {
  const r = await db.query<JobRow>(`${JOB_SELECT} WHERE j.id = $1`, [id]);
  return r.rows[0] ? jobView(db, storage, operator, r.rows[0], true) : null;
}

async function jobView(db: Db, storage: Storage, operator: string, j: JobRow, detail: boolean) {
  const draw = drawStep(j);
  const allowed = j.support ? "support_access" : j.open_report ? "report" : seeAll ? "beta" : null;
  const seconds = (a: Date | null, b: Date | null) => (a && b ? Math.round((b.getTime() - a.getTime()) / 100) / 10 : null);
  const view: Record<string, unknown> = {
    id: j.id,
    account: { id: j.user_id, email: j.email },
    endUser: j.end_user,
    preset: j.preset,
    mode: j.preset_variant,
    state: j.state,
    error: j.error?.code ?? null,
    createdAt: j.created_at,
    finishedAt: j.finished_at,
    queueSeconds: seconds(j.created_at, j.claimed_at ?? j.started_at),
    runSeconds: seconds(j.started_at ?? j.claimed_at, j.finished_at),
    workerSeconds: j.worker_seconds,
    gpu: j.gpu_type ? { type: j.gpu_type, region: j.region } : null,
    charged: j.charged,
    regions: draw?.op === "img2img",
    generation: draw ? { op: draw.op, steps: draw.steps, strength: draw.strength ?? null, control_scale: draw.control_scale ?? null, sampler: draw.sampler, seed: draw.seed } : null,
    content: allowed,
  };
  if (detail) Object.assign(view, { timings: j.timings, moderation: j.moderation, textsScrubbed: j.scrubbed_at !== null });
  if (!allowed) return view;

  const pictures: Record<string, string> = {};
  for (const st of j.workflow.steps ?? []) {
    const m = st.op === "load" && typeof st.path === "string" ? /^asset:(.+)$/.exec(st.path) : null;
    const name = st.out === "sketch" ? "sketch" : st.out === "hint" ? "hint" : null;
    if (m && name) {
      const url = await assetUrl(db, storage, m[1]!);
      if (url) pictures[name] = url;
    }
  }
  const outs = await db.query<{ asset_id: string }>("SELECT asset_id FROM job_outputs WHERE job_id = $1 ORDER BY name LIMIT 1", [j.id]);
  if (outs.rows[0]) {
    const url = await assetUrl(db, storage, outs.rows[0].asset_id);
    if (url) pictures.result = url;
  }
  view.pictures = pictures;
  const pi = j.prompt_info as { narrative?: string; source?: string } | null;
  view.prompt = typeof draw?.prompt === "string" ? draw.prompt : null;
  view.narrative = pi && typeof pi.narrative === "string" ? pi.narrative : null;
  await logView(db, operator, j.user_id, j.id, allowed);
  return view;
}

async function assetUrl(q: Q, storage: Storage, assetId: string): Promise<string | null> {
  const a = await q.query<{ sha256: string | null; name: string }>("SELECT sha256, name FROM assets WHERE id = $1 AND status <> 'removed'", [assetId]);
  const row = a.rows[0];
  return row?.sha256 ? storage.downloadUrl(blobKey(row.sha256), URL_SECONDS, row.name) : null;
}

// One entry per operator and job an hour: a list reloads often, and the log is read by people.
async function logView(q: Q, operator: string, userId: string, jobId: string, why: string) {
  await q.query(
    `INSERT INTO moderation_log (operator, action, user_id, job_id, note)
     SELECT $1, 'view_content', $2, $3, $4
      WHERE NOT EXISTS (SELECT 1 FROM moderation_log WHERE action = 'view_content' AND job_id = $3 AND operator = $1 AND at > now() - interval '1 hour')`,
    [operator, userId, jobId, why],
  );
}

export async function logAction(q: Q, operator: string, action: string, userId: string, note: string | null) {
  await q.query("INSERT INTO moderation_log (operator, action, user_id, note) VALUES ($1, $2, $3, $4)", [operator, action, userId, note]);
}

export async function auditLog(db: Db, limit = 100) {
  const r = await db.query(
    `SELECT m.at, m.operator, m.action, m.user_id, u.email, m.job_id, m.report_id, m.note
       FROM moderation_log m LEFT JOIN users u ON u.id = m.user_id ORDER BY m.id DESC LIMIT $1`,
    [limit],
  );
  return r.rows;
}
