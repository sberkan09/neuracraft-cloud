// Latency per preset (issue #20): percentiles of where finished jobs' time went, for operators
// (cli/latency.js). Submission to finish ("total"), waiting for a worker ("queue"), and the worker's
// model loading and running; "warm" is the share of jobs whose worker already held the models.
import type { Db } from "./db.js";

export interface LatencyRow {
  preset: string;
  variant: string | null;
  jobs: number;
  warm: number; // share 0..1
  total: { p50: number; p95: number };
  queue: { p50: number; p95: number };
  load: { p50: number; p95: number };
  run: { p50: number; p95: number };
}

export async function latencyStats(db: Db, since: Date): Promise<LatencyRow[]> {
  const pct = (k: string) =>
    `percentile_cont(0.5) WITHIN GROUP (ORDER BY (timings ->> '${k}')::float8) AS ${k}_p50,
     percentile_cont(0.95) WITHIN GROUP (ORDER BY (timings ->> '${k}')::float8) AS ${k}_p95`;
  const r = await db.query<Record<string, string | number | null>>(
    `SELECT preset, preset_variant, count(*) AS jobs, avg(CASE WHEN (timings ->> 'warm')::boolean THEN 1 ELSE 0 END) AS warm,
            ${pct("totalSeconds")}, ${pct("queueSeconds")}, ${pct("loadSeconds")}, ${pct("runSeconds")}
       FROM jobs
      WHERE preset IS NOT NULL AND state = 'succeeded' AND finished_at >= $1 AND timings ? 'totalSeconds'
      GROUP BY preset, preset_variant ORDER BY preset, preset_variant`,
    [since],
  );
  const n = (v: unknown) => (v === null || v === undefined ? 0 : Math.round(Number(v) * 1000) / 1000);
  const pair = (row: Record<string, unknown>, k: string) => ({ p50: n(row[`${k}_p50`.toLowerCase()]), p95: n(row[`${k}_p95`.toLowerCase()]) });
  return r.rows.map((row) => ({
    preset: String(row.preset),
    variant: (row.preset_variant as string | null) ?? null,
    jobs: Number(row.jobs),
    warm: n(row.warm),
    total: pair(row, "totalSeconds"),
    queue: pair(row, "queueSeconds"),
    load: pair(row, "loadSeconds"),
    run: pair(row, "runSeconds"),
  }));
}
