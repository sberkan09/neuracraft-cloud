// Checks a workflow a user submits before it is queued. The worker runs the engine's full checks
// (checkWorkflow, WorkflowLimits) again; here: the shape, known operations and fields, and that
// every file it names is an asset the user may use. Paths never appear: files are "asset:<id>",
// saves name an output file.
import { findOp, fileFieldTypes, type JobLimits } from "@neuracraft/shared";
import type { Db } from "./db.js";
import { fail } from "./errors.js";

const ASSET = /^asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const LORA = /^(asset:[0-9a-f-]{36})(:[0-9]*\.?[0-9]+)?$/;
// A save names its output file: pictures and clips, or 3D models.
export const OUTPUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(png|jpe?g|gif|mov|glb|obj|ply)$/;
// What a worker may upload: the saves, and the files an OBJ save writes next to it (.mtl, a texture).
export const OUTPUT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,72}\.(png|jpe?g|gif|mov|glb|obj|ply|mtl)$/;
const STEP_EXTRAS = new Set(["op", "out", "ui", "label", "comment"]);
const GENERATION = new Set(["txt2img", "img2img", "inpaint", "t2v", "morph", "zoom", "outpaint"]);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

// Operations that run diffusion models: these jobs go to GPU workers (when there are any).
export const GPU_OPS = new Set(["txt2img", "img2img", "inpaint", "t2v", "morph", "zoom", "outpaint", "upscale", "interpolate"]);

export interface CheckedWorkflow {
  workerClass: "cpu" | "gpu";
  workflow: { steps: Record<string, unknown>[] } & Record<string, unknown>;
  files: string[]; // asset ids it reads
  models: string[]; // the model assets among them
}

export async function checkSubmittedWorkflow(db: Db, userId: string, input: unknown, limits: JobLimits): Promise<CheckedWorkflow> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail(400, "workflow.invalid", { reason: "not an object" });
  const wf = input as Record<string, unknown>;
  const steps = wf.steps;
  if (!Array.isArray(steps) || steps.length === 0) fail(400, "workflow.invalid", { reason: "no steps" });
  const list = steps as unknown[];
  if (list.length > limits.maxSteps) fail(400, "limit.steps", { max: limits.maxSteps });
  for (const k of Object.keys(wf)) if (k !== "steps" && k !== "cache" && !k.startsWith("_")) fail(400, "workflow.invalid", { reason: `unknown key ${k}` });

  const refs = new Map<string, "model" | "input">();
  list.forEach((raw, i) => {
    const where = `step ${i + 1}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(400, "workflow.invalid", { reason: `${where} is not an object` });
    const step = raw as Record<string, unknown>;
    const op = typeof step.op === "string" ? findOp(step.op) : undefined;
    if (!op) fail(400, "workflow.invalid", { reason: `${where}: unknown op ${String(step.op)}` });
    // The same early bounds the engine checks (checkWorkflowLimits), so a job is refused at once.
    if ((step.width !== undefined || step.height !== undefined || GENERATION.has(op!.name)) && num(step.width, 512) * num(step.height, 512) > limits.maxPixels)
      fail(400, "limit.pixels", { step: i + 1, max: limits.maxPixels });
    if (GENERATION.has(op!.name) && num(step.steps, 0) > limits.maxDenoiseSteps) fail(400, "limit.denoise_steps", { step: i + 1, max: limits.maxDenoiseSteps });
    if (num(step.frames, 0) > limits.maxFrames) fail(400, "limit.frames", { step: i + 1, max: limits.maxFrames });
    for (const [k, v] of Object.entries(step)) {
      if (STEP_EXTRAS.has(k) || k.startsWith("_")) continue;
      const field = op!.fields.find((f) => f.name === k);
      if (!field) fail(400, "workflow.invalid", { reason: `${where}: unknown field ${k}` });
      if (op!.name === "save" && k === "path") {
        if (typeof v !== "string" || !OUTPUT_NAME.test(v)) fail(400, "workflow.path_not_allowed", { step: i + 1, field: k });
        continue;
      }
      if (!fileFieldTypes.has(field!.type)) continue;
      const values = Array.isArray(v) ? v : [v];
      for (const x of values) {
        if (typeof x !== "string") fail(400, "workflow.invalid", { reason: `${where}: ${k} must name assets` });
        const m = field!.type === "loras" ? LORA.exec(x as string) : ASSET.exec(x as string);
        if (!m) fail(400, "workflow.path_not_allowed", { step: i + 1, field: k });
        const id = (field!.type === "loras" ? m![1]!.slice(6) : m![1]!) as string;
        refs.set(id, field!.type === "model" || field!.type === "loras" ? "model" : (refs.get(id) ?? "input"));
      }
    }
  });

  const ids = [...refs.keys()];
  if (ids.length) {
    const r = await db.query<{ id: string; kind: string }>(
      "SELECT id, kind FROM assets WHERE id = ANY($1::uuid[]) AND status = 'ready' AND (owner_id = $2 OR (owner_id IS NULL AND kind = 'model'))",
      [ids, userId],
    );
    const found = new Map(r.rows.map((x) => [x.id, x.kind]));
    for (const [id, use] of refs) {
      const kind = found.get(id);
      if (!kind) fail(400, "workflow.asset_missing", { asset: id });
      if (use === "model" && kind !== "model") fail(400, "workflow.invalid", { reason: `asset ${id} is not a model` });
    }
  }
  return {
    workerClass: list.some((st) => GPU_OPS.has(String((st as Record<string, unknown>).op))) ? "gpu" : "cpu",
    workflow: wf as CheckedWorkflow["workflow"],
    files: ids,
    models: ids.filter((id) => refs.get(id) === "model"),
  };
}
