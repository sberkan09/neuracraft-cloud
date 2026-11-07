// End to end on one machine: the API (built), a Postgres (DATABASE_URL), and the worker binary
// (WORKER_BIN). A user signs up, uploads a picture, submits workflows, the worker runs them, the
// results come back. Run: node tests/e2e.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import zlib from "node:zlib";

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const port = 18000 + Math.floor(Math.random() * 1000);
const api = `http://127.0.0.1:${port}`;
const data = mkdtempSync(path.join(tmpdir(), "nc-e2e-"));
const token = "e2e-worker-token";
const workerBin = process.env.WORKER_BIN ?? path.join(root, "worker/build/neuracraft-worker");

function png(w, h, rgb) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type), body]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(tb));
    return Buffer.concat([len, tb, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < h; y++) rows.push(Buffer.from([0, ...Array.from({ length: w }, () => rgb).flat()]));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

const server = spawn("node", [path.join(root, "apps/api/dist/src/main.js")], {
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", STORAGE_DIR: path.join(data, "storage"), WORKER_TOKENS: token, INTERACTIVE_ON_CPU: "1" },
  stdio: ["ignore", "ignore", "inherit"],
});
let cookie = "";
const call = async (method, url, body) => {
  const r = await fetch(api + url, { method, headers: body === undefined ? { cookie } : { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const text = await r.text();
  return { status: r.status, body: text ? (r.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) : null, headers: r.headers };
};
const runWorker = (extra = {}) =>
  new Promise((resolve) => {
    const w = spawn(workerBin, [], {
      env: { ...process.env, API_URL: api, WORKER_TOKEN: token, ONCE: "1", CACHE_DIR: path.join(data, "cache"), WORK_DIR: path.join(data, "jobs"), ...extra },
      stdio: ["ignore", "inherit", "inherit"],
    });
    w.on("exit", resolve);
  });

try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(api + "/v1/health")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await call("POST", "/v1/auth/signup", { email: `e2e${port}@example.com`, password: "correct horse battery" })).status, 201);
  const pic = png(16, 12, [200, 40, 10]);
  const a = await call("POST", "/v1/assets", { name: "red.png", kind: "input", bytes: pic.length, contentType: "image/png" });
  assert.equal((await fetch(api + a.body.uploadUrl, { method: "PUT", body: pic, headers: { "content-type": "image/png" } })).status, 200);
  assert.equal((await call("POST", `/v1/assets/${a.body.asset.id}/complete`)).status, 200);
  const id = a.body.asset.id;

  // 1. load, resize and save
  const j1 = await call("POST", "/v1/jobs", { workflow: { steps: [
    { op: "load", path: `asset:${id}`, out: "p" },
    { op: "resize", in: "p", width: 8, height: 6, out: "small" },
    { op: "save", in: "small", path: "small.png" },
  ] } });
  assert.equal(j1.status, 201, JSON.stringify(j1.body));
  assert.equal(await runWorker(), 0);
  const done1 = (await call("GET", `/v1/jobs/${j1.body.job.id}`)).body.job;
  assert.equal(done1.state, "succeeded", JSON.stringify(done1));
  assert.equal(done1.outputs.length, 1);
  const link = await call("GET", `/v1/assets/${done1.outputs[0].assetId}/content`);
  const out = Buffer.from(await (await fetch(api + link.headers.get("location"))).arrayBuffer());
  assert.equal(out.readUInt32BE(16), 8);
  assert.equal(out.readUInt32BE(20), 6);

  // 2. no save step: the last clip comes back as result.png
  const j2 = await call("POST", "/v1/jobs", { workflow: { steps: [{ op: "load", path: `asset:${id}`, out: "p" }, { op: "canny", in: "p", out: "edges" }] } });
  assert.equal(await runWorker(), 0);
  const done2 = (await call("GET", `/v1/jobs/${j2.body.job.id}`)).body.job;
  assert.equal(done2.state, "succeeded");
  assert.equal(done2.outputs[0].name, "result.png");

  // 3. the engine refuses what the API let through only in shape: a step reading a missing clip
  const j3 = await call("POST", "/v1/jobs", { workflow: { steps: [{ op: "resize", in: "nothing", width: 4, height: 4 }] } });
  assert.equal(await runWorker(), 0);
  const done3 = (await call("GET", `/v1/jobs/${j3.body.job.id}`)).body.job;
  assert.equal(done3.state, "failed");
  assert.equal(done3.error.code, "workflow.invalid");

  // 4. a catalog model (E2E_U2NETP: a folder with u2netp.onnx and its manifest u2netp.json)
  let modelId = "";
  if (process.env.E2E_U2NETP) {
    const add = spawn("node", [path.join(root, "apps/api/dist/src/cli/add-model.js"), process.env.E2E_U2NETP, "--kind", "onnx", "--license", "Apache-2.0", "--name", "U2-Net (small)", "--entry", "u2netp.onnx"], {
      env: { ...process.env, STORAGE_DIR: path.join(data, "storage") },
      stdio: ["ignore", "pipe", "inherit"],
    });
    add.stdout.on("data", (d) => (modelId += d));
    await new Promise((r) => add.on("exit", r));
    modelId = modelId.trim();
    const catalog = (await call("GET", "/v1/catalog")).body.models;
    assert.equal(catalog[0].id, modelId);
    assert.equal(catalog[0].license, "Apache-2.0");
    const j4 = await call("POST", "/v1/jobs", { workflow: { steps: [
      { op: "load", path: `asset:${id}`, out: "p" },
      { op: "onnx", model: `asset:${modelId}`, in: "p", apply: true, out: "cut" },
      { op: "save", in: "cut", path: "cut.png" },
    ] } });
    assert.equal(j4.status, 201, JSON.stringify(j4.body));
    assert.equal(await runWorker(), 0);
    const done4 = (await call("GET", `/v1/jobs/${j4.body.job.id}`)).body.job;
    assert.equal(done4.state, "succeeded", JSON.stringify(done4));
    const cut = Buffer.from(await (await fetch(api + (await call("GET", `/v1/assets/${done4.outputs[0].assetId}/content`)).headers.get("location"))).arrayBuffer());
    assert.equal(cut[25], 6, "an RGBA picture");
  }

  // 5. a 3D model the user brings (.glb input), animated with a catalog motion capture (mocap model):
  // a rigged stick figure and a motion of our own (tests/assets).
  {
    const glb = readFileSync(path.join(root, "tests/assets/stick-figure.glb"));
    const up = await call("POST", "/v1/assets", { name: "figure.glb", kind: "input", bytes: glb.length, contentType: "model/gltf-binary" });
    assert.equal((await fetch(api + up.body.uploadUrl, { method: "PUT", body: glb, headers: { "content-type": "model/gltf-binary" } })).status, 200);
    assert.equal((await call("POST", `/v1/assets/${up.body.asset.id}/complete`)).status, 200);
    // Added twice under one slug: the second replaces the first in the catalog.
    const addMotion = async () => {
      let out = "";
      const add = spawn("node", [path.join(root, "apps/api/dist/src/cli/add-model.js"), path.join(root, "tests/assets/stick-motion.bvh"), "--kind", "mocap", "--license", "own", "--name", "wave", "--slug", "wave"], {
        env: { ...process.env, STORAGE_DIR: path.join(data, "storage") },
        stdio: ["ignore", "pipe", "inherit"],
      });
      add.stdout.on("data", (d) => (out += d));
      await new Promise((r) => add.on("exit", r));
      return out.trim();
    };
    const firstMotion = await addMotion();
    const motionId = await addMotion();
    const waves = (await call("GET", "/v1/catalog")).body.models.filter((m) => m.slug === "wave");
    assert.deepEqual(waves.map((m) => [m.id, m.name]), [[motionId, "wave"]]);
    assert.notEqual(firstMotion, motionId);
    const j5 = await call("POST", "/v1/jobs", { workflow: { steps: [
      { op: "load", path: `asset:${up.body.asset.id}`, out: "fig" },
      { op: "animate", in: "fig", capture: `asset:${motionId}`, fps: 10, out: "moving" },
      { op: "render", in: "moving", width: 32, height: 32, out: "clip" },
      { op: "save", in: "moving", path: "moving.glb" },
      { op: "save", in: "clip", path: "clip.gif" },
    ] } });
    assert.equal(j5.status, 201, JSON.stringify(j5.body));
    assert.equal(await runWorker(), 0);
    const done5 = (await call("GET", `/v1/jobs/${j5.body.job.id}`)).body.job;
    assert.equal(done5.state, "succeeded", JSON.stringify(done5));
    const model = done5.outputs.find((o) => o.name === "moving.glb");
    assert.equal(model.kind, "model");
    const bytes = Buffer.from(await (await fetch(api + (await call("GET", `/v1/assets/${model.assetId}/content`)).headers.get("location"))).arrayBuffer());
    assert.equal(bytes.toString("latin1", 0, 4), "glTF");
    assert.ok(bytes.toString("latin1").includes('"animations"'), "the animation is in the model");
  }

  // 5b. an image classifier from the catalog (a bundle: the .onnx and its manifest): the classify step's
  // scores come back as a .json output. The picture is (200, 40, 10); this tiny "classifier" scores
  // the mean of each channel.
  {
    let classifierId = "";
    const add = spawn("node", [path.join(root, "apps/api/dist/src/cli/add-model.js"), path.join(root, "tests/assets/classifier"), "--kind", "onnx", "--license", "own", "--name", "channel means", "--entry", "means.onnx"], {
      env: { ...process.env, STORAGE_DIR: path.join(data, "storage") },
      stdio: ["ignore", "pipe", "inherit"],
    });
    add.stdout.on("data", (d) => (classifierId += d));
    await new Promise((r) => add.on("exit", r));
    const j = await call("POST", "/v1/jobs", { workflow: { steps: [
      { op: "load", path: `asset:${id}`, out: "p" },
      { op: "classify", model: `asset:${classifierId.trim()}`, in: "p", path: "scores.json" },
      { op: "save", in: "p", path: "p.png" },
    ] } });
    assert.equal(j.status, 201, JSON.stringify(j.body));
    assert.equal((await call("POST", "/v1/jobs", { workflow: { steps: [{ op: "load", path: `asset:${id}`, out: "p" }, { op: "classify", model: `asset:${classifierId.trim()}`, in: "p", path: "../x.json" }] } })).status, 400);
    assert.equal(await runWorker(), 0);
    const done = (await call("GET", `/v1/jobs/${j.body.job.id}`)).body.job;
    assert.equal(done.state, "succeeded", JSON.stringify(done));
    const file = done.outputs.find((o) => o.name === "scores.json");
    assert.equal(file.kind, "file");
    const scores = await (await fetch(api + (await call("GET", `/v1/assets/${file.assetId}/content`)).headers.get("location"))).json();
    assert.deepEqual(scores.labels, ["red", "green", "blue"]);
    assert.ok(Math.abs(scores.scores.red - 200 / 255) < 1e-3 && Math.abs(scores.scores.blue - 10 / 255) < 1e-3, JSON.stringify(scores));
  }

  // 5c. the sketch_to_scene preset on the engine's tiny models (tests/assets/tiny, written by the
  // engine's tiny_model_fixtures_on_request), both modes: inline sketch -> scribble ControlNet ->
  // LCM-LoRA (map) / 20 steps (atmosphere) -> TAESD -> the content classifier -> scene.png.
  {
    const addModel = async (args) => {
      let out = "";
      const add = spawn("node", [path.join(root, "apps/api/dist/src/cli/add-model.js"), ...args], {
        env: { ...process.env, STORAGE_DIR: path.join(data, "storage") },
        stdio: ["ignore", "pipe", "inherit"],
      });
      add.stdout.on("data", (d) => (out += d));
      const code = await new Promise((r) => add.on("exit", r));
      assert.equal(code, 0, `add-model ${args.join(" ")}`);
      return out.trim();
    };
    const tiny = (p) => path.join(root, "tests/assets/tiny", p);
    await addModel([tiny("sd"), "--kind", "sd", "--license", "test", "--slug", "dreamshaper-8"]);
    await addModel([tiny("controlnet"), "--kind", "controlnet", "--license", "test", "--slug", "controlnet-scribble"]);
    await addModel([tiny("lcm-lora.safetensors"), "--kind", "lora", "--license", "test", "--slug", "lcm-lora-sd15"]);
    await addModel([tiny("taesd"), "--kind", "taesd", "--license", "test", "--slug", "taesd"]);
    await addModel([path.join(root, "tests/assets/nsfw-tiny"), "--kind", "onnx", "--license", "test", "--entry", "nsfw.onnx", "--slug", "nsfw-classifier"]);
    const sketch = { inline: readFileSync(path.join(root, "tests/assets/sketches/kopru.png")).toString("base64"), contentType: "image/png" };
    for (const params of [{ mode: "map", narrative: "Nehrin üzerinde ahşap bir köprü", seed: 1 }, { mode: "atmosphere", prompt: "a misty forest river", seed: 2 }]) {
      const sub = await call("POST", "/v1/presets/sketch_to_scene/jobs", { params, inputs: { sketch } });
      assert.equal(sub.status, 201, JSON.stringify(sub.body));
      assert.equal(await runWorker(), 0);
      const done = (await call("GET", `/v1/jobs/${sub.body.job.id}`)).body.job;
      assert.equal(done.state, "succeeded", JSON.stringify(done));
      assert.deepEqual(done.outputs.map((o) => o.name), ["scene.png"]);  // the classifier's scores are not an output
      const png = Buffer.from(await (await fetch(api + (await call("GET", `/v1/assets/${done.outputs[0].assetId}/content`)).headers.get("location"))).arrayBuffer());
      assert.equal(png.readUInt32BE(16), 512);
      assert.equal(png.readUInt32BE(20), 512);
    }
  }

  // 6. workers sharing one cache (docker compose replicas on one volume): six users upload the same
  // picture (one blob), six workers start on an empty cache at once and fetch it together; a tiny
  // CACHE_MAX_GB makes each trim the cache while the others are still using it.
  const owner = cookie;
  const users = [];
  for (let i = 0; i < 6; i++) {
    cookie = "";
    assert.equal((await call("POST", "/v1/auth/signup", { email: `e2e${port}-${i}@example.com`, password: "correct horse battery" })).status, 201);
    const up = await call("POST", "/v1/assets", { name: "red.png", kind: "input", bytes: pic.length, contentType: "image/png" });
    assert.equal((await fetch(api + up.body.uploadUrl, { method: "PUT", body: pic, headers: { "content-type": "image/png" } })).status, 200);
    assert.equal((await call("POST", `/v1/assets/${up.body.asset.id}/complete`)).status, 200);
    const cut = modelId && i % 2 === 1;
    const steps = cut
      ? [{ op: "load", path: `asset:${up.body.asset.id}`, out: "p" }, { op: "onnx", model: `asset:${modelId}`, in: "p", apply: true, out: "o" }, { op: "save", in: "o", path: "o.png" }]
      : [{ op: "load", path: `asset:${up.body.asset.id}`, out: "p" }, { op: "resize", in: "p", width: 8, height: 6, out: "o" }, { op: "save", in: "o", path: "o.png" }];
    const j = await call("POST", "/v1/jobs", { workflow: { steps } });
    assert.equal(j.status, 201, JSON.stringify(j.body));
    users.push({ cookie, job: j.body.job.id, cut });
  }
  const shared = { CACHE_DIR: path.join(data, "shared-cache"), WORK_DIR: path.join(data, "shared-jobs"), CACHE_MAX_GB: "0.000000001" };
  assert.deepEqual(await Promise.all(users.map(() => runWorker(shared))), users.map(() => 0));
  for (const u of users) {
    cookie = u.cookie;
    const job = (await call("GET", `/v1/jobs/${u.job}`)).body.job;
    assert.equal(job.state, "succeeded", JSON.stringify(job));
    const o = Buffer.from(await (await fetch(api + (await call("GET", `/v1/assets/${job.outputs[0].assetId}/content`)).headers.get("location"))).arrayBuffer());
    if (u.cut) assert.equal(o[25], 6, "an RGBA picture");
    else assert.deepEqual([o.readUInt32BE(16), o.readUInt32BE(20)], [8, 6]);
  }
  cookie = owner;

  // 7. a native client with a bearer token only (no cookie): upload, submit, live events, download.
  {
    const made = await call("POST", "/v1/tokens", { name: "e2e", scopes: ["jobs:submit", "jobs:read", "assets:write", "assets:read"] });
    assert.equal(made.status, 201);
    const auth = { authorization: `Bearer ${made.body.secret}` };
    const bearer = async (method, url, body) => {
      const r = await fetch(api + url, { method, headers: body === undefined ? auth : { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
      const text = await r.text();
      return { status: r.status, body: text && r.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text, headers: r.headers };
    };
    const up = await bearer("POST", "/v1/assets", { name: "red.png", kind: "input", bytes: pic.length, contentType: "image/png" });
    assert.equal(up.status, 201);
    assert.equal((await fetch(api + up.body.uploadUrl, { method: "PUT", body: pic, headers: { "content-type": "image/png" } })).status, 200);
    assert.equal((await bearer("POST", `/v1/assets/${up.body.asset.id}/complete`)).status, 200);
    const j = await bearer("POST", "/v1/jobs", { workflow: { steps: [{ op: "load", path: `asset:${up.body.asset.id}`, out: "p" }, { op: "resize", in: "p", width: 8, height: 6, out: "o" }, { op: "save", in: "o", path: "o.png" }] } });
    assert.equal(j.status, 201, JSON.stringify(j.body));
    const events = await fetch(api + `/v1/jobs/${j.body.job.id}/events`, { headers: auth });
    assert.equal(events.status, 200);
    const seen = (async () => {
      const reader = events.body.getReader();
      let text = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString();
        if (text.includes("succeeded")) {
          await reader.cancel();
          break;
        }
      }
      return text;
    })();
    assert.equal(await runWorker(), 0);
    assert.ok((await seen).includes("succeeded"));
    const done7 = (await bearer("GET", `/v1/jobs/${j.body.job.id}`)).body.job;
    const link = await bearer("GET", `/v1/assets/${done7.outputs[0].assetId}/content`);
    assert.equal(link.status, 302);
    const o = Buffer.from(await (await fetch(api + link.headers.get("location"))).arrayBuffer());
    assert.deepEqual([o.readUInt32BE(16), o.readUInt32BE(20)], [8, 6]);
  }

  const me = (await call("GET", "/v1/me")).body;
  assert.ok(me.credits < 50000 && me.credits > 40000, String(me.credits));  // (the preset jobs are billed at the GPU rate)
  console.log("e2e: ok (credits left", me.credits, ")");
} finally {
  server.kill();
  rmSync(data, { recursive: true, force: true });
}
