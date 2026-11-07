// Presets (issue #15): GET /v1/presets lists them; POST /v1/presets/:id/jobs submits one in a single
// request, pictures inline (stored as the caller's assets in the same transaction) or as assets.
import type { FastifyInstance } from "fastify";
import { promptWriterFor, type Services } from "../app.js";
import { textAllowed, type SceneMode } from "../prompts.js";
import { requireUser } from "../auth.js";
import { tx } from "../db.js";
import { fail } from "../errors.js";
import { planFor } from "../plans.js";
import { checkParams, findPreset, inlinePicture, moderatedWorkflow, presetJson, presetModels, presets, type Models } from "../presets.js";

import { inputExpiry } from "../retention.js";
import { checkSubmittedWorkflow } from "../workflow.js";
import { jobJson, queueJob } from "./jobs.js";

const ASSET = /^asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export async function presetRoutes(app: FastifyInstance, s: Services) {
  app.get("/v1/presets", async () => ({ presets: presets.map(presetJson) }));

  app.post<{ Params: { id: string }; Body: { params?: unknown; inputs?: unknown; version?: unknown } }>("/v1/presets/:id/jobs", async (req, reply) => {
    const u = await requireUser(s.db, req, "jobs:submit");
    const preset = findPreset(req.params.id) ?? fail(404, "preset.unknown");
    const body = req.body ?? {};
    let params = checkParams(preset, body.params, body.version);
    const given = body.inputs ?? {};
    if (typeof given !== "object" || given === null || Array.isArray(given)) fail(400, "preset.params_invalid", { field: "inputs", reason: "not an object" });
    for (const k of Object.keys(given as object))
      if (!preset.inputs.some((i) => i.name === k)) fail(400, "preset.params_invalid", { field: `inputs.${k}`, reason: "unknown input" });
    // Inputs: an asset reference, or an inline picture checked here (nothing is written before every check passes).
    const refs: Record<string, string> = {};
    const inline: { name: string; bytes: Buffer; contentType: string }[] = [];
    for (const spec of preset.inputs) {
      const v = (given as Record<string, unknown>)[spec.name];
      if (v === undefined) fail(400, "preset.params_invalid", { field: `inputs.${spec.name}`, reason: "required" });
      if (typeof v === "string") {
        const m = ASSET.exec(v) ?? fail(400, "preset.params_invalid", { field: `inputs.${spec.name}`, reason: "asset:<id> or {inline, contentType}" });
        refs[spec.name] = m[1]!;
      } else if (typeof v === "object" && v !== null) {
        const o = v as { inline?: unknown; contentType?: unknown };
        inline.push({ name: spec.name, bytes: inlinePicture(spec, o), contentType: String(o.contentType) });
      } else fail(400, "preset.params_invalid", { field: `inputs.${spec.name}`, reason: "asset:<id> or {inline, contentType}" });
    }
    const found = await s.db.query<{ slug: string; id: string }>(
      "SELECT slug, id FROM assets WHERE owner_id IS NULL AND kind = 'model' AND status = 'ready' AND slug = ANY($1::text[])",
      [presetModels(preset)],
    );
    const models: Models = Object.fromEntries(found.rows.map((r) => [r.slug, r.id]));
    const missing = presetModels(preset).filter((m) => !models[m]);
    if (missing.length) fail(503, "preset.unavailable", { models: missing.join(", ") });

    // The prompt: written from a narrative (LLM or template), or the client's own; both texts filtered
    // before anything is stored or reserved.
    const refuse = (field: string, text: unknown) => {
      if (typeof text === "string" && !textAllowed(text).ok) fail(400, "content.text_refused", { field });
    };
    refuse("prompt", params.prompt);
    refuse("negative", params.negative);
    refuse("narrative", params.narrative);
    let promptInfo: Record<string, unknown> | null = null;
    if (typeof params.narrative === "string") {
      const w = await promptWriterFor(s).write(params.narrative, params.mode as SceneMode);
      refuse("narrative", w.prompt);
      promptInfo = { narrative: params.narrative, prompt: w.prompt, negative: w.negative, source: w.source, instructions: w.instructions,
        ...(w.fallbackReason ? { fallback: w.fallbackReason } : {}) };
      const { narrative: _n, ...rest } = params;
      params = { ...rest, prompt: w.prompt, negative: [params.negative, w.negative].filter(Boolean).join(", ") };
    } else if (typeof params.prompt === "string") {
      promptInfo = { prompt: params.prompt, source: "client" };
    }

    const plan = planFor(u.plan);
    const limits = { ...plan.limits, maxSeconds: Math.min(plan.limits.maxSeconds, preset.maxSeconds(params)) };
    // Inline bytes go to storage first (content-addressed: harmless if the transaction then fails).
    const stored: { name: string; sha256: string; bytes: number; contentType: string }[] = [];
    for (const i of inline) {
      const key = `uploads/inline-${crypto.randomUUID()}`;
      await s.storage.put(key, i.bytes);
      stored.push({ name: i.name, contentType: i.contentType, ...(await s.storage.finalize(key)) });
    }
    const row = await tx(s.db, async (c) => {
      for (const f of stored) {
        await c.query("INSERT INTO blobs (sha256, bytes) VALUES ($1, $2) ON CONFLICT DO NOTHING", [f.sha256, f.bytes]);
        const a = await c.query<{ id: string }>(
          "INSERT INTO assets (owner_id, kind, name, content_type, sha256, bytes, status, expires_at) VALUES ($1, 'input', $2, $3, $4, $5, 'ready', $6) RETURNING id",
          [u.id, `${f.name}.png`, f.contentType, f.sha256, f.bytes, inputExpiry(preset.id)],
        );
        refs[f.name] = a.rows[0]!.id;
      }
      const checked = await checkSubmittedWorkflow(c, u.id, moderatedWorkflow(preset, params, refs, models), limits);
      const regions = preset.latency === "interactive" ? s.config.interactiveRegions : [];
      return queueJob(s, c, u, checked, { limits, preset: { id: preset.id, version: preset.version }, promptInfo, regions });
    });
    return reply.status(201).send({ job: await jobJson(s, row) });
  });
}

