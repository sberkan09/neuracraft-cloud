// Exports preset jobs with their pictures, to look at testers' results (issue #42): per job the sketch,
// the region hint (when the app sent regions), the result and job.json (mode, state, error, timings,
// GPU, the prompt and narrative while they are still kept). A .tar.gz on stdout:
//   docker compose exec -T api node apps/api/dist/src/cli/job-export.js --last 10 > jobs.tar.gz
//   ... --job <id> [--job <id> ...]       ... --since 2026-11-12 [--preset sketch_to_scene]
//   ... --end-user <id>                    only one end user's jobs
// Only for testers who agreed to it (docs/PRIVACY.md): pictures and texts are personal data. What has
// expired (INPUT_RETENTION_HOURS for sketches and texts, 7 days for results) is simply missing.
import { gzipSync } from "node:zlib";
import { loadConfig } from "../config.js";
import { connect } from "../db.js";
import { blobKey, LocalStorage } from "../storage.js";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const jobs = args.flatMap((a, i) => (a === "--job" && args[i + 1] ? [args[i + 1]!] : []));
const last = Number(opt("last") ?? (jobs.length ? 0 : 10));
const since = opt("since") ? new Date(opt("since")!) : null;
const preset = opt("preset") ?? "sketch_to_scene";
const endUser = opt("end-user");
if (process.stdout.isTTY || Number.isNaN(last) || (since && Number.isNaN(since.getTime()))) {
  console.error("usage: job-export [--last N] [--since YYYY-MM-DD] [--job <id>]... [--preset sketch_to_scene] [--end-user <id>] > jobs.tar.gz");
  process.exit(2);
}

// A minimal ustar archive: regular files only.
const blocks: Buffer[] = [];
function addFile(name: string, data: Buffer) {
  const h = Buffer.alloc(512);
  const put = (s: string, at: number, len: number) => h.write(s.slice(0, len), at, len, "utf8");
  put(name, 0, 100);
  put("0000644\0", 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  put(data.length.toString(8).padStart(11, "0") + "\0", 124, 12);
  put(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136, 12);
  put("        ", 148, 8);
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
}

const config = loadConfig();
const db = connect(config.databaseUrl);
if (config.storage.kind !== "local") throw new Error("job-export reads local storage only");
const storage = new LocalStorage(config.storage.dir, config.signingKey, config.publicUrl);
try {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => (params.push(v), `$${params.length}`);
  if (jobs.length) where.push(`j.id = ANY(${p(jobs)}::uuid[])`);
  else where.push(`j.preset = ${p(preset)}`);
  if (since) where.push(`j.created_at >= ${p(since)}`);
  if (endUser) where.push(`j.end_user = ${p(endUser)}`);
  const r = await db.query<{
    id: string; created_at: Date; finished_at: Date | null; state: string; error: unknown; preset: string; preset_variant: string | null;
    end_user: string | null; workflow: { steps?: Record<string, unknown>[] }; prompt_info: unknown; scrubbed_at: Date | null;
    gpu_type: string | null; timings: unknown; worker_seconds: number | null;
  }>(
    `SELECT j.id, j.created_at, j.finished_at, j.state, j.error, j.preset, j.preset_variant, j.end_user, j.workflow, j.prompt_info, j.scrubbed_at,
            u.gpu_type, u.timings, u.worker_seconds
       FROM jobs j LEFT JOIN usage_jobs u ON u.job_id = j.id
      WHERE ${where.join(" AND ")} ORDER BY j.created_at DESC ${last ? `LIMIT ${p(last)}` : ""}`,
    params,
  );
  const read = async (assetId: string): Promise<Buffer | null> => {
    const a = await db.query<{ sha256: string | null }>("SELECT sha256 FROM assets WHERE id = $1 AND status <> 'removed'", [assetId]);
    if (!a.rows[0]?.sha256) return null;
    return storage.get(blobKey(a.rows[0].sha256)).catch(() => null);
  };
  const index: string[] = [];
  for (const j of r.rows) {
    const dir = `${j.created_at.toISOString().slice(0, 19).replace(/[:T]/g, "-")}_${j.preset_variant ?? j.preset}_${j.id.slice(0, 8)}`;
    const files: string[] = [];
    for (const st of j.workflow.steps ?? []) {
      const m = st.op === "load" && typeof st.path === "string" ? /^asset:(.+)$/.exec(st.path) : null;
      if (!m) continue;
      const name = st.out === "hint" ? "hint.png" : st.out === "sketch" ? "sketch.png" : null;
      const bytes = name ? await read(m[1]!) : null;
      if (name && bytes) (addFile(`${dir}/${name}`, bytes), files.push(name));
    }
    const outs = await db.query<{ name: string; asset_id: string }>("SELECT name, asset_id FROM job_outputs WHERE job_id = $1", [j.id]);
    for (const o of outs.rows) {
      const bytes = await read(o.asset_id);
      if (bytes) (addFile(`${dir}/${o.name}`, bytes), files.push(o.name));
    }
    const draw = (j.workflow.steps ?? []).find((s) => s.op === "txt2img" || s.op === "img2img");
    const info = {
      id: j.id, created: j.created_at, finished: j.finished_at, state: j.state, error: j.error, preset: j.preset, mode: j.preset_variant,
      endUser: j.end_user, regions: draw?.op === "img2img", gpu: j.gpu_type, workerSeconds: j.worker_seconds, timings: j.timings,
      textsScrubbed: j.scrubbed_at !== null, promptInfo: j.prompt_info, generation: draw,
    };
    addFile(`${dir}/job.json`, Buffer.from(JSON.stringify(info, null, 2) + "\n"));
    index.push(`${dir}  ${j.state}${draw?.op === "img2img" ? "  regions" : ""}  files: ${files.join(", ") || "(expired)"}`);
  }
  addFile("index.txt", Buffer.from(index.join("\n") + "\n"));
  blocks.push(Buffer.alloc(1024));
  process.stdout.write(gzipSync(Buffer.concat(blocks)));
  console.error(`${r.rows.length} jobs exported`);
} finally {
  await db.end();
}
