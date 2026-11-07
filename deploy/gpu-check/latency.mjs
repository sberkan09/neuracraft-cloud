// The sketch_to_scene GPU check (issues #14 and #20), run against a live API with GPU workers:
//   API=http://127.0.0.1:8080 node deploy/gpu-check/latency.mjs [JOBS=50]
// 1. a cold job (the worker has no models loaded yet);
// 2. quality samples: each of the six spike sketches (tests/assets/sketches) in map mode (two seeds),
//    atmosphere mode, and map mode from the Turkish narrative (the server writes the prompt);
// 3. the preset's workflow as a plain job without the classifier, to see what it costs;
// 4. latency: JOBS map-mode jobs one after another, submission to succeeded, while a long batch job
//    (a 48-frame morph) runs on the other GPU worker.
// Prints the numbers, the server's per-preset percentiles and links to every sample picture.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const api = process.env.API ?? "http://127.0.0.1:8080";
const JOBS = Number(process.argv[2] ?? 50);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scenes = JSON.parse(readFileSync(path.join(root, "tests/assets/sketches/scenes.json"), "utf8"));
const sketch = (name) => ({ inline: readFileSync(path.join(root, `tests/assets/sketches/${name}.png`)).toString("base64"), contentType: "image/png" });

async function account(email) {
  const r = await fetch(`${api}/v1/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "correct horse battery" }) });
  if (r.status !== 201) throw new Error(`signup ${r.status} ${await r.text()}`);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  return async (method, url, body) => {
    const res = await fetch(api + url, { method, redirect: "manual", headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, location: res.headers.get("location") };
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(call, id) {
  for (;;) {
    const j = (await call("GET", `/v1/jobs/${id}`)).body.job;
    if (["succeeded", "failed", "cancelled"].includes(j.state)) return j;
    await sleep(25);
  }
}
async function preset(call, params, name) {
  const t0 = performance.now();
  const r = await call("POST", "/v1/presets/sketch_to_scene/jobs", { params, inputs: { sketch: sketch(name) } });
  if (r.status !== 201) throw new Error(`preset ${r.status} ${JSON.stringify(r.body)}`);
  const job = await wait(call, r.body.job.id);
  return { ms: performance.now() - t0, job };
}
const link = async (call, job) => (job.outputs[0] ? api + (await call("GET", `/v1/assets/${job.outputs[0].assetId}/content`)).location : `(${job.state} ${job.error?.code ?? ""})`);
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const fmt = (ms) => `${(ms / 1000).toFixed(2)} s`;

const call = await account(`gpu-check-${Date.now()}@example.com`);
const names = Object.keys(scenes);

// 1. cold
const cold = await preset(call, { mode: "map", prompt: scenes.kopru.prompt, seed: 1 }, "kopru");
console.log(`cold map job: ${fmt(cold.ms)} ${cold.job.state} ${cold.job.id}`);
const warmAgain = await preset(call, { mode: "map", prompt: scenes.kopru.prompt, seed: 2 }, "kopru");
console.log(`second map job: ${fmt(warmAgain.ms)}`);

// 2. quality samples
console.log("\n== samples ==");
for (const n of names) {
  for (const [label, params] of [
    ["map s1", { mode: "map", prompt: scenes[n].prompt, seed: 1 }],
    ["map s2", { mode: "map", prompt: scenes[n].prompt, seed: 2 }],
    ["atmosphere s1", { mode: "atmosphere", prompt: scenes[n].prompt, seed: 1 }],
    ["map narrative", { mode: "map", narrative: scenes[n].narrative, seed: 1 }],
  ]) {
    const r = await preset(call, params, n);
    console.log(`${n} ${label}: ${fmt(r.ms)} ${await link(call, r.job)}`);
  }
}

// 3. the preset's workflow as a plain job: no classifier step (what it costs)
console.log("\n== without the classifier ==");
const sample = (await call("GET", `/v1/jobs/${warmAgain.job.id}`)).body.job.workflow;
const bare = sample.steps.filter((s) => s.op !== "classify");
for (let k = 0; k < 3; k++) {
  const t0 = performance.now();
  const r = await call("POST", "/v1/jobs", { workflow: { steps: bare } });
  if (r.status !== 201) { console.log(`plain: ${r.status} ${JSON.stringify(r.body)}`); break; }
  const j = await wait(call, r.body.job.id);
  console.log(`plain job: ${fmt(performance.now() - t0)} ${j.state} worker ${j.workerSeconds?.toFixed(2)} s`);
}

// 4. latency under a batch job
const batchCall = await account(`gpu-check-batch-${Date.now()}@example.com`);
const catalog = (await call("GET", "/v1/catalog")).body.models;
const ds = catalog.find((m) => m.slug === "dreamshaper-8").id;
const batch = await batchCall("POST", "/v1/jobs", { workflow: { steps: [
  { op: "morph", model: `asset:${ds}`, prompts: ["a misty forest river at dawn", "a stone castle on a hill", "a harbour at night"], frames: 16, steps: 30, guidance: 7, out: "clip" },
  { op: "save", in: "clip", path: "morph.gif" },
] } });
console.log(`\nbatch morph job: ${batch.status} ${batch.body?.job?.id ?? JSON.stringify(batch.body)}`);
await sleep(3000);
const times = [];
let during = 0;
for (let i = 0; i < JOBS; i++) {
  const n = names[i % names.length];
  const r = await preset(call, { mode: "map", prompt: scenes[n].prompt, seed: 100 + i }, n);
  if (r.job.state !== "succeeded") console.log(`job ${i}: ${r.job.state} ${JSON.stringify(r.job.error)}`);
  times.push(r.ms);
  if (batch.body?.job && (await batchCall("GET", `/v1/jobs/${batch.body.job.id}`)).body.job.state === "running") during++;
}
console.log(`\n== latency: ${JOBS} map jobs, ${during} of them while the batch job was running ==`);
console.log(`p50 ${fmt(pct(times, 0.5))}  p95 ${fmt(pct(times, 0.95))}  min ${fmt(Math.min(...times))}  max ${fmt(Math.max(...times))}`);
if (batch.body?.job) {
  const b = await wait(batchCall, batch.body.job.id);
  console.log(`batch job: ${b.state} ${b.workerSeconds?.toFixed(1)} s ${await link(batchCall, b)}`);
}
