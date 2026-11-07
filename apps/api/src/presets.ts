// Server-side job presets (issue #15): a native client names a preset and its parameters, the server
// builds the engine workflow. Settings tuned once here reach every client without an app release, and
// a client cannot submit arbitrary workflows through a preset.
//
// A preset has a version; clients may send the version they were built for, and older parameter sets
// are mapped to the current one (`upgrade`) for at least one version.
import { fail } from "./errors.js";
import { CLASSIFIER_SLUG, MODERATION_FILE } from "./moderation.js";

export type ParamSpec =
  | { type: "enum"; options: string[]; required?: boolean; default?: string; doc: string }
  | { type: "string"; maxLength: number; required?: boolean; doc: string }
  | { type: "int"; min: number; max: number; required?: boolean; doc: string };

export interface InputSpec {
  name: string;
  doc: string;
  contentTypes: string[]; // accepted inline
  maxBytes: number; // decoded inline size
  maxSide: number; // pixels
}

// Catalog models a preset uses, by slug.
export type Models = Record<string, string>; // slug -> asset id

export interface Preset {
  id: string;
  version: number;
  description: string;
  params: Record<string, ParamSpec>;
  inputs: InputSpec[];
  models: string[]; // slugs (the output classifier's is added for every preset)
  moderate: string; // the clip the output classifier checks (presets.ts routes add the classify step)
  latency: "interactive" | "batch"; // interactive presets may be kept to INTERACTIVE_REGIONS
  retention?: { inputHours: number; outputDays: number }; // retention.ts; absent: kept until deleted
  variant?(params: Record<string, unknown>): string; // what the latency statistics group by (a mode)
  maxSeconds(params: Record<string, unknown>): number; // the reservation and the time limit
  workflow(params: Record<string, unknown>, inputs: Record<string, string>, models: Models): { steps: Record<string, unknown>[] };
  // A check across parameters, after each one is checked (a message naming the field, or null).
  check?(params: Record<string, unknown>): { field: string; reason: string } | null;
  // Parameters of an older version -> the current one (absent: only the current version).
  upgrade?(params: Record<string, unknown>, from: number): Record<string, unknown>;
  oldestVersion?: number;
}

const asset = (id: string) => `asset:${id}`;

const sketchToScene: Preset = {
  id: "sketch_to_scene",
  version: 1,
  description:
    "A picture of a scene from a terrain sketch (black strokes on white, 512 x 512) and an English prompt. map keeps the layout " +
    "(scribble ControlNet, 4 LCM steps); atmosphere is prettier and freer (20 steps).",
  params: {
    mode: { type: "enum", options: ["map", "atmosphere"], required: true, doc: "map: keeps the layout; atmosphere: freer, prettier" },
    prompt: { type: "string", maxLength: 400, doc: "What the scene is, in English (or give narrative instead)" },
    narrative: {
      type: "string",
      maxLength: 500,
      doc: "The scene told in any language (Turkish too); the server writes the English prompt (terrain only, no creatures)",
    },
    negative: { type: "string", maxLength: 300, doc: "What to avoid" },
    seed: { type: "int", min: 0, max: 4294967295, doc: "Noise seed (default: random)" },
    size: { type: "int", min: 512, max: 512, doc: "Picture size (512 only in v1)" },
  },
  inputs: [{ name: "sketch", doc: "Terrain sketch: dark strokes on light paper, PNG", contentTypes: ["image/png"], maxBytes: 512 * 1024, maxSide: 1024 }],
  models: ["dreamshaper-8", "controlnet-scribble", "lcm-lora-sd15", "taesd"],
  moderate: "scene",
  latency: "interactive",
  retention: { inputHours: 24, outputDays: 7 },
  variant: (p) => String(p.mode),
  check: (p) =>
    p.prompt === undefined && p.narrative === undefined
      ? { field: "prompt", reason: "prompt or narrative is required" }
      : p.prompt !== undefined && p.narrative !== undefined
        ? { field: "narrative", reason: "give prompt or narrative, not both" }
        : null,
  maxSeconds: (p) => (p.mode === "atmosphere" ? 60 : 30),
  workflow(p, inputs, m) {
    const map = p.mode === "map";
    const seed = typeof p.seed === "number" ? p.seed : Math.floor(Math.random() * 4294967296);
    const negative = [p.negative, "blurry, text, watermark, frame, people"].filter(Boolean).join(", ");
    const draw: Record<string, unknown> = {
      op: "txt2img",
      model: asset(m["dreamshaper-8"]!),
      prompt: p.prompt,
      negative,
      seed,
      width: 512,
      height: 512,
      controlnet: asset(m["controlnet-scribble"]!),
      control: "lines",
      control_scale: 0.9,
      tiny_vae: asset(m.taesd!),
      out: "scene",
    };
    if (map) Object.assign(draw, { steps: 4, sampler: "lcm", guidance: 1.5, lora: [asset(m["lcm-lora-sd15"]!)] });
    else Object.assign(draw, { steps: 20, sampler: "euler", guidance: 7 });
    return {
      steps: [
        { op: "load", path: asset(inputs.sketch!), out: "sketch" },
        { op: "resize", in: "sketch", width: 512, height: 512, out: "sized" },
        { op: "scribble", in: "sized", thickness: 2, out: "lines" },
        draw,
        { op: "save", in: "scene", path: "scene.png" },
      ],
    };
  },
};

