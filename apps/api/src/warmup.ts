// Warm-up (measured in docs/reports/session-cold-start.md): a GPU pod rented for a session starts
// with nothing in memory, and loading the sketch_to_scene models from the network volume takes ~25 s,
// so the first picture of a game would take ~30 s instead of ~3. A session usually opens well before
// its first sketch, so a starting worker (WARMUP=1) asks for these jobs before its first claim and
// runs them for itself: each interactive preset once, on a blank input, the result thrown away. The
// models stay loaded (KEEP_MODELS), and the worker counts as ready only once it claims.
import { randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import type { ClaimedFile, ClaimedJob } from "@neuracraft/shared";
import type { Db } from "./db.js";
import { moderatedWorkflow, presetModels, presets, type Models } from "./presets.js";
import { claimedFiles } from "./scheduler.js";
import { blobKey, type Storage } from "./storage.js";

// The blank input's asset id: only ever in a warm-up job, never in the database.
export const WARMUP_INPUT = "00000000-0000-4000-8000-000000000000";

// A white square, as an 8-bit grayscale PNG.
export function blankPng(side: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  const row = Buffer.alloc(side + 1, 255);
  row[0] = 0; // filter: none
  const pixels = deflateSync(Buffer.concat(Array.from({ length: side }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

// One job per interactive preset whose catalog models are all there.
export async function warmupJobs(db: Db, storage: Storage): Promise<ClaimedJob[]> {
  const jobs: ClaimedJob[] = [];
  let blank: ClaimedFile | null = null;
  for (const p of presets) {
    if (p.latency !== "interactive" || !p.warmup) continue;
    const found = await db.query<{ slug: string; id: string }>(
      "SELECT slug, id FROM assets WHERE owner_id IS NULL AND kind = 'model' AND status = 'ready' AND slug = ANY($1::text[])",
      [presetModels(p)],
    );
    const models: Models = Object.fromEntries(found.rows.map((r) => [r.slug, r.id]));
    if (presetModels(p).some((m) => !models[m])) continue;
    if (!blank) {
      // Content-addressed: the same bytes land on the same blob every time (a blob GC removing it is harmless).
      const key = `uploads/warmup-${randomUUID()}`;
      await storage.put(key, blankPng(512));
      const { sha256, bytes } = await storage.finalize(key);
      blank = { assetId: WARMUP_INPUT, name: "blank.png", sha256, bytes, url: storage.downloadUrl(blobKey(sha256), 3600), kind: "input" };
    }
    const inputs = Object.fromEntries(p.inputs.filter((i) => !i.optional).map((i) => [i.name, WARMUP_INPUT]));
    jobs.push({
      jobId: `warmup-${p.id}`,
      workflow: moderatedWorkflow(p, p.warmup, inputs, models),
      limits: { maxSteps: 64, maxPixels: 4096 * 4096, maxFrames: 1, maxDenoiseSteps: 50, maxSeconds: 300 },
      files: [...(await claimedFiles(db, storage, Object.values(models))), blank],
      leaseSeconds: 0,
    });
  }
  return jobs;
}
