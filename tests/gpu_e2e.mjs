// On a GPU machine: the API, a GPU worker (WORKER_BIN, built with -DNEURACRAFT_USE_CUDA=ON) and
// SD-Turbo as a catalog model (E2E_SD_TURBO: its diffusers folder). Two text-to-image jobs run one
// after the other; the second finds the model still loaded. Needs DATABASE_URL (an empty database).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const port = 19000 + Math.floor(Math.random() * 1000);
const api = `http://127.0.0.1:${port}`;
const data = mkdtempSync(path.join(tmpdir(), "nc-gpu-e2e-"));
const token = "gpu-e2e-token";
const env = { ...process.env, PORT: String(port), HOST: "127.0.0.1", STORAGE_DIR: path.join(data, "storage"), WORKER_TOKENS: token, SIGNUP_CREDITS: "1000000" };
const server = spawn("node", [path.join(root, "apps/api/dist/src/main.js")], { env, stdio: ["ignore", "ignore", "inherit"] });
let worker;
let cookie = "";
const call = async (method, url, body) => {
  const r = await fetch(api + url, { method, headers: body === undefined ? { cookie } : { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const text = await r.text();
  return { status: r.status, body: text && r.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text, headers: r.headers };
};
const run = (cmd, args) =>
  new Promise((resolve) => {
    let out = "";
    const p = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "inherit"] });
    p.stdout.on("data", (d) => (out += d));
    p.on("exit", () => resolve(out.trim()));
  });
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(api + "/v1/health")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const model = await run("node", [path.join(root, "apps/api/dist/src/cli/add-model.js"), process.env.E2E_SD_TURBO, "--kind", "sd", "--license", "Stability AI Community License", "--name", "SD-Turbo"]);
  worker = spawn(process.env.WORKER_BIN ?? path.join(root, "worker/build/neuracraft-worker"), [], {
    env: { ...env, API_URL: api, WORKER_TOKEN: token, WORKER_CLASS: "gpu", CACHE_DIR: path.join(data, "cache"), WORK_DIR: path.join(data, "jobs") },
    stdio: ["ignore", "inherit", "inherit"],
  });
  assert.equal((await call("POST", "/v1/auth/signup", { email: "gpu@example.com", password: "correct horse battery" })).status, 201);
  for (const [i, prompt] of ["a red fox in the snow, photo", "a lighthouse at dusk, oil painting"].entries()) {
    const started = Date.now();
    const j = await call("POST", "/v1/jobs", { workflow: { steps: [
      { op: "txt2img", model: `asset:${model}`, prompt, steps: 1, seed: 7, width: 512, height: 512, out: "picture" },
      { op: "save", in: "picture", path: "picture.png" },
    ] } });
    assert.equal(j.status, 201, JSON.stringify(j.body));
    let job;
    const deadline = Date.now() + 300_000;
    for (;;) {
      assert.ok(Date.now() < deadline, "the job did not finish in 5 minutes");
      job = (await call("GET", `/v1/jobs/${j.body.job.id}`)).body.job;
      if (["succeeded", "failed", "cancelled"].includes(job.state)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(job.state, "succeeded", JSON.stringify(job.error));
    const png = Buffer.from(await (await fetch(api + (await call("GET", `/v1/assets/${job.outputs[0].assetId}/content`)).headers.get("location"))).arrayBuffer());
    assert.equal(png.readUInt32BE(16), 512);
    console.log(`gpu e2e: job ${i + 1} (${prompt}): worker ${job.workerSeconds.toFixed(2)} s, end to end ${((Date.now() - started) / 1000).toFixed(2)} s`);
  }
  console.log("gpu e2e: ok");
} finally {
  worker?.kill();
  server.kill();
  rmSync(data, { recursive: true, force: true });
}
