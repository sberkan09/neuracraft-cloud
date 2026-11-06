// End to end on one machine: the API (built), a Postgres (DATABASE_URL), and the worker binary
// (WORKER_BIN). A user signs up, uploads a picture, submits workflows, the worker runs them, the
// results come back. Run: node tests/e2e.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", STORAGE_DIR: path.join(data, "storage"), WORKER_TOKENS: token },
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
const runWorker = () =>
  new Promise((resolve) => {
    const w = spawn(workerBin, [], {
      env: { ...process.env, API_URL: api, WORKER_TOKEN: token, ONCE: "1", CACHE_DIR: path.join(data, "cache"), WORK_DIR: path.join(data, "jobs") },
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
  if (process.env.E2E_U2NETP) {
    const add = spawn("node", [path.join(root, "apps/api/dist/src/cli/add-model.js"), process.env.E2E_U2NETP, "--kind", "onnx", "--license", "Apache-2.0", "--name", "U2-Net (small)", "--entry", "u2netp.onnx"], {
      env: { ...process.env, STORAGE_DIR: path.join(data, "storage") },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let modelId = "";
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

  const me = (await call("GET", "/v1/me")).body;
  assert.ok(me.credits < 50000 && me.credits > 49000, String(me.credits));
  console.log("e2e: ok (credits left", me.credits, ")");
} finally {
  server.kill();
  rmSync(data, { recursive: true, force: true });
}