export const presets: Preset[] = [sketchToScene];

// The models a preset job needs: its own and the output classifier.
export const presetModels = (p: Preset) => [...p.models, CLASSIFIER_SLUG];

// The preset's workflow with the output classifier on its result (moderation.ts): every preset job
// ends with scores the API reads before anything is released.
export function moderatedWorkflow(p: Preset, params: Record<string, unknown>, inputs: Record<string, string>, models: Models) {
  const wf = p.workflow(params, inputs, models);
  return { steps: [...wf.steps, { op: "classify", model: asset(models[CLASSIFIER_SLUG]!), in: p.moderate, path: MODERATION_FILE }] };
}
export const findPreset = (id: string) => presets.find((p) => p.id === id);

// The parameters, checked against the preset (unknown, missing, out of range: preset.params_invalid
// naming the field), older versions upgraded.
export function checkParams(preset: Preset, input: unknown, version?: unknown): Record<string, unknown> {
  const bad = (field: string, reason: string): never => fail(400, "preset.params_invalid", { field, reason });
  if (input === undefined) input = {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) bad("params", "not an object");
  let params = { ...(input as Record<string, unknown>) };
  if (version !== undefined) {
    if (typeof version !== "number" || !Number.isInteger(version)) bad("version", "not an integer");
    const v = version as number;
    if (v > preset.version || v < (preset.oldestVersion ?? preset.version)) bad("version", `supported: ${preset.oldestVersion ?? preset.version}..${preset.version}`);
    if (v < preset.version && preset.upgrade) params = preset.upgrade(params, v);
  }
  for (const k of Object.keys(params)) if (!(k in preset.params)) bad(k, "unknown parameter");
  const out: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(preset.params)) {
    const v = params[k];
    if (v === undefined || v === null) {
      if (spec.required) bad(k, "required");
      if (spec.type === "enum" && spec.default !== undefined) out[k] = spec.default;
      continue;
    }
    if (spec.type === "enum") {
      if (typeof v !== "string" || !spec.options.includes(v)) bad(k, `one of ${spec.options.join(", ")}`);
    } else if (spec.type === "string") {
      if (typeof v !== "string") bad(k, "not a string");
      if ((v as string).length > spec.maxLength) bad(k, `at most ${spec.maxLength} characters`);
      if ((v as string).trim() === "" && spec.required) bad(k, "required");
    } else {
      if (typeof v !== "number" || !Number.isInteger(v)) bad(k, "not an integer");
      if ((v as number) < spec.min || (v as number) > spec.max) bad(k, `${spec.min}..${spec.max}`);
    }
    out[k] = v;
  }
  const cross = preset.check?.(out);
  if (cross) bad(cross.field, cross.reason);
  return out;
}

// An inline picture: base64 -> bytes, checked (type by its bytes, size, sides). PNG only: the engine
// reads PNG (and PPM); JPEG would need a decoder there.
export function inlinePicture(spec: InputSpec, value: { inline?: unknown; contentType?: unknown }): Buffer {
  const bad = (reason: string): never => fail(400, "preset.params_invalid", { field: `inputs.${spec.name}`, reason });
  if (typeof value.inline !== "string") bad("inline must be base64 text");
  if (typeof value.contentType !== "string" || !spec.contentTypes.includes(value.contentType)) bad(`content type: ${spec.contentTypes.join(", ")}`);
  if ((value.inline as string).length > Math.ceil((spec.maxBytes * 4) / 3) + 4) bad(`at most ${spec.maxBytes} bytes`);
  const bytes = Buffer.from(value.inline as string, "base64");
  if (bytes.length === 0 || bytes.length > spec.maxBytes) bad(`at most ${spec.maxBytes} bytes`);
  const png = bytes.length > 24 && bytes[0] === 0x89 && bytes.toString("latin1", 1, 4) === "PNG" && bytes.toString("latin1", 12, 16) === "IHDR";
  if (!png) bad("not a PNG picture");
  const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
  if (w < 1 || h < 1 || w > spec.maxSide || h > spec.maxSide) bad(`at most ${spec.maxSide} x ${spec.maxSide} pixels`);
  return bytes;
}

// What GET /v1/presets shows clients.
export const presetJson = (p: Preset) => ({
  id: p.id,
  version: p.version,
  oldestVersion: p.oldestVersion ?? p.version,
  description: p.description,
  latency: p.latency,
  params: p.params,
  inputs: p.inputs.map((i) => ({ name: i.name, doc: i.doc, contentTypes: i.contentTypes, maxBytes: i.maxBytes, maxSide: i.maxSide })),
});
