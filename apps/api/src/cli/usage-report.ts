// Exports the usage log (013_usage_log.sql, docs/USAGE_LOG.md) for a period: what ran, on which GPUs,
// what those cost, how busy they were, and how it felt to users. It is meant for questions such as
// "would a hosted service (fal.ai, ...) have been cheaper for these jobs?".
//   node dist/src/cli/usage-report.js [--from 2026-11-10] [--to 2026-12-10] [--out usage/] [--fixed-usd-month 10]
// Writes jobs.csv, pods.csv, sessions.csv, events.csv and summary.json into --out. Nothing in them
// identifies a person: no accounts, end-user ids, narratives, prompts or pictures.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { connect, migrate } from "../db.js";
import { usageReport } from "../usage.js";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const to = opt("to") ? new Date(opt("to")!) : new Date();
const from = opt("from") ? new Date(opt("from")!) : new Date(to.getTime() - 30 * 86400_000);
const fixedPerMonth = Number(opt("fixed-usd-month") ?? 0);
if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || !(from < to) || Number.isNaN(fixedPerMonth)) {
  console.error("usage: usage-report [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--out DIR] [--fixed-usd-month N]");
  process.exit(2);
}
const day = (d: Date) => d.toISOString().slice(0, 10);
const out = opt("out") ?? `usage-${day(from)}-${day(to)}`;

const config = loadConfig();
const db = connect(config.databaseUrl);
try {
  await migrate(db, config.migrationsDir);
  const report = await usageReport(db, from, to, fixedPerMonth);
  mkdirSync(out, { recursive: true });
  for (const [name, text] of Object.entries(report.files)) writeFileSync(path.join(out, name), text);
  writeFileSync(path.join(out, "summary.json"), JSON.stringify(report.summary, null, 2) + "\n");
  const s = report.summary as { jobs: { total: number }; gpu: { pods: number }; sessions: { total: number }; cost: { gpuUsd: number } };
  console.log(`${out}: ${s.jobs.total} jobs, ${s.gpu.pods} pods, ${s.sessions.total} sessions; GPU ${s.cost.gpuUsd} USD`);
} finally {
  await db.end();
}
