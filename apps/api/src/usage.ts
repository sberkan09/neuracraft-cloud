// The usage log's export (013_usage_log.sql, docs/USAGE_LOG.md): what ran in a period, on which GPUs,
// what those cost, how busy they were and how it felt to users; for questions such as "would a hosted
// service (fal.ai, ...) have been cheaper for these jobs?". Used by cli/usage-report.ts and
// GET /v1/admin/usage-report. Nothing in it identifies a person.
import type { Db } from "./db.js";

export interface UsageReport {
  summary: Record<string, unknown>;
  files: { "jobs.csv": string; "pods.csv": string; "sessions.csv": string; "events.csv": string };
}

export type Row = Record<string, unknown>;
const cell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: Row[]) => {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]!);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
};
const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!.toFixed(2));
};
const stats = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p90: pct(xs, 90), p95: pct(xs, 95), max: xs.length ? Number(Math.max(...xs).toFixed(2)) : null });
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));


export async function usageReport(db: Db, from: Date, to: Date, fixedPerMonth = 0): Promise<UsageReport> {
  const range = [from, to];

  const jobs = (
    await db.query<Row>(
      `SELECT job_id, session_id, preset, preset_variant, latency, worker_class, state, error_code, attempts,
              op, width, height, steps, sampler, controlnet, lora, models, prompt_source,
              pod_id, gpu_type, price_per_hour, created_at, claimed_at, started_at, finished_at,
              (timings->>'warm')::boolean AS warm,
              round(extract(epoch FROM coalesce(claimed_at, started_at) - created_at)::numeric, 3) AS queue_s,
              (timings->>'fetchSeconds')::float8 AS fetch_s, (timings->>'loadSeconds')::float8 AS load_s,
              (timings->>'runSeconds')::float8 AS run_s, (timings->>'uploadSeconds')::float8 AS upload_s,
              round(extract(epoch FROM finished_at - coalesce(started_at, claimed_at))::numeric, 3) AS gpu_busy_s,
              round(extract(epoch FROM finished_at - created_at)::numeric, 3) AS end_to_end_s,
              worker_seconds
         FROM usage_jobs WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at`,
      range,
    )
  ).rows;

  const pods = (
    await db.query<Row>(
      `SELECT p.id AS pod_id, p.provider, p.gpu_type, p.region, p.price_per_hour, p.state, p.error,
              p.requested_at, p.ready_at, w.warmed_at, p.drain_at, p.stopped_at,
              round(extract(epoch FROM p.ready_at - p.requested_at)::numeric, 1) AS to_worker_s,
              round(extract(epoch FROM w.warmed_at - p.requested_at)::numeric, 1) AS to_warm_s,
              round(extract(epoch FROM least(coalesce(p.stopped_at, now()), $2) - greatest(p.requested_at, $1))::numeric, 1) AS billed_s_in_period,
              round((p.price_per_hour * extract(epoch FROM least(coalesce(p.stopped_at, now()), $2) - greatest(p.requested_at, $1)) / 3600)::numeric, 4) AS cost_usd_in_period,
              (SELECT count(*) FROM usage_jobs u WHERE u.pod_id = p.id) AS jobs,
              (SELECT round(sum(extract(epoch FROM u.finished_at - coalesce(u.started_at, u.claimed_at)))::numeric, 1) FROM usage_jobs u WHERE u.pod_id = p.id) AS busy_s,
              (SELECT detail->>'reason' FROM capacity_events e WHERE e.pod_id = p.id AND e.kind = 'pod.stopped' ORDER BY at DESC LIMIT 1) AS stop_reason
         FROM gpu_pods p LEFT JOIN workers w ON w.id = p.worker_id
        WHERE p.requested_at < $2 AND coalesce(p.stopped_at, now()) >= $1 ORDER BY p.requested_at`,
      range,
    )
  ).rows;

  const sessions = (
    await db.query<Row>(
      `WITH s AS (
         SELECT session_id, started_at, closed_at, close_reason FROM usage_sessions
         UNION ALL
         SELECT id, started_at, NULL, NULL FROM app_sessions WHERE closed_at IS NULL)
       SELECT s.session_id, s.started_at, s.closed_at, s.close_reason,
              round(extract(epoch FROM coalesce(s.closed_at, now()) - s.started_at)::numeric / 60, 1) AS minutes,
              count(u.job_id) AS jobs, count(u.job_id) FILTER (WHERE u.state = 'succeeded') AS succeeded,
              round(extract(epoch FROM min(u.created_at) - s.started_at)::numeric, 1) AS first_job_after_s,
              (array_agg(u.end_to_end ORDER BY u.created_at))[1] AS first_job_end_to_end_s
         FROM s LEFT JOIN (SELECT *, round(extract(epoch FROM finished_at - created_at)::numeric, 2) AS end_to_end FROM usage_jobs) u ON u.session_id = s.session_id
        WHERE s.started_at >= $1 AND s.started_at < $2
        GROUP BY s.session_id, s.started_at, s.closed_at, s.close_reason ORDER BY s.started_at`,
      range,
    )
  ).rows;

  const events = (await db.query<Row>("SELECT at, kind, pod_id, detail FROM capacity_events WHERE at >= $1 AND at < $2 ORDER BY at", range)).rows;

  // Summary.
  const ok = jobs.filter((j) => j.state === "succeeded");
  const interactive = jobs.filter((j) => j.latency === "interactive");
  const e2e = (xs: Row[]) => xs.map((j) => num(j.end_to_end_s)).filter((x): x is number => x !== null);
  const gpuCost = pods.reduce((a, p) => a + (num(p.cost_usd_in_period) ?? 0), 0);
  const billedH = pods.reduce((a, p) => a + (num(p.billed_s_in_period) ?? 0), 0) / 3600;
  const busyH = pods.reduce((a, p) => a + (num(p.busy_s) ?? 0), 0) / 3600;
  const days = (to.getTime() - from.getTime()) / 86400_000;
  const fixed = (fixedPerMonth * days) / 30.44;
  const count = (xs: Row[], key: (r: Row) => unknown) => xs.reduce<Record<string, number>>((m, r) => ((m[String(key(r) ?? "none")] = (m[String(key(r) ?? "none")] ?? 0) + 1), m), {});
  const hourTr = (d: unknown) => (new Date(d as Date).getUTCHours() + 3) % 24; // Europe/Istanbul (UTC+3, no DST)
  const perMinute = count(jobs, (j) => (j.created_at as Date).toISOString().slice(0, 16));
  const variants = Object.values(
    ok.reduce<Record<string, Row>>((m, j) => {
      const k = [j.preset, j.preset_variant, j.op, j.width, j.height, j.steps, j.sampler, j.controlnet, j.lora].join("|");
      const v = (m[k] ??= { preset: j.preset, variant: j.preset_variant, op: j.op, width: j.width, height: j.height, steps: j.steps, sampler: j.sampler, controlnet: j.controlnet, lora: j.lora, images: 0, runSeconds: [] as number[] });
      v.images = (v.images as number) + 1;
      if (num(j.run_s) !== null) (v.runSeconds as number[]).push(num(j.run_s)!);
      return m;
    }, {}),
  ).map((v) => ({ ...v, runSeconds: stats(v.runSeconds as number[]) }));

  const summary = {
    period: { from: from.toISOString(), to: to.toISOString(), days: Number(days.toFixed(2)) },
    jobs: {
      total: jobs.length,
      succeeded: ok.length,
      byState: count(jobs, (j) => j.state),
      byError: count(jobs.filter((j) => j.error_code), (j) => j.error_code),
      byVariant: count(jobs, (j) => `${j.preset}/${j.preset_variant}`),
      promptSource: count(jobs, (j) => j.prompt_source),
      perDay: count(jobs, (j) => (j.created_at as Date).toISOString().slice(0, 10)),
      perHourIstanbul: count(jobs, (j) => hourTr(j.created_at)),
      peakPerMinute: Math.max(0, ...Object.values(perMinute)),
    },
    // What a hosted service would have to do: price each line with its per-image / per-megapixel /
    // per-GPU-second rate for the same model setup (SD 1.5 + ControlNet scribble (+ LCM LoRA)).
    forHostedComparison: variants,
    gpu: {
      pods: pods.length,
      byGpuType: count(pods, (p) => p.gpu_type),
      billedHours: Number(billedH.toFixed(3)),
      busyHours: Number(busyH.toFixed(3)),
      utilization: billedH ? Number((busyH / billedH).toFixed(3)) : null,
      costUsd: Number(gpuCost.toFixed(2)),
      idleCostUsd: billedH ? Number((gpuCost * (1 - busyH / billedH)).toFixed(2)) : null,
      podToWorkerSeconds: stats(pods.map((p) => num(p.to_worker_s)).filter((x): x is number => x !== null)),
      podToWarmSeconds: stats(pods.map((p) => num(p.to_warm_s)).filter((x): x is number => x !== null)),
      rentFailures: events.filter((e) => e.kind === "pod.rent_failed").length,
      budgetBlocks: events.filter((e) => e.kind === "capacity.blocked" && String((e.detail as Row)?.reason ?? "").includes("budget")).length,
      stopReasons: count(pods.filter((p) => p.stop_reason), (p) => p.stop_reason),
    },
    cost: {
      gpuUsd: Number(gpuCost.toFixed(2)),
      fixedUsd: Number(fixed.toFixed(2)),
      totalUsd: Number((gpuCost + fixed).toFixed(2)),
      gpuUsdPerSucceededImage: ok.length ? Number((gpuCost / ok.length).toFixed(4)) : null,
      totalUsdPerSucceededImage: ok.length ? Number(((gpuCost + fixed) / ok.length).toFixed(4)) : null,
    },
    latency: {
      interactiveEndToEndSeconds: stats(e2e(interactive.filter((j) => j.state === "succeeded"))),
      warm: stats(e2e(interactive.filter((j) => j.state === "succeeded" && j.warm === true))),
      cold: stats(e2e(interactive.filter((j) => j.state === "succeeded" && j.warm === false))),
      queueSeconds: stats(interactive.map((j) => num(j.queue_s)).filter((x): x is number => x !== null)),
    },
    sessions: {
      total: sessions.length,
      withJobs: sessions.filter((s) => Number(s.jobs) > 0).length,
      jobsPerSession: stats(sessions.map((s) => Number(s.jobs))),
      minutes: stats(sessions.map((s) => num(s.minutes)).filter((x): x is number => x !== null)),
      firstJobAfterSeconds: stats(sessions.map((s) => num(s.first_job_after_s)).filter((x): x is number => x !== null)),
      firstJobEndToEndSeconds: stats(sessions.map((s) => num(s.first_job_end_to_end_s)).filter((x): x is number => x !== null)),
      closeReasons: count(sessions, (s) => s.close_reason ?? "open"),
    },
  };

  return { summary, files: { "jobs.csv": csv(jobs), "pods.csv": csv(pods), "sessions.csv": csv(sessions), "events.csv": csv(events) } };
}
