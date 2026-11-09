// The map-mode look on the reference sketches (issue #42): the production prompt (the template
// writer, map mode) and the preset's settings, run with the engine CLI, one picture per sketch.
// Runs on a CPU too (~90 s a picture on 2 cores) — handy, since a GPU pod's pictures cannot be fetched.
//   node apps/api/dist/... (build first) then:
//   MODELS=/path/to/models NC=/path/to/NeuraCraft node deploy/gpu-check/map-check.mjs out/ [sketch ...]
// MODELS holds dreamshaper-8, controlnet-scribble, taesd and loras/lcm-lora-sdv1-5.safetensors.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const { templatePrompt } = await import(`${root}/apps/api/dist/src/prompts.js`);
const M = process.env.MODELS ?? "/models";
const NC = process.env.NC ?? "NeuraCraft";
const SK = `${root}/tests/assets/sketches`;
const [out = "map-check", ...only] = process.argv.slice(2);
const scales = (process.env.CONTROL ?? "0.9").split(",").map(Number); // several: one picture per scale
const scenes = JSON.parse(readFileSync(`${SK}/scenes.json`, "utf8"));
mkdirSync(out, { recursive: true });
const steps = [];
const prompts = {};
for (const [name, s] of Object.entries(scenes)) {
  if (only.length && !only.includes(name)) continue;
  const w = templatePrompt(s.narrative, "map");
  prompts[name] = w.prompt;
  steps.push(
    { op: "load", path: `${SK}/${name}.png`, out: `${name}_s` },
    { op: "resize", in: `${name}_s`, width: 512, height: 512, out: `${name}_r` },
    { op: "scribble", in: `${name}_r`, thickness: 2, out: `${name}_l` },
  );
  for (const cs of scales)
    steps.push(
      // As apps/api/src/presets.ts (sketch_to_scene, mode map) builds it.
      { op: "txt2img", model: `${M}/dreamshaper-8`, prompt: w.prompt, negative: `${w.negative}, blurry, text, watermark, frame, people`, seed: 1234,
        width: 512, height: 512, controlnet: `${M}/controlnet-scribble`, control: `${name}_l`, control_scale: cs, tiny_vae: `${M}/taesd`,
        steps: 4, sampler: "lcm", guidance: 1.5, lora: [`${M}/loras/lcm-lora-sdv1-5.safetensors:1`], out: `${name}_${cs}` },
      { op: "save", in: `${name}_${cs}`, path: `${path.resolve(out)}/${name}_${cs}.png` },
    );
}
writeFileSync(`${out}/workflow.json`, JSON.stringify({ steps }, null, 1));
writeFileSync(`${out}/prompts.json`, JSON.stringify(prompts, null, 1) + "\n");
const gpu = process.env.GPU === "1" ? ["--gpu"] : [];
execFileSync(NC, [...gpu, "--profile", "workflow", `${out}/workflow.json`], { stdio: "inherit" });
