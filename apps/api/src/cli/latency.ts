// Per-preset latency for operators (issue #20): p50 / p95 of submission-to-finish, queue wait, model
// loading and running, over finished jobs of the last hours.
//   node dist/src/cli/latency.js [--hours 24] [--json]
import { loadConfig } from "../config.js";
import { connect } from "../db.js";
import { latencyStats } from "../latency.js";

const args = process.argv.slice(2);
const i = args.indexOf("--hours");
const hours = i >= 0 ? Number(args[i + 1]) : 24;
const db = connect(loadConfig().databaseUrl);
try {
  const rows = await latencyStats(db, new Date(Date.now() - hours * 3600_000));
  if (args.includes("--json")) console.log(JSON.stringify(rows, null, 2));
  else if (!rows.length) console.log(`no finished preset jobs in the last ${hours} h`);
  else {
    console.log("preset / variant            jobs  warm   total p50/p95   queue p50/p95   load p50/p95    run p50/p95   (s)");
    for (const r of rows) {
      const f = (p: { p50: number; p95: number }) => `${p.p50.toFixed(2).padStart(6)} ${p.p95.toFixed(2).padStart(6)}`;
      console.log(`${`${r.preset}/${r.variant ?? "-"}`.padEnd(26)} ${String(r.jobs).padStart(5)} ${(r.warm * 100).toFixed(0).padStart(4)}%  ${f(r.total)}   ${f(r.queue)}   ${f(r.load)}   ${f(r.run)}`);
    }
  }
} finally {
  await db.end();
}
