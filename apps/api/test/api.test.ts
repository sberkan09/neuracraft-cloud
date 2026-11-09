import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { harness, json, local, PNG_1x1, signUp, uploadPicture, worker, type Harness } from "./helpers.js";

let h: Harness;
before(async () => {
  h = await harness();
});
after(async () => {
  await h.close();
});

const inject = (o: InjectOptions): Promise<LightMyRequestResponse> => h.app.inject(o);

describe("accounts", () => {
  it("signs up, reads itself, logs out and in", async () => {
    const { cookie } = await signUp(h.app, "Ada@Example.com");
    const me = await inject({ method: "GET", url: "/v1/me", headers: { cookie } });
    assert.equal(me.statusCode, 200);
    assert.equal(json(me).user.email, "ada@example.com");
    assert.equal(json(me).credits, 50000);
    assert.equal((await inject({ method: "POST", url: "/v1/auth/logout", headers: { cookie } })).statusCode, 200);
    assert.equal((await inject({ method: "GET", url: "/v1/me", headers: { cookie } })).statusCode, 401);
    const bad = await inject({ method: "POST", url: "/v1/auth/login", payload: { email: "ada@example.com", password: "wrong password!" } });
    assert.equal(json(bad).error.code, "auth.invalid_credentials");
    const ok = await inject({ method: "POST", url: "/v1/auth/login", payload: { email: "ADA@example.com", password: "correct horse battery" } });
    assert.equal(ok.statusCode, 200);
  });
  it("refuses taken emails, weak passwords and bad addresses", async () => {
    await signUp(h.app, "taken@example.com");
    const again = await inject({ method: "POST", url: "/v1/auth/signup", payload: { email: "taken@example.com", password: "correct horse battery" } });
    assert.equal(json(again).error.code, "auth.email_taken");
    const weak = await inject({ method: "POST", url: "/v1/auth/signup", payload: { email: "w@example.com", password: "short" } });
    assert.equal(json(weak).error.code, "auth.weak_password");
    const addr = await inject({ method: "POST", url: "/v1/auth/signup", payload: { email: "nope", password: "correct horse battery" } });
    assert.equal(json(addr).error.code, "auth.invalid_email");
  });
  it("sets the language", async () => {
    const { cookie } = await signUp(h.app);
    const r = await inject({ method: "PATCH", url: "/v1/me", headers: { cookie }, payload: { locale: "tr" } });
    assert.equal(json(r).user.locale, "tr");
    assert.equal((await inject({ method: "PATCH", url: "/v1/me", headers: { cookie }, payload: { locale: "xx" } })).statusCode, 400);
  });
});

describe("assets", () => {
  it("uploads a picture, lists it, serves it to its owner only", async () => {
    const a = await signUp(h.app), b = await signUp(h.app);
    const id = await uploadPicture(h.app, a.cookie);
    const list = await inject({ method: "GET", url: "/v1/assets", headers: { cookie: a.cookie } });
    assert.equal(json(list).assets[0].id, id);
    assert.equal(json(list).assets[0].bytes, PNG_1x1.length);
    assert.equal(json(await inject({ method: "GET", url: "/v1/assets", headers: { cookie: b.cookie } })).assets.length, 0);
    const link = await inject({ method: "GET", url: `/v1/assets/${id}/content`, headers: { cookie: a.cookie } });
    assert.equal(link.statusCode, 302);
    const bytes = await inject({ method: "GET", url: local(link.headers.location as string) });
    assert.deepEqual(bytes.rawPayload, PNG_1x1);
    assert.equal((await inject({ method: "GET", url: `/v1/assets/${id}/content`, headers: { cookie: b.cookie } })).statusCode, 404);
  });
  it("refuses what is not a picture, uploads past the declared size, and forged URLs", async () => {
    const a = await signUp(h.app);
    await assert.rejects(uploadPicture(h.app, a.cookie, Buffer.from("GIF89a not a png")));
    // 3D models (.glb) are inputs too, checked by their bytes; motion captures (.bvh) are models of kind mocap.
    const glb = Buffer.concat([Buffer.from("glTF"), Buffer.from([2, 0, 0, 0, 20, 0, 0, 0])]);
    await uploadPicture(h.app, a.cookie, glb, "figure.glb");
    await assert.rejects(uploadPicture(h.app, a.cookie, PNG_1x1, "figure.glb"));
    await assert.rejects(uploadPicture(h.app, a.cookie, glb, "figure.png"));
    const bvh = Buffer.from("HIERARCHY\nROOT Hips\n");
    const m = await inject({ method: "POST", url: "/v1/assets", headers: { cookie: a.cookie }, payload: { name: "walk.bvh", kind: "model", bytes: bvh.length, license: "CMU" } });
    assert.equal(m.statusCode, 201);
    assert.equal(json(m).asset.modelKind, "mocap");
    await inject({ method: "PUT", url: local(json(m).uploadUrl), payload: bvh, headers: { "content-type": "application/octet-stream" } });
    assert.equal((await inject({ method: "POST", url: `/v1/assets/${json(m).asset.id}/complete`, headers: { cookie: a.cookie } })).statusCode, 200);
    const r = await inject({ method: "POST", url: "/v1/assets", headers: { cookie: a.cookie }, payload: { name: "x.png", kind: "input", bytes: 4 } });
    const put = await inject({ method: "PUT", url: local(json(r).uploadUrl), payload: Buffer.alloc(100), headers: { "content-type": "application/octet-stream" } });
    assert.equal(put.statusCode, 413);
    // (not the last character: in base64 it may hold only padding bits, and changing it changes nothing)
    const url = local(json(r).uploadUrl), at = url.length - 6;
    const forged = url.slice(0, at) + (url[at] === "A" ? "B" : "A") + url.slice(at + 1);
    assert.equal((await inject({ method: "PUT", url: forged, payload: Buffer.alloc(2), headers: { "content-type": "application/octet-stream" } })).statusCode, 403);
    const model = await inject({ method: "POST", url: "/v1/assets", headers: { cookie: a.cookie }, payload: { name: "m.ckpt", kind: "model", bytes: 10, license: "x" } });
    assert.equal(json(model).error.code, "model.unsupported");
  });
});

describe("jobs", () => {
  const resize = (asset: string) => ({
    steps: [
      { op: "load", path: `asset:${asset}`, out: "p" },
      { op: "resize", in: "p", width: 4, height: 4, out: "small" },
      { op: "save", in: "small", path: "small.png" },
    ],
  });

  it("refuses paths, unknown ops and fields, other people's files and limits", async () => {
    const a = await signUp(h.app), b = await signUp(h.app);
    const theirs = await uploadPicture(h.app, b.cookie);
    const post = (workflow: unknown) => inject({ method: "POST", url: "/v1/jobs", headers: { cookie: a.cookie }, payload: { workflow } });
    const code = async (workflow: unknown) => json(await post(workflow)).error?.code;
    assert.equal(await code({ steps: [{ op: "load", path: "/etc/passwd" }] }), "workflow.path_not_allowed");
    assert.equal(await code({ steps: [{ op: "load", path: "asset:../../x" }] }), "workflow.path_not_allowed");
    assert.equal(await code({ steps: [{ op: "save", in: "p", path: "../out.png" }] }), "workflow.path_not_allowed");
    assert.equal(await code({ steps: [{ op: "save", in: "p", path: "model.exe" }] }), "workflow.path_not_allowed");
    // 3D models are saved as .glb / .obj / .ply.
    const mine = await uploadPicture(h.app, a.cookie);
    const glb = await post({ steps: [{ op: "load", path: `asset:${mine}`, out: "p" }, { op: "save", in: "p", path: "model.glb" }] });
    assert.equal(glb.statusCode, 201, glb.body);
    await inject({ method: "POST", url: `/v1/jobs/${json(glb).job.id}/cancel`, headers: { cookie: a.cookie } });
    assert.equal(await code({ steps: [{ op: "rm", path: "x" }] }), "workflow.invalid");
    assert.equal(await code({ steps: [{ op: "resize", in: "p", widht: 3 }] }), "workflow.invalid");
    assert.equal(await code(resize(theirs)), "workflow.asset_missing");
    assert.equal(await code({ steps: [{ op: "resize", in: "p", width: 5000, height: 5000 }] }), "limit.pixels");
    assert.equal(await code({ steps: Array.from({ length: 13 }, () => ({ op: "resize", in: "p" })) }), "limit.steps");
  });

  it("gives a job that finishes before its first heartbeat a start time", async () => {
    const a = await signUp(h.app);
    const pic = await uploadPicture(h.app, a.cookie);
    const jobId = json(await inject({ method: "POST", url: "/v1/jobs", headers: { cookie: a.cookie }, payload: { workflow: resize(pic) } })).job.id;
    const workerId = json(await inject({ method: "POST", url: "/v1/worker/register", headers: worker, payload: { class: "cpu", cores: 1, memoryBytes: 1, engineVersion: "test" } })).workerId;
    assert.equal(json(await inject({ method: "POST", url: "/v1/worker/claim", headers: worker, payload: { workerId, loadedModels: [], waitSeconds: 0 } })).job.jobId, jobId);
    const done = await inject({ method: "POST", url: `/v1/worker/jobs/${jobId}/complete`, headers: worker, payload: { workerId, workerSeconds: 2, outputs: [] } });
    assert.equal(done.statusCode, 200);
    const fin = json(await inject({ method: "GET", url: `/v1/jobs/${jobId}`, headers: { cookie: a.cookie } })).job;
    assert.equal(fin.state, "succeeded");
    assert.ok(fin.startedAt, "startedAt is set");
    const ms = Date.parse(fin.finishedAt) - Date.parse(fin.startedAt);
    assert.ok(ms >= 1900 && ms <= 2100, String(ms));
  });

  it("runs end to end through a worker: claim, progress, outputs, billing", async () => {
    const a = await signUp(h.app);
    const pic = await uploadPicture(h.app, a.cookie);
    const sub = await inject({ method: "POST", url: "/v1/jobs", headers: { cookie: a.cookie }, payload: { workflow: resize(pic) } });
    assert.equal(sub.statusCode, 201);
    const jobId = json(sub).job.id;
    assert.equal(json(sub).job.state, "queued");
    const reserved = json(await inject({ method: "GET", url: "/v1/me", headers: { cookie: a.cookie } })).credits;
    assert.ok(reserved < 50000);

    assert.equal((await inject({ method: "POST", url: "/v1/worker/register", payload: { class: "cpu" } })).statusCode, 401);
    const reg = await inject({ method: "POST", url: "/v1/worker/register", headers: worker, payload: { class: "cpu", cores: 2, memoryBytes: 1, engineVersion: "test" } });
    const workerId = json(reg).workerId;
    const claim = await inject({ method: "POST", url: "/v1/worker/claim", headers: worker, payload: { workerId, loadedModels: [], waitSeconds: 0 } });
    const job = json(claim).job;
    assert.equal(job.jobId, jobId);
    assert.equal(job.files.length, 1);
    assert.equal(job.files[0].assetId, pic);
    const file = await inject({ method: "GET", url: local(job.files[0].url) });
    assert.deepEqual(file.rawPayload, PNG_1x1);
    assert.equal(job.limits.maxPixels, 1024 * 1024);

    const hb = await inject({ method: "POST", url: `/v1/worker/jobs/${jobId}/heartbeat`, headers: worker, payload: { workerId, progress: { step: 2, steps: 3, op: "resize", stage: "frame 1/1", fraction: 1 } } });
    assert.deepEqual(json(hb), { cancel: false });
    assert.equal(json(await inject({ method: "GET", url: `/v1/jobs/${jobId}`, headers: { cookie: a.cookie } })).job.state, "running");

    const up = await inject({ method: "POST", url: `/v1/worker/jobs/${jobId}/uploads`, headers: worker, payload: { workerId, outputs: [{ name: "small.png", bytes: PNG_1x1.length, contentType: "image/png" }] } });
    const u = json(up).uploads[0];
    assert.equal((await inject({ method: "PUT", url: local(u.url), payload: PNG_1x1, headers: { "content-type": "image/png" } })).statusCode, 200);
    const done = await inject({
      method: "POST",
      url: `/v1/worker/jobs/${jobId}/complete`,
      headers: worker,
      payload: { workerId, workerSeconds: 6, outputs: [{ name: "small.png", key: u.key, bytes: PNG_1x1.length, sha256: "", contentType: "image/png" }] },
    });
    assert.equal(done.statusCode, 200);
    const fin = json(await inject({ method: "GET", url: `/v1/jobs/${jobId}`, headers: { cookie: a.cookie } })).job;
    assert.equal(fin.state, "succeeded");
    assert.equal(fin.outputs[0].name, "small.png");
    assert.equal(fin.outputs[0].kind, "image");
    const out = await inject({ method: "GET", url: `/v1/assets/${fin.outputs[0].assetId}/content`, headers: { cookie: a.cookie } });
    assert.equal(out.statusCode, 302);
    // 6 s of CPU at 1000 millicredits a minute = 100
    assert.equal(json(await inject({ method: "GET", url: "/v1/me", headers: { cookie: a.cookie } })).credits, 50000 - 100);
    // a finished job cannot be completed or heartbeated again
    assert.equal((await inject({ method: "POST", url: `/v1/worker/jobs/${jobId}/heartbeat`, headers: worker, payload: { workerId } })).statusCode, 409);
  });

  it("cancels queued jobs at once and running ones through the heartbeat", async () => {
    const a = await signUp(h.app);
    const pic = await uploadPicture(h.app, a.cookie);
    const j1 = json(await inject({ method: "POST", url: "/v1/jobs", headers: { cookie: a.cookie }, payload: { workflow: resize(pic) } })).job.id;
    const c1 = await inject({ method: "POST", url: `/v1/jobs/${j1}/cancel`, headers: { cookie: a.cookie } });
    assert.equal(json(c1).state, "cancelled");
    assert.equal(json(await inject({ method: "GET", url: "/v1/me", headers: { cookie: a.cookie } })).credits, 50000);

    const j2 = json(await inject({ method: "POST", url: "/v1/jobs", headers: { cookie: a.cookie }, payload: { workflow: resize(pic) } })).job.id;
    const workerId = json(await inject({ method: "POST", url: "/v1/worker/register", headers: worker, payload: { class: "cpu" } })).workerId;
    let claimed = json(await inject({ method: "POST", url: "/v1/worker/claim", headers: worker, payload: { workerId, waitSeconds: 0 } })).job;
    while (claimed && claimed.jobId !== j2) claimed = json(await inject({ method: "POST", url: "/v1/worker/claim", headers: worker, payload: { workerId, waitSeconds: 0 } })).job;
    assert.equal(claimed.jobId, j2);
    await inject({ method: "POST", url: `/v1/jobs/${j2}/cancel`, headers: { cookie: a.cookie } });
    const hb = await inject({ method: "POST", url: `/v1/worker/jobs/${j2}/heartbeat`, headers: worker, payload: { workerId } });
    assert.equal(json(hb).cancel, true);
    await inject({ method: "POST", url: `/v1/worker/jobs/${j2}/fail`, headers: worker, payload: { workerId, code: "cancelled", workerSeconds: 3 } });
    assert.equal(json(await inject({ method: "GET", url: `/v1/jobs/${j2}`, headers: { cookie: a.cookie } })).job.state, "cancelled");
    assert.equal(json(await inject({ method: "GET", url: "/v1/me", headers: { cookie: a.cookie } })).credits, 50000 - 50);
  });

  it("shares workers fairly and charges nothing when the service fails a job", async () => {
    const a = await signUp(h.app), b = await signUp(h.app);
    const pa = await uploadPicture(h.app, a.cookie), pb = await uploadPicture(h.app, b.cookie);
    const a1 = json(await inject({ method: "POST", url: "/v1/jobs", headers: { cookie: a.cookie }, payload: { workflow: resize(pa) } })).job.id;
    const a2 = json(await inject({ method: "POST", url: "/v1/jobs", headers: { cookie: a.cookie }, payload: { workflow: resize(pa) } })).job.id;
    const b1 = json(await inject({ method: "POST", url: "/v1/jobs", headers: { cookie: b.cookie }, payload: { workflow: resize(pb) } })).job.id;
    const w = async () => json(await inject({ method: "POST", url: "/v1/worker/register", headers: worker, payload: { class: "cpu" } })).workerId;
    const w1 = await w(), w2 = await w(), w3 = await w();
    const take = async (id: string) => json(await inject({ method: "POST", url: "/v1/worker/claim", headers: worker, payload: { workerId: id, waitSeconds: 0 } })).job?.jobId ?? null;
    const first = await take(w1), second = await take(w2), third = await take(w3);
    // a free account runs one job at a time: a2 waits although it is older than b1
    assert.deepEqual([first, second, third], [a1, b1, null]);
    await inject({ method: "POST", url: `/v1/worker/jobs/${a1}/fail`, headers: worker, payload: { workerId: w1, code: "internal", detail: "disk full", workerSeconds: 30 } });
    const failed = json(await inject({ method: "GET", url: `/v1/jobs/${a1}`, headers: { cookie: a.cookie } })).job;
    assert.equal(failed.state, "failed");
    assert.equal(failed.error.code, "internal");
    assert.equal(await take(w1), a2);
    // a1 cost nothing; a2 is reserved
    const credits = json(await inject({ method: "GET", url: "/v1/me", headers: { cookie: a.cookie } })).credits;
    assert.equal(credits, 50000 - 5000);
  });

  it("sends diffusion jobs to GPU workers, and to CPU workers only while there is no GPU", async () => {
    const a = await signUp(h.app);
    const pic = await uploadPicture(h.app, a.cookie);
    await h.s.db.query("UPDATE jobs SET state = 'cancelled' WHERE state = 'queued'");  // earlier tests' leftovers
    const gen = json(await inject({ method: "POST", url: "/v1/jobs", headers: { cookie: a.cookie }, payload: { workflow: { steps: [{ op: "upscale", in: "p" }] } } }));
    assert.ok(gen.job, JSON.stringify(gen));
    const cpu = json(await inject({ method: "POST", url: "/v1/worker/register", headers: worker, payload: { class: "cpu" } })).workerId;
    const gpu = json(await inject({ method: "POST", url: "/v1/worker/register", headers: worker, payload: { class: "gpu" } })).workerId;
    const take = async (id: string) => json(await inject({ method: "POST", url: "/v1/worker/claim", headers: worker, payload: { workerId: id, waitSeconds: 0 } })).job?.jobId ?? null;
    assert.equal(await take(cpu), null, "a GPU worker is around: the CPU worker leaves the GPU job");
    assert.equal(await take(gpu), gen.job.id);
    await inject({ method: "POST", url: `/v1/worker/jobs/${gen.job.id}/fail`, headers: worker, payload: { workerId: gpu, code: "internal", workerSeconds: 0 } });
    // a GPU worker also takes CPU work
    const plain = json(await inject({ method: "POST", url: "/v1/jobs", headers: { cookie: a.cookie }, payload: { workflow: resize(pic) } })).job.id;
    assert.equal(await take(gpu), plain);
    await inject({ method: "POST", url: `/v1/worker/jobs/${plain}/fail`, headers: worker, payload: { workerId: gpu, code: "internal", workerSeconds: 0 } });
    // with no GPU seen lately, CPU workers take GPU jobs
    const gen2 = json(await inject({ method: "POST", url: "/v1/jobs", headers: { cookie: a.cookie }, payload: { workflow: { steps: [{ op: "upscale", in: "p" }] } } })).job.id;
    await h.s.db.query("UPDATE workers SET last_seen_at = now() - interval '10 minutes' WHERE class = 'gpu'");
    assert.equal(await take(cpu), gen2);
  });

  it("sends 3D model and rigging jobs only to GPU workers with those services, and refuses them when there is none", async () => {
    const a = await signUp(h.app);
    const pic = await uploadPicture(h.app, a.cookie);
    await h.s.db.query("UPDATE jobs SET state = 'cancelled' WHERE state = 'queued'");
    await h.s.db.query("UPDATE workers SET last_seen_at = now() - interval '1 hour'");
    const model = {
      steps: [
        { op: "load", path: `asset:${pic}`, out: "p" },
        { op: "image_to_3d", in: "p", quality: "fast", out: "m" },
        { op: "save", in: "m", path: "m.glb" },
      ],
    };
    const submit = () => inject({ method: "POST", url: "/v1/jobs", headers: { cookie: a.cookie }, payload: { workflow: model } });
    const none = await submit();
    assert.equal(none.statusCode, 503);
    assert.equal(json(none).error.code, "job.no_3d_worker");
    assert.equal(json(none).error.params.services, "3d");

    const register = async (payload: object) => json(await inject({ method: "POST", url: "/v1/worker/register", headers: worker, payload })).workerId;
    const cpu = await register({ class: "cpu" });
    const gpu = await register({ class: "gpu" });
    const gpu3d = await register({ class: "gpu", features: ["3d"] });
    const take = async (id: string) => json(await inject({ method: "POST", url: "/v1/worker/claim", headers: worker, payload: { workerId: id, waitSeconds: 0 } })).job?.jobId ?? null;
    const job = json(await submit()).job;
    assert.ok(job, "a 3D worker is around");
    // no GPU seen lately: the CPU worker may take GPU jobs, but still never a 3D one
    await h.s.db.query("UPDATE workers SET last_seen_at = now() - interval '10 minutes' WHERE class = 'gpu'");
    assert.equal(await take(cpu), null);
    assert.equal(await take(gpu), null, "a GPU worker without the 3D service leaves it");
    assert.equal(await take(gpu3d), job.id);
    await inject({ method: "POST", url: `/v1/worker/jobs/${job.id}/fail`, headers: worker, payload: { workerId: gpu3d, code: "internal", workerSeconds: 0 } });

    // A job that also rigs the model needs both services.
    const rigged = { steps: [...model.steps.slice(0, 2), { op: "rig", in: "m", out: "r" }, { op: "save", in: "r", path: "r.glb" }] };
    const noRig = await inject({ method: "POST", url: "/v1/jobs", headers: { cookie: a.cookie }, payload: { workflow: rigged } });
    assert.equal(noRig.statusCode, 503);
    assert.equal(json(noRig).error.params.services, "3d, rig");
    const both = await register({ class: "gpu", features: ["3d", "rig"] });
    const job2 = json(await inject({ method: "POST", url: "/v1/jobs", headers: { cookie: a.cookie }, payload: { workflow: rigged } })).job;
    assert.ok(job2);
    assert.equal(await take(gpu3d), null, "the 3D service alone is not enough");
    assert.equal(await take(both), job2.id);
    const stored = await h.s.db.query("SELECT worker_class, features FROM jobs WHERE id = $1", [job2.id]);
    assert.deepEqual(stored.rows[0], { worker_class: "gpu", features: ["3d", "rig"] });
  });

  it("requeues jobs whose worker vanished, and fails them after three attempts", async () => {
    const { reapLeases } = await import("../src/scheduler.js");
    const a = await signUp(h.app);
    const pic = await uploadPicture(h.app, a.cookie);
    const id = json(await inject({ method: "POST", url: "/v1/jobs", headers: { cookie: a.cookie }, payload: { workflow: resize(pic) } })).job.id;
    const w = json(await inject({ method: "POST", url: "/v1/worker/register", headers: worker, payload: { class: "cpu" } })).workerId;
    for (let attempt = 1; attempt <= 3; ++attempt) {
      let got = json(await inject({ method: "POST", url: "/v1/worker/claim", headers: worker, payload: { workerId: w, waitSeconds: 0 } })).job;
      while (got && got.jobId !== id) got = json(await inject({ method: "POST", url: "/v1/worker/claim", headers: worker, payload: { workerId: w, waitSeconds: 0 } })).job;
      assert.equal(got?.jobId, id, `attempt ${attempt}`);
      await h.s.db.query("UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1", [id]);
      await reapLeases(h.s.db);
    }
    const job = json(await inject({ method: "GET", url: `/v1/jobs/${id}`, headers: { cookie: a.cookie } })).job;
    assert.equal(job.state, "failed");
    assert.equal(json(await inject({ method: "GET", url: "/v1/me", headers: { cookie: a.cookie } })).credits, 50000);
  });

  it("streams events", async () => {
    const a = await signUp(h.app);
    const pic = await uploadPicture(h.app, a.cookie);
    const id = json(await inject({ method: "POST", url: "/v1/jobs", headers: { cookie: a.cookie }, payload: { workflow: resize(pic) } })).job.id;
    const seen: string[] = [];
    const stop = h.s.events.subscribe(id, (e) => seen.push(e.type === "state" ? `state:${e.state}` : e.type));
    await inject({ method: "POST", url: `/v1/jobs/${id}/cancel`, headers: { cookie: a.cookie } });
    for (let i = 0; i < 50 && !seen.length; ++i) await new Promise((r) => setTimeout(r, 20));
    stop();
    assert.deepEqual(seen, ["state:cancelled"]);
  });
});

describe("presets", () => {
  const catalog = async () => {
    await gpuOnline();
    for (const [slug, kind] of [["dreamshaper-8", "sd"], ["controlnet-scribble", "controlnet"], ["lcm-lora-sd15", "lora"], ["taesd", "taesd"], ["nsfw-classifier", "onnx"]])
      await h.s.db.query(
        "INSERT INTO assets (owner_id, kind, model_kind, name, slug, license, status) VALUES (NULL, 'model', $1, $2, $2, 'test', 'ready') ON CONFLICT DO NOTHING",
        [kind, slug],
      );
  };
  const sketch = { inline: PNG_1x1.toString("base64"), contentType: "image/png" };

  it("lists presets with their parameters and versions", async () => {
    const r = json(await inject({ method: "GET", url: "/v1/presets" }));
    const p = r.presets.find((x: { id: string }) => x.id === "sketch_to_scene");
    assert.equal(p.version, 1);
    assert.deepEqual(p.params.mode.options, ["map", "atmosphere"]);
    assert.equal(p.inputs[0].name, "sketch");
  });

  it("submits sketch_to_scene in one request with an inline sketch and a reservation sized for the preset", async () => {
    const a = await signUp(h.app);
    const submit = (params: object, inputs: object = { sketch }, extra: object = {}) =>
      inject({ method: "POST", url: "/v1/presets/sketch_to_scene/jobs", headers: { cookie: a.cookie }, payload: { params, inputs, ...extra } });
    const missing = await submit({ mode: "map", prompt: "a bridge over a river" });
    assert.equal(missing.statusCode, 503);
    assert.equal(json(missing).error.code, "preset.unavailable");
    await catalog();
    // 5 credits left: a map job (30 s at the GPU rate = 5 credits) fits, an atmosphere job (60 s) does not.
    await h.s.db.query("INSERT INTO ledger (user_id, kind, amount) VALUES ($1, 'settle', $2)", [a.id, -45000]);
    const ok = await submit({ mode: "map", prompt: "top-down fantasy battle map, a wooden bridge over a river", seed: 7 });
    assert.equal(ok.statusCode, 201, ok.body);
    const job = json(ok).job;
    const steps = job.workflow.steps.map((s: { op: string }) => s.op);
    assert.deepEqual(steps, ["load", "resize", "scribble", "txt2img", "save", "classify"]);
    assert.deepEqual([job.workflow.steps[5].in, job.workflow.steps[5].path], ["scene", "moderation.json"]);
    const draw = job.workflow.steps[3];
    assert.equal(draw.sampler, "lcm");
    assert.equal(draw.steps, 4);
    assert.equal(draw.control_scale, 0.9);
    assert.equal(draw.seed, 7);
    assert.match(draw.lora[0], /^asset:[0-9a-f-]{36}:1$/);
    assert.equal(job.workflow.steps[4].path, "scene.png");
    const reserved = await h.s.db.query("SELECT amount FROM ledger WHERE job_id = $1 AND kind = 'reserve'", [job.id]);
    assert.equal(Number(reserved.rows[0].amount), -5000);
    const row = (await h.s.db.query("SELECT preset, preset_version, worker_class, limits FROM jobs WHERE id = $1", [job.id])).rows[0];
    assert.deepEqual([row.preset, row.preset_version, row.worker_class, row.limits.maxSeconds], ["sketch_to_scene", 1, "gpu", 30]);
    // The sketch became the user's own asset.
    const inputs = json(await inject({ method: "GET", url: "/v1/assets?kind=input", headers: { cookie: a.cookie } })).assets;
    assert.ok(inputs.some((x: { name: string }) => x.name === "sketch.png"));
    await h.s.db.query("UPDATE jobs SET state = 'cancelled' WHERE id = $1", [job.id]);
    await h.s.db.query("INSERT INTO ledger (user_id, kind, amount, job_id) VALUES ($1, 'release', 5000, $2)", [a.id, job.id]);
    const big = await submit({ mode: "atmosphere", prompt: "a misty forest river at dusk" });
    assert.equal(big.statusCode, 402);
    assert.equal(json(big).error.params.needed, 10000);
    // A sketch already uploaded works too.
    const pic = await uploadPicture(h.app, a.cookie);
    assert.equal((await submit({ mode: "map", prompt: "a castle wall" }, { sketch: `asset:${pic}` })).statusCode, 201);
  });

  it("maps the parameters of older preset versions", async () => {
    const { checkParams } = await import("../src/presets.js");
    const v2 = {
      id: "demo", version: 2, oldestVersion: 1, description: "", inputs: [], models: [], moderate: "x", latency: "batch" as const,
      params: { mode: { type: "enum" as const, options: ["map", "atmosphere"], required: true, doc: "" } },
      maxSeconds: () => 10, workflow: () => ({ steps: [] }),
      upgrade: (p: Record<string, unknown>) => ({ mode: p.style === "tactical" ? "map" : "atmosphere" }),  // v1 called it style
    };
    assert.deepEqual(checkParams(v2, { style: "tactical" }, 1), { mode: "map" });
    assert.deepEqual(checkParams(v2, { mode: "atmosphere" }), { mode: "atmosphere" });
    assert.throws(() => checkParams(v2, { style: "tactical" }));  // without the version: an unknown parameter
    assert.throws(() => checkParams(v2, { mode: "map" }, 0));
  });

  it("refuses bad parameters and inputs before anything is stored, queued or reserved", async () => {
    await catalog();
    const a = await signUp(h.app);
    const count = async () => Number((await h.s.db.query("SELECT count(*) AS n FROM jobs WHERE user_id = $1", [a.id])).rows[0].n);
    const assets = async () => Number((await h.s.db.query("SELECT count(*) AS n FROM assets WHERE owner_id = $1", [a.id])).rows[0].n);
    const cases: [object, string][] = [
      [{ params: { mode: "map" }, inputs: { sketch } }, "prompt"],
      [{ params: { mode: "night", prompt: "x" }, inputs: { sketch } }, "mode"],
      [{ params: { mode: "map", prompt: "x", style: "y" }, inputs: { sketch } }, "style"],
      [{ params: { mode: "map", prompt: "x".repeat(401) }, inputs: { sketch } }, "prompt"],
      [{ params: { mode: "map", prompt: "x", size: 768 }, inputs: { sketch } }, "size"],
      [{ params: { mode: "map", prompt: "x", seed: -1 }, inputs: { sketch } }, "seed"],
      [{ params: { mode: "map", prompt: "x" }, inputs: {} }, "inputs.sketch"],
      [{ params: { mode: "map", prompt: "x" }, inputs: { sketch, extra: sketch } }, "inputs.extra"],
      [{ params: { mode: "map", prompt: "x" }, inputs: { sketch: { ...sketch, contentType: "image/gif" } } }, "inputs.sketch"],
      [{ params: { mode: "map", prompt: "x" }, inputs: { sketch: { inline: Buffer.from("GIF89a....").toString("base64"), contentType: "image/png" } } }, "inputs.sketch"],
      [{ params: { mode: "map", prompt: "x" }, inputs: { sketch: { inline: Buffer.alloc(600 * 1024).toString("base64"), contentType: "image/png" } } }, "inputs.sketch"],
      [{ params: { mode: "map", prompt: "x" }, inputs: { sketch }, version: 2 }, "version"],
    ];
    for (const [payload, field] of cases) {
      const r = await inject({ method: "POST", url: "/v1/presets/sketch_to_scene/jobs", headers: { cookie: a.cookie }, payload });
      assert.equal(r.statusCode, 400, `${field}: ${r.body}`);
      assert.equal(json(r).error.code, "preset.params_invalid");
      assert.equal(json(r).error.params.field, field);
    }
    // A 2000 x 2000 PNG header: too big a picture.
    const huge = Buffer.from(PNG_1x1);
    huge.writeUInt32BE(2000, 16);
    huge.writeUInt32BE(2000, 20);
    const r = await inject({ method: "POST", url: "/v1/presets/sketch_to_scene/jobs", headers: { cookie: a.cookie }, payload: { params: { mode: "map", prompt: "x" }, inputs: { sketch: { inline: huge.toString("base64"), contentType: "image/png" } } } });
    assert.equal(json(r).error.params.field, "inputs.sketch");
    assert.equal((await inject({ method: "POST", url: "/v1/presets/nope/jobs", headers: { cookie: a.cookie }, payload: {} })).statusCode, 404);
    assert.equal(await count(), 0);
    assert.equal(await assets(), 0);
    const credits = json(await inject({ method: "GET", url: "/v1/me", headers: { cookie: a.cookie } })).credits;
    assert.equal(credits, 50000);
  });
});

describe("tokens", () => {
  it("lets a bearer token upload, submit and read within its scopes, and stops it when revoked or expired", async () => {
    const a = await signUp(h.app);
    const make = async (scopes: string[]) => {
      const r = await inject({ method: "POST", url: "/v1/tokens", headers: { cookie: a.cookie }, payload: { name: "script", scopes } });
      assert.equal(r.statusCode, 201, r.body);
      assert.match(json(r).secret, /^nc_pat_[A-Za-z0-9_-]{32}$/);
      return { id: json(r).token.id as string, auth: { authorization: `Bearer ${json(r).secret}` } };
    };
    const full = await make(["jobs:submit", "jobs:read", "assets:write", "assets:read"]);
    // Upload a picture and run a job with the token alone.
    const start = await inject({ method: "POST", url: "/v1/assets", headers: full.auth, payload: { name: "in.png", kind: "input", bytes: PNG_1x1.length, contentType: "image/png" } });
    assert.equal(start.statusCode, 201);
    await inject({ method: "PUT", url: local(json(start).uploadUrl), payload: PNG_1x1, headers: { "content-type": "application/octet-stream" } });
    assert.equal((await inject({ method: "POST", url: `/v1/assets/${json(start).asset.id}/complete`, headers: full.auth })).statusCode, 200);
    const job = await inject({ method: "POST", url: "/v1/jobs", headers: full.auth, payload: { workflow: { steps: [{ op: "load", path: `asset:${json(start).asset.id}`, out: "p" }, { op: "resize", in: "p", width: 4, height: 4 }] } } });
    assert.equal(job.statusCode, 201, job.body);
    assert.equal((await inject({ method: "GET", url: `/v1/jobs/${json(job).job.id}`, headers: full.auth })).statusCode, 200);
    assert.equal((await inject({ method: "GET", url: "/v1/me", headers: full.auth })).statusCode, 200);
    // Never the account or the tokens themselves.
    assert.equal(json(await inject({ method: "PATCH", url: "/v1/me", headers: full.auth, payload: { locale: "tr" } })).error.code, "forbidden");
    assert.equal((await inject({ method: "POST", url: "/v1/tokens", headers: full.auth, payload: { name: "x", scopes: ["jobs:read"] } })).statusCode, 403);
    assert.equal((await inject({ method: "GET", url: "/v1/tokens", headers: full.auth })).statusCode, 403);
    // A read-only token: no uploads, nothing written.
    const reader = await make(["jobs:read"]);
    const before = Number((await h.s.db.query("SELECT count(*) AS n FROM assets WHERE owner_id = $1", [a.id])).rows[0].n);
    const denied = await inject({ method: "POST", url: "/v1/assets", headers: reader.auth, payload: { name: "x.png", kind: "input", bytes: 10 } });
    assert.equal(denied.statusCode, 403);
    assert.deepEqual(json(denied).error, { code: "auth.scope_missing", params: { scope: "assets:write" } });
    assert.equal(Number((await h.s.db.query("SELECT count(*) AS n FROM assets WHERE owner_id = $1", [a.id])).rows[0].n), before);
    // Listed without secrets; revoked at once; expired ones stop too.
    const list = json(await inject({ method: "GET", url: "/v1/tokens", headers: { cookie: a.cookie } })).tokens;
    assert.equal(list.length, 2);
    assert.ok(!JSON.stringify(list).includes("nc_pat_") || list.every((t: { prefix: string }) => t.prefix.length === 12));
    assert.ok(list.every((t: object) => !("secret" in t) && !("secret_hash" in t) && !("secretHash" in t)));
    assert.ok(list.find((t: { id: string }) => t.id === full.id).lastUsedAt);
    assert.equal((await inject({ method: "DELETE", url: `/v1/tokens/${full.id}`, headers: { cookie: a.cookie } })).statusCode, 200);
    assert.equal(json(await inject({ method: "GET", url: "/v1/me", headers: full.auth })).error.code, "auth.token_revoked");
    await h.s.db.query("UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE id = $1", [reader.id]);
    assert.equal(json(await inject({ method: "GET", url: "/v1/jobs", headers: reader.auth })).error.code, "auth.token_expired");
    // Unknown or malformed tokens are just not signed in; other people cannot revoke mine.
    assert.equal(json(await inject({ method: "GET", url: "/v1/me", headers: { authorization: "Bearer nc_pat_" + "A".repeat(32) } })).error.code, "auth.required");
    assert.equal(json(await inject({ method: "GET", url: "/v1/me", headers: { authorization: "Bearer nonsense" } })).error.code, "auth.required");
    const b = await signUp(h.app);
    assert.equal((await inject({ method: "DELETE", url: `/v1/tokens/${reader.id}`, headers: { cookie: b.cookie } })).statusCode, 404);
    // Bad requests.
    assert.equal((await inject({ method: "POST", url: "/v1/tokens", headers: { cookie: a.cookie }, payload: { name: "x", scopes: ["billing:write"] } })).statusCode, 400);
    assert.equal((await inject({ method: "POST", url: "/v1/tokens", headers: { cookie: a.cookie }, payload: { scopes: ["jobs:read"] } })).statusCode, 400);
  });
});

describe("prompt step", () => {
  // GM Cebi's spike narratives (docs/spikes/sketch-to-scene/scenes.json there).
  const spike: [string, string, string][] = [
      ["kopru", "Kurt sürüsü nehrin karşı yakasında, ahşap köprünün başında pusu kurmuş. Akşam, sisli bir orman.", "bridge"],
      ["han", "Kalabalık bir handa kavga çıkıyor. Tezgâhın önünde üç haydut, masalar devrilmiş, merdiven yukarı çıkıyor.", "tavern"],
      ["zindan", "Dar bir zindan koridoru köşeyi dönüyor. Ortada bir çukur tuzak, köşenin ardında bir iskelet bekliyor.", "dungeon"],
      ["orman-yolu", "Orman yolunda bir at arabası. Ağaçların arasından haydutlar oklarla saldırıyor.", "forest"],
      ["magara", "Kayalık bir yamaçta mağara girişi. Önünde büyük kayalar, aşağıda bir dere. Mağaradan bir ogre çıkıyor.", "cave"],
      ["sur", "Kale surları ve kapı. İki kulede okçular, kahramanlar yoldan kapıya yaklaşıyor.", "castle walls"],
  ];
  const creatures = ["wolf", "wolves", "ogre", "bandit", "bandits", "skeleton", "archer", "archers", "hero", "heroes"];
  const noCreatures = (p: string) => creatures.every((c) => !new RegExp(`\\b${c}\\b`, "i").test(p));

  it("writes an English prompt from a Turkish narrative without the LLM: terrain words, style words, no creatures", async () => {
    const { templatePrompt } = await import("../src/prompts.js");
    for (const [name, narrative, terrain] of spike)
      for (const mode of ["map", "atmosphere"] as const) {
        const w = templatePrompt(narrative, mode);
        const st = mode === "map" ? ["top-down fantasy battle map", "tabletop RPG map"] : ["fantasy landscape illustration"];
        for (const s of st) assert.ok(w.prompt.includes(s), `${name} ${mode}: ${w.prompt}`);
        assert.ok(w.prompt.includes(terrain), `${name}: ${w.prompt}`);
        assert.ok(noCreatures(w.prompt), `${name}: ${w.prompt}`);
        assert.ok(w.prompt.split(/\s+/).length <= 60);
      }
  });

  it("uses the LLM's answer, cleaned (style words, no creatures), and falls back to the template when it is slow or broken", async () => {
    const { LlmPromptWriter } = await import("../src/prompts.js");
    const http = await import("node:http");
    let answer = "";
    let delay = 0;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const sent = JSON.parse(body);
        assert.equal(req.headers["x-api-key"], "test-key");
        assert.match(sent.system, /Never mention creatures/);
        setTimeout(() => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ content: [{ type: "text", text: answer }] }));
        }, delay);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/messages`;
    const writer = new LlmPromptWriter("test-key", "claude-haiku-5-5", 300, url);
    try {
      answer = '{"prompt": "a wooden bridge over a misty river, a wolf pack on the far bank, evening light", "negative": "blurry"}';
      const w = await writer.write(spike[0]![1], "map");
      assert.equal(w.source, "llm");
      assert.ok(w.prompt.startsWith("top-down fantasy battle map, a wooden bridge"), w.prompt);
      assert.ok(w.prompt.endsWith("tabletop RPG map, detailed painted texture"), w.prompt);
      assert.ok(noCreatures(w.prompt) && !w.prompt.includes("pack on"), w.prompt);
      answer = "sorry, I cannot";
      const broken = await writer.write(spike[0]![1], "map");
      assert.equal(broken.source, "template");
      assert.ok(broken.prompt.includes("bridge"));
      delay = 1000;
      answer = '{"prompt": "late"}';
      const slow = await writer.write(spike[0]![1], "map");
      assert.equal(slow.source, "template");
      assert.equal(slow.fallbackReason, "llm timeout");
    } finally {
      server.close();
    }
  });

  it("records how the prompt came about on the job, and refuses filtered texts before anything is reserved", async () => {
    await gpuOnline();
    for (const [slug, kind] of [["dreamshaper-8", "sd"], ["controlnet-scribble", "controlnet"], ["lcm-lora-sd15", "lora"], ["taesd", "taesd"], ["nsfw-classifier", "onnx"]])
      await h.s.db.query(
        "INSERT INTO assets (owner_id, kind, model_kind, name, slug, license, status) VALUES (NULL, 'model', $1, $2, $2, 'test', 'ready') ON CONFLICT DO NOTHING",
        [kind, slug],
      );
    const a = await signUp(h.app);
    const sketch = { inline: PNG_1x1.toString("base64"), contentType: "image/png" };
    const submit = (params: object) => inject({ method: "POST", url: "/v1/presets/sketch_to_scene/jobs", headers: { cookie: a.cookie }, payload: { params, inputs: { sketch } } });
    const r = await submit({ mode: "map", narrative: spike[0]![1] });
    assert.equal(r.statusCode, 201, r.body);
    const job = json(r).job;
    const draw = job.workflow.steps.find((st: { op: string }) => st.op === "txt2img");
    assert.ok(draw.prompt.includes("bridge") && noCreatures(draw.prompt), draw.prompt);
    const info = (await h.s.db.query("SELECT prompt_info FROM jobs WHERE id = $1", [job.id])).rows[0].prompt_info;
    assert.equal(info.narrative, spike[0]![1]);
    assert.equal(info.source, "template");
    assert.equal(info.instructions, "sketch_to_scene/1");
    assert.equal(info.prompt, draw.prompt);
    await h.s.db.query("UPDATE jobs SET state = 'cancelled' WHERE id = $1", [job.id]);
    const before = Number((await h.s.db.query("SELECT count(*) AS n FROM jobs WHERE user_id = $1", [a.id])).rows[0].n);
    for (const params of [{ mode: "map", narrative: "Çıplak bir savaşçı nehirde yıkanıyor" }, { mode: "map", prompt: "nude figure on a bridge" }]) {
      const bad = await submit(params);
      assert.equal(bad.statusCode, 400);
      assert.equal(json(bad).error.code, "content.text_refused");
    }
    const both = await submit({ mode: "map", prompt: "a bridge", narrative: "köprü" });
    assert.equal(json(both).error.params.field, "narrative");
    const neither = await submit({ mode: "map" });
    assert.equal(json(neither).error.params.field, "prompt");
    assert.equal(Number((await h.s.db.query("SELECT count(*) AS n FROM jobs WHERE user_id = $1", [a.id])).rows[0].n), before);
  });
});

// A GPU worker seen just now (interactive presets are refused without one).
const gpuOnline = async () => {
  await inject({ method: "POST", url: "/v1/worker/register", headers: worker, payload: { class: "gpu", cores: 2, memoryBytes: 1, engineVersion: "test" } });
};
// Preset jobs through a fake GPU worker (moderation, retention).
const presetCatalog = async () => {
  await gpuOnline();
  for (const [slug, kind] of [["dreamshaper-8", "sd"], ["controlnet-scribble", "controlnet"], ["lcm-lora-sd15", "lora"], ["taesd", "taesd"], ["nsfw-classifier", "onnx"]])
    await h.s.db.query(
      "INSERT INTO assets (owner_id, kind, model_kind, name, slug, license, status) VALUES (NULL, 'model', $1, $2, $2, 'test', 'ready') ON CONFLICT DO NOTHING",
      [kind, slug],
    );
};
const credits = async (cookie: string) => json(await inject({ method: "GET", url: "/v1/me", headers: { cookie } })).credits as number;
// A preset job run through a fake GPU worker that uploads these files; returns the finished job.
const runPreset = async (auth: string | Record<string, string>, files: Record<string, Buffer>, sketch = PNG_1x1, timings?: object) => {
  const headers = typeof auth === "string" ? { cookie: auth } : auth;
  await presetCatalog();
  await h.s.db.query("UPDATE jobs SET state = 'cancelled' WHERE state = 'queued'");  // only this job to claim
  const sub = await inject({
    method: "POST",
    url: "/v1/presets/sketch_to_scene/jobs",
    headers,
    payload: { params: { mode: "map", narrative: "Nehrin üzerinde ahşap bir köprü" }, inputs: { sketch: { inline: sketch.toString("base64"), contentType: "image/png" } } },
  });
  assert.equal(sub.statusCode, 201, sub.body);
  const jobId = json(sub).job.id;
  const workerId = json(await inject({ method: "POST", url: "/v1/worker/register", headers: worker, payload: { class: "gpu", cores: 2, memoryBytes: 1, engineVersion: "test" } })).workerId;
  const claimed = json(await inject({ method: "POST", url: "/v1/worker/claim", headers: worker, payload: { workerId, loadedModels: [], waitSeconds: 0 } })).job;
  assert.equal(claimed.jobId, jobId);
  const names = Object.keys(files);
  const types = (n: string) => (n.endsWith(".json") ? "application/json" : "image/png");
  const up = json(await inject({ method: "POST", url: `/v1/worker/jobs/${jobId}/uploads`, headers: worker, payload: { workerId, outputs: names.map((name) => ({ name, bytes: files[name]!.length, contentType: types(name) })) } }));
  for (const u of up.uploads) assert.equal((await inject({ method: "PUT", url: local(u.url), payload: files[u.name]!, headers: { "content-type": "application/octet-stream" } })).statusCode, 200);
  const done = await inject({
    method: "POST",
    url: `/v1/worker/jobs/${jobId}/complete`,
    headers: worker,
    payload: { workerId, workerSeconds: 3, timings, outputs: up.uploads.map((u: { name: string; key: string }) => ({ name: u.name, key: u.key, bytes: files[u.name]!.length, sha256: "", contentType: types(u.name) })) },
  });
  assert.equal(done.statusCode, 200, done.body);
  return json(await inject({ method: "GET", url: `/v1/jobs/${jobId}`, headers })).job;
};
const scores = (nsfw: number) => Buffer.from(JSON.stringify({ model: "nsfw.onnx", labels: ["normal", "nsfw"], scores: { normal: 1 - nsfw, nsfw }, frames: [[1 - nsfw, nsfw]] }));
const outputAsset = async (jobId: string) => (await h.s.db.query("SELECT a.id, a.status FROM job_outputs o JOIN assets a ON a.id = o.asset_id WHERE o.job_id = $1 AND o.name = 'scene.png'", [jobId])).rows[0];

describe("moderation", () => {
  it("holds what a classifier stub flags: the job fails content.flagged, nothing is downloadable, the reservation comes back", async () => {
    const a = await signUp(h.app);
    const start = await credits(a.cookie);
    h.s.moderator = { judge: async () => ({ checked: true, flagged: true, scores: { nsfw: 0.99 }, reason: "nsfw" }) };
    try {
      const job = await runPreset(a.cookie, { "scene.png": PNG_1x1, "moderation.json": scores(0.01) });
      assert.equal(job.state, "failed");
      assert.equal(job.error.code, "content.flagged");
      assert.deepEqual(job.outputs, []);
      const out = await outputAsset(job.id);
      assert.equal(out.status, "held");
      assert.equal((await inject({ method: "GET", url: `/v1/assets/${out.id}/content`, headers: { cookie: a.cookie } })).statusCode, 404);
      assert.equal(await credits(a.cookie), start);
      const rep = (await h.s.db.query("SELECT source, reason, status, snapshot FROM reports WHERE asset_id = $1", [out.id])).rows[0];
      assert.deepEqual([rep.source, rep.reason, rep.status], ["classifier", "classifier", "open"]);
      assert.equal(rep.snapshot.prompt.narrative, "Nehrin üzerinde ahşap bir köprü");
      assert.equal(rep.snapshot.moderation.scores.nsfw, 0.99);
    } finally {
      h.s.moderator = undefined;
    }
  });

  it("reads the engine's scores: releases a clean result, holds one over the threshold and one without scores", async () => {
    const a = await signUp(h.app);
    const start = await credits(a.cookie);
    const clean = await runPreset(a.cookie, { "scene.png": PNG_1x1, "moderation.json": scores(0.02) });
    assert.equal(clean.state, "succeeded");
    assert.deepEqual(clean.outputs.map((o: { name: string }) => o.name), ["scene.png"]);  // the scores are not an output
    const m = (await h.s.db.query("SELECT moderation FROM jobs WHERE id = $1", [clean.id])).rows[0].moderation;
    assert.deepEqual([m.checked, m.flagged, m.scores.nsfw], [true, false, 0.02]);
    assert.equal((await inject({ method: "GET", url: `/v1/assets/${clean.outputs[0].assetId}/content`, headers: { cookie: a.cookie } })).statusCode, 302);
    assert.ok((await credits(a.cookie)) < start);
    const charged = await credits(a.cookie);
    const flagged = await runPreset(a.cookie, { "scene.png": PNG_1x1, "moderation.json": scores(0.8) });
    assert.equal(flagged.error.code, "content.flagged");
    const unchecked = await runPreset(a.cookie, { "scene.png": PNG_1x1 });
    assert.equal(unchecked.state, "failed");
    assert.equal(unchecked.error.code, "content.unchecked");
    assert.equal((await outputAsset(unchecked.id)).status, "held");
    assert.equal(await credits(a.cookie), charged);
  });

  it("takes reports from the owner once, and 404s everyone else", async () => {
    const a = await signUp(h.app);
    const b = await signUp(h.app);
    const job = await runPreset(a.cookie, { "scene.png": PNG_1x1, "moderation.json": scores(0.01) });
    const asset = job.outputs[0].assetId;
    const report = (who: string, payload: object) => inject({ method: "POST", url: `/v1/assets/${asset}/report`, headers: { cookie: who }, payload });
    const first = await report(a.cookie, { reason: "violence_gore", note: "kan var" });
    assert.equal(first.statusCode, 202, first.body);
    const again = await report(a.cookie, { reason: "violence_gore", note: "kan var" });
    assert.equal(again.statusCode, 202);
    assert.equal(json(again).report.id, json(first).report.id);
    assert.equal(Number((await h.s.db.query("SELECT count(*) AS n FROM reports WHERE asset_id = $1", [asset])).rows[0].n), 1);
    assert.equal((await report(b.cookie, { reason: "other" })).statusCode, 404);
    assert.equal((await inject({ method: "POST", url: "/v1/assets/00000000-0000-0000-0000-000000000000/report", headers: { cookie: a.cookie }, payload: { reason: "other" } })).statusCode, 404);
    const pic = await uploadPicture(h.app, a.cookie);  // only generated pictures are reported
    assert.equal((await inject({ method: "POST", url: `/v1/assets/${pic}/report`, headers: { cookie: a.cookie }, payload: { reason: "other" } })).statusCode, 404);
    for (const bad of [{ reason: "ugly" }, {}, { reason: "hate", note: "x".repeat(501) }, { reason: "hate", note: 5 }]) {
      const r = await report(a.cookie, bad);
      assert.equal(r.statusCode, 400);
      assert.equal(json(r).error.code, "report.invalid");
    }
    const row = (await h.s.db.query("SELECT r.reason, r.note, r.source, r.reporter_id, r.snapshot, a.reported_at FROM reports r JOIN assets a ON a.id = r.asset_id WHERE r.id = $1", [json(first).report.id])).rows[0];
    assert.deepEqual([row.reason, row.note, row.source, row.reporter_id], ["violence_gore", "kan var", "user", a.id]);
    assert.ok(row.reported_at);
    assert.ok(row.snapshot.prompt.prompt.includes("bridge"));
    assert.equal(row.snapshot.inputs[0].name, "sketch.png");
    assert.equal(json(await inject({ method: "GET", url: `/v1/jobs/${job.id}`, headers: { cookie: a.cookie } })).job.outputs.length, 1);  // still visible to its owner
  });

  it("lets an operator list reports, remove the asset (logged), dismiss and flag the account", async () => {
    const { listReports, showReport, removeReportedAsset, dismissReport, flagAccount } = await import("../src/moderation.js");
    const a = await signUp(h.app);
    const job = await runPreset(a.cookie, { "scene.png": PNG_1x1, "moderation.json": scores(0.01) });
    const asset = job.outputs[0].assetId;
    const id = json(await inject({ method: "POST", url: `/v1/assets/${asset}/report`, headers: { cookie: a.cookie }, payload: { reason: "sexual" } })).report.id;
    const open = await listReports(h.s.db);
    assert.ok(open.some((r) => r.id === id && r.reason === "sexual"));
    const shown = await showReport(h.s.db, h.s.storage, id);
    assert.ok(shown!.output && shown!.inputs[0]!.url);
    const file = await inject({ method: "GET", url: local(shown!.output!) });
    assert.deepEqual(file.rawPayload, PNG_1x1);
    await flagAccount(h.s.db, id, "ayse", "tekrar ederse kapat");
    assert.ok((await h.s.db.query("SELECT flagged_at FROM users WHERE id = $1", [a.id])).rows[0].flagged_at);
    await removeReportedAsset(h.s.db, id, "ayse", "müstehcen");
    assert.equal((await inject({ method: "GET", url: `/v1/assets/${asset}/content`, headers: { cookie: a.cookie } })).statusCode, 404);
    assert.equal(json(await inject({ method: "GET", url: `/v1/jobs/${job.id}`, headers: { cookie: a.cookie } })).job.outputs.length, 0);
    assert.ok(!(await listReports(h.s.db)).some((r) => r.id === id));
    assert.equal((await listReports(h.s.db, { status: "all" })).find((r) => r.id === id)!.status, "removed");
    const logged = (await h.s.db.query("SELECT operator, action, asset_id, user_id, note FROM moderation_log WHERE report_id = $1 ORDER BY id", [id])).rows;
    assert.deepEqual(logged.map((l) => l.action), ["flag_account", "remove_asset"]);
    assert.deepEqual([logged[1].operator, logged[1].asset_id, logged[1].user_id, logged[1].note], ["ayse", asset, a.id, "müstehcen"]);
    // The classifier's held outputs are in the queue too; dismissing keeps them held.
    h.s.moderator = { judge: async () => ({ checked: true, flagged: true, scores: { nsfw: 0.9 } }) };
    const held = await runPreset(a.cookie, { "scene.png": PNG_1x1 }).finally(() => (h.s.moderator = undefined));
    const heldAsset = await outputAsset(held.id);
    const auto = (await listReports(h.s.db)).find((r) => r.asset_id === heldAsset.id)!;
    assert.equal(auto.source, "classifier");
    await dismissReport(h.s.db, auto.id, "ayse");
    assert.equal((await outputAsset(held.id)).status, "held");
    await assert.rejects(dismissReport(h.s.db, auto.id, "ayse"));
  });
});

describe("retention", () => {
  const unique = () => Buffer.concat([PNG_1x1, randomBytes(16)]);  // a valid header, bytes of its own
  const later = (hours: number) => new Date(Date.now() + hours * 3600_000);
  const blobFile = async (assetId: string) => {
    const { blobKey, LocalStorage } = await import("../src/storage.js");
    const sha = (await h.s.db.query("SELECT sha256 FROM assets WHERE id = $1", [assetId])).rows[0].sha256 as string;
    return (h.s.storage as InstanceType<typeof LocalStorage>).path(blobKey(sha));
  };
  const exists = async (assetId: string) => (await h.s.db.query("SELECT 1 FROM assets WHERE id = $1", [assetId])).rowCount === 1;
  const clean = async (hours: number) => (await import("../src/retention.js")).runRetention(h.s.db, h.s.storage, later(hours));

  it("deletes a preset job's sketch and narrative after a day and its result after a week; the job row stays", async () => {
    const a = await signUp(h.app);
    const job = await runPreset(a.cookie, { "scene.png": unique(), "moderation.json": scores(0.01) }, unique());
    const input = (await h.s.db.query("SELECT a.id FROM jobs j JOIN assets a ON a.id = ANY(j.files) WHERE j.id = $1 AND a.kind = 'input'", [job.id])).rows[0].id as string;
    const inputFile = await blobFile(input), output = job.outputs[0].assetId as string, outputFile = await blobFile(output);
    assert.ok(existsSync(inputFile) && existsSync(outputFile));

    await clean(23);
    assert.ok(await exists(input));
    const r = await clean(25);
    assert.ok(r.assets >= 1 && r.jobs >= 1);
    assert.ok(!(await exists(input)) && !existsSync(inputFile));
    assert.ok(await exists(output) && existsSync(outputFile));
    const row = (await h.s.db.query("SELECT prompt_info, workflow, worker_seconds, preset, scrubbed_at FROM jobs WHERE id = $1", [job.id])).rows[0];
    assert.deepEqual(row.prompt_info, { source: "template", instructions: "sketch_to_scene/1", fallback: "no llm configured", scrubbed: true });
    assert.ok(!JSON.stringify(row.workflow).includes("bridge") && !JSON.stringify(row.workflow).includes("Nehrin"));
    assert.equal(row.workflow.steps.find((st: { op: string }) => st.op === "txt2img").prompt, undefined);
    assert.deepEqual([row.worker_seconds, row.preset], [3, "sketch_to_scene"]);
    assert.ok(row.scrubbed_at);

    await clean(7 * 24 + 1);
    assert.ok(!(await exists(output)) && !existsSync(outputFile));
    const after = json(await inject({ method: "GET", url: `/v1/jobs/${job.id}`, headers: { cookie: a.cookie } })).job;
    assert.deepEqual([after.state, after.outputs], ["succeeded", []]);
  });

  it("keeps shared bytes and reported evidence; removed assets, abandoned uploads and deleted accounts go", async () => {
    const { dismissReport } = await import("../src/moderation.js");
    const a = await signUp(h.app);
    const b = await signUp(h.app);
    // The same picture: a's upload (kept) and b's inline sketch (expires): the bytes stay for a.
    const shared = unique();
    const kept = await uploadPicture(h.app, a.cookie, shared);
    const job = await runPreset(b.cookie, { "scene.png": unique(), "moderation.json": scores(0.01) }, shared);
    const sharedFile = await blobFile(kept);
    // b reports the result: it stays past its week until the report is resolved.
    const output = job.outputs[0].assetId as string;
    const rep = json(await inject({ method: "POST", url: `/v1/assets/${output}/report`, headers: { cookie: b.cookie }, payload: { reason: "other" } })).report.id;
    await clean(8 * 24);
    assert.ok(existsSync(sharedFile) && (await exists(kept)));
    assert.ok(await exists(output));
    const reportRow = (await h.s.db.query("SELECT snapshot FROM reports WHERE id = $1", [rep])).rows[0];
    assert.equal(reportRow.snapshot.prompt.narrative, "Nehrin üzerinde ahşap bir köprü");  // evidence until resolved
    assert.ok((await h.s.db.query("SELECT prompt_info FROM jobs WHERE id = $1", [job.id])).rows[0].prompt_info.narrative);
    await dismissReport(h.s.db, rep, "ayse");
    await clean(8 * 24);
    assert.ok(!(await exists(output)));
    assert.equal((await h.s.db.query("SELECT asset_id FROM reports WHERE id = $1", [rep])).rows[0].asset_id, null);  // the record stays
    assert.ok(!(await h.s.db.query("SELECT prompt_info FROM jobs WHERE id = $1", [job.id])).rows[0].prompt_info.narrative);
    await clean(8 * 24 + 31 * 24);
    assert.equal((await h.s.db.query("SELECT snapshot FROM reports WHERE id = $1", [rep])).rows[0].snapshot.prompt, undefined);

    // a removes the picture: row and (now unshared) bytes go at the next cleanup.
    assert.equal((await inject({ method: "DELETE", url: `/v1/assets/${kept}`, headers: { cookie: a.cookie } })).statusCode, 200);
    await clean(2);
    assert.ok(!(await exists(kept)) && !existsSync(sharedFile));

    // An upload never completed goes after a day.
    const started = json(await inject({ method: "POST", url: "/v1/assets", headers: { cookie: a.cookie }, payload: { name: "x.png", kind: "input", bytes: 10, contentType: "image/png" } })).asset.id;
    await clean(1);
    assert.ok(await exists(started));
    await clean(25);
    assert.ok(!(await exists(started)));

    // Deleting the account: the password confirms it; everything it owned goes.
    const c = await signUp(h.app);
    const mine = await uploadPicture(h.app, c.cookie, unique());
    const mineFile = await blobFile(mine);
    assert.equal((await inject({ method: "DELETE", url: "/v1/me", headers: { cookie: c.cookie }, payload: { password: "wrong" } })).statusCode, 401);
    assert.equal((await inject({ method: "DELETE", url: "/v1/me", headers: { cookie: c.cookie }, payload: { password: "correct horse battery" } })).statusCode, 200);
    assert.equal((await inject({ method: "GET", url: "/v1/me", headers: { cookie: c.cookie } })).statusCode, 401);
    assert.ok(!(await exists(mine)));
    await clean(2);
    assert.ok(!existsSync(mineFile));
  });

  it("keeps interactive presets to the configured regions", async () => {
    const a = await signUp(h.app);
    await presetCatalog();
    await h.s.db.query("UPDATE jobs SET state = 'cancelled' WHERE state = 'queued'");
    h.s.config.interactiveRegions = ["eu"];
    try {
      const submit = () => inject({ method: "POST", url: "/v1/presets/sketch_to_scene/jobs", headers: { cookie: a.cookie }, payload: { params: { mode: "map", prompt: "a bridge" }, inputs: { sketch: { inline: PNG_1x1.toString("base64"), contentType: "image/png" } } } });
      const register = async (region?: string) =>
        json(await inject({ method: "POST", url: "/v1/worker/register", headers: worker, payload: { class: "gpu", cores: 2, memoryBytes: 1, engineVersion: "test", ...(region ? { region } : {}) } })).workerId as string;
      const claim = async (workerId: string) => json(await inject({ method: "POST", url: "/v1/worker/claim", headers: worker, payload: { workerId, loadedModels: [], waitSeconds: 0 } })).job;
      await h.s.db.query("UPDATE workers SET last_seen_at = now() - interval '1 hour' WHERE capabilities ->> 'region' = 'eu'");
      // GPU workers elsewhere do not count: the job is refused while no EU worker is about.
      await register("us");
      assert.equal(json(await submit()).error.code, "job.no_gpu_worker");
      const eu = await register("eu");
      const sub = await submit();
      assert.equal(sub.statusCode, 201, sub.body);
      assert.equal(await claim(await register()), null);
      assert.equal(await claim(await register("us")), null);
      assert.equal((await claim(eu)).jobId, json(sub).job.id);
    } finally {
      h.s.config.interactiveRegions = [];
    }
  });

  it("keeps signed storage tokens and query strings out of request logs", async () => {
    const { logUrl } = await import("../src/app.js");
    assert.equal(logUrl("/v1/storage/eyJrIjoiYmxvYnMvYWJjIn0.c2ln"), "/v1/storage/<signed>");
    assert.equal(logUrl("/v1/jobs/1?limit=5"), "/v1/jobs/1");
    assert.equal(logUrl("/v1/presets/sketch_to_scene/jobs"), "/v1/presets/sketch_to_scene/jobs");
  });
});

describe("partner apps", () => {
  // A partner account with an app token for its app and a partner:manage token for its server.
  const partner = async () => {
    const { createToken } = await import("../src/auth.js");
    const p = await signUp(h.app);
    const app = await createToken(h.s.db, p.id, "app", "GM Cebi", ["jobs:submit", "jobs:read", "assets:read", "assets:write"], null);
    const server = await createToken(h.s.db, p.id, "app", "GM Cebi server", ["partner:manage"], null);
    const as = (endUser?: string) => ({ authorization: `Bearer ${app.secret}`, ...(endUser ? { "x-end-user": endUser } : {}) });
    return { p, as, server: { authorization: `Bearer ${server.secret}` } };
  };
  const sketch = { inline: PNG_1x1.toString("base64"), contentType: "image/png" };
  const submit = (headers: Record<string, string>, inputs: object = { sketch }) =>
    inject({ method: "POST", url: "/v1/presets/sketch_to_scene/jobs", headers, payload: { params: { mode: "map", prompt: "a wooden bridge" }, inputs } });

  it("keeps two end users of one partner apart, and needs X-End-User on app tokens", async () => {
    await presetCatalog();
    const { p, as } = await partner();
    const none = await submit(as());
    assert.equal(none.statusCode, 400);
    assert.equal(json(none).error.code, "partner.end_user_required");
    assert.equal((await submit(as("bad id with spaces"))).statusCode, 400);
    assert.equal((await inject({ method: "GET", url: "/v1/jobs", headers: as() })).statusCode, 400);

    const a = await submit(as("install-a"));
    assert.equal(a.statusCode, 201, a.body);
    const jobA = json(a).job.id;
    await h.s.db.query("UPDATE jobs SET state = 'succeeded' WHERE id = $1", [jobA]);
    const sketchA = (await h.s.db.query("SELECT files FROM jobs WHERE id = $1", [jobA])).rows[0].files[0];
    assert.equal((await h.s.db.query("SELECT end_user FROM jobs WHERE id = $1", [jobA])).rows[0].end_user, "install-a");
    assert.equal((await h.s.db.query("SELECT end_user FROM assets WHERE id = $1", [sketchA])).rows[0].end_user, "install-a");

    assert.deepEqual(json(await inject({ method: "GET", url: "/v1/jobs", headers: as("install-a") })).jobs.map((j: { id: string }) => j.id), [jobA]);
    assert.deepEqual(json(await inject({ method: "GET", url: "/v1/jobs", headers: as("install-b") })).jobs, []);
    assert.equal((await inject({ method: "GET", url: `/v1/jobs/${jobA}`, headers: as("install-b") })).statusCode, 404);
    assert.equal((await inject({ method: "GET", url: `/v1/assets/${sketchA}/content`, headers: as("install-b") })).statusCode, 404);
    assert.equal((await inject({ method: "GET", url: `/v1/assets/${sketchA}/content`, headers: as("install-a") })).statusCode, 302);
    assert.deepEqual(json(await inject({ method: "GET", url: "/v1/assets", headers: as("install-b") })).assets, []);
    // b cannot use a's sketch; the partner's own session sees neither end user's files.
    const stolen = await submit(as("install-b"), { sketch: `asset:${sketchA}` });
    assert.equal(json(stolen).error.code, "workflow.asset_missing");
    assert.deepEqual(json(await inject({ method: "GET", url: "/v1/jobs", headers: { cookie: p.cookie } })).jobs, []);
  });

  it("refuses an end user's job past the daily quota before reserving anything", async () => {
    await presetCatalog();
    const { p, as } = await partner();
    await h.s.db.query("INSERT INTO partners (user_id, end_user_daily_jobs) VALUES ($1, 2)", [p.id]);
    const done = async (r: { body: string }) => h.s.db.query("UPDATE jobs SET state = 'succeeded' WHERE id = $1", [JSON.parse(r.body).job.id]);
    await done(await submit(as("install-a")));
    const second = await submit(as("install-a"));
    assert.equal(second.statusCode, 201);
    const reserves = async () => Number((await h.s.db.query("SELECT count(*) AS n FROM ledger WHERE user_id = $1 AND kind = 'reserve'", [p.id])).rows[0].n);
    const before = await reserves();
    const third = await submit(as("install-a"));
    assert.equal(third.statusCode, 429);
    assert.equal(json(third).error.code, "quota.end_user_daily");
    assert.equal(json(third).error.params.limit, 2);
    assert.ok(new Date(json(third).error.params.resetsAt) > new Date());
    assert.equal(await reserves(), before);
    // Another end user has their own day; a job cancelled while queued gives the slot back.
    const b = await submit(as("install-b"));
    assert.equal(b.statusCode, 201);
    await done(b);
    assert.equal((await inject({ method: "POST", url: `/v1/jobs/${json(second).job.id}/cancel`, headers: as("install-a") })).json().state, "cancelled");
    assert.equal((await submit(as("install-a"))).statusCode, 201);
    const usage = json(await inject({ method: "GET", url: "/v1/partner/end-users/install-a/usage", headers: as("install-a") }));
    assert.deepEqual([usage.today.used, usage.today.limit], [2, 2]);
  });

  it("deletes everything of one end user (idempotent) and exports their usage", async () => {
    const { p, as, server } = await partner();
    const job = await runPreset(as("install-a"), { "scene.png": Buffer.concat([PNG_1x1, randomBytes(8)]), "moderation.json": scores(0.01) });
    assert.equal(job.state, "succeeded");
    await submit(as("install-b"));
    const usage = await inject({ method: "GET", url: "/v1/partner/end-users/install-a/usage", headers: as("install-a") });
    assert.equal(usage.statusCode, 200);
    const row = json(usage).jobs[0];
    assert.deepEqual([row.jobId, row.preset, row.state], [job.id, "sketch_to_scene", "succeeded"]);
    assert.ok(row.charged > 0);
    assert.equal((await inject({ method: "GET", url: "/v1/partner/end-users/install-a/usage", headers: as("install-b") })).statusCode, 403);
    assert.equal((await inject({ method: "GET", url: "/v1/partner/end-users/install-a/usage", headers: server })).statusCode, 200);
    assert.equal((await inject({ method: "GET", url: "/v1/partner/end-users/install-a/usage", headers: { cookie: p.cookie } })).statusCode, 403);

    const del = await inject({ method: "DELETE", url: "/v1/partner/end-users/install-a", headers: as("install-a") });
    assert.equal(del.statusCode, 200);
    assert.deepEqual(json(del).deleted, { assets: 2, jobs: 1 });  // the sketch, the scene; the job
    assert.equal(Number((await h.s.db.query("SELECT count(*) AS n FROM assets WHERE owner_id = $1 AND end_user = 'install-a'", [p.id])).rows[0].n), 0);
    assert.equal((await inject({ method: "GET", url: `/v1/jobs/${job.id}`, headers: as("install-a") })).statusCode, 404);
    assert.deepEqual(json(await inject({ method: "DELETE", url: "/v1/partner/end-users/install-a", headers: as("install-a") })).deleted, { assets: 0, jobs: 0 });
    // The partner's server deletes b, whose job is still queued: cancelled, nothing charged, nothing left.
    const b = await inject({ method: "DELETE", url: "/v1/partner/end-users/install-b", headers: server });
    assert.equal(json(b).deleted.assets, 1);
    assert.equal(Number((await h.s.db.query("SELECT count(*) AS n FROM jobs WHERE user_id = $1 AND end_user = 'install-b'", [p.id])).rows[0].n), 0);
    assert.equal(Number((await h.s.db.query("SELECT coalesce(sum(amount), 0) AS n FROM ledger WHERE user_id = $1 AND kind IN ('reserve', 'release')", [p.id])).rows[0].n), 0);
    assert.equal((await inject({ method: "DELETE", url: "/v1/partner/end-users/install-b", headers: as("install-a") })).statusCode, 403);
  });
});

describe("interactive jobs", () => {
  const submitPreset = (cookie: string) =>
    inject({ method: "POST", url: "/v1/presets/sketch_to_scene/jobs", headers: { cookie }, payload: { params: { mode: "map", prompt: "a bridge" }, inputs: { sketch: { inline: PNG_1x1.toString("base64"), contentType: "image/png" } } } });
  const register = async (cls: "cpu" | "gpu") =>
    json(await inject({ method: "POST", url: "/v1/worker/register", headers: worker, payload: { class: cls, cores: 2, memoryBytes: 1, engineVersion: "test" } })).workerId as string;
  const claim = async (workerId: string) => json(await inject({ method: "POST", url: "/v1/worker/claim", headers: worker, payload: { workerId, loadedModels: [], waitSeconds: 0 } })).job;
  const noGpu = () => h.s.db.query("UPDATE workers SET last_seen_at = now() - interval '1 hour'");

  it("claims interactive jobs before batch GPU jobs and never gives them to CPU workers", async () => {
    await presetCatalog();
    await h.s.db.query("UPDATE jobs SET state = 'cancelled' WHERE state = 'queued'");
    const a = await signUp(h.app);
    const b = await signUp(h.app);
    // An older batch GPU job (another user), then an interactive one.
    const batch = json(await submitPreset(b.cookie)).job.id;
    await h.s.db.query("UPDATE jobs SET latency = 'batch', created_at = now() - interval '1 minute' WHERE id = $1", [batch]);
    const interactive = json(await submitPreset(a.cookie)).job.id;
    assert.equal((await h.s.db.query("SELECT latency, preset_variant FROM jobs WHERE id = $1", [interactive])).rows[0].latency, "interactive");
    // No GPU about: a CPU worker takes the batch GPU job, never the interactive one.
    await noGpu();
    const cpu = await register("cpu");
    assert.equal((await claim(cpu)).jobId, batch);
    assert.equal(await claim(cpu), null);
    // A GPU worker takes it (and would have taken it before the older batch job).
    await h.s.db.query("UPDATE jobs SET state = 'queued', worker_id = NULL WHERE id = $1", [batch]);
    const gpu = await register("gpu");
    assert.equal((await claim(gpu)).jobId, interactive);
    // A worker kept for interactive jobs leaves the batch job alone.
    const kept = json(await inject({ method: "POST", url: "/v1/worker/register", headers: worker, payload: { class: "gpu", cores: 2, memoryBytes: 1, engineVersion: "test", interactiveOnly: true } })).workerId;
    assert.equal(await claim(kept), null);
    assert.equal((await claim(gpu)).jobId, batch);
    const t = (await h.s.db.query("SELECT claimed_at, timings FROM jobs WHERE id = $1", [interactive])).rows[0];
    assert.ok(t.claimed_at);
    assert.equal(t.timings.warm, false);
  });

  it("refuses an interactive job at once when no GPU worker was seen lately; a busy one counts", async () => {
    await presetCatalog();
    const a = await signUp(h.app);
    await noGpu();
    const started = Date.now();
    const r = await submitPreset(a.cookie);
    assert.ok(Date.now() - started < 1000);
    assert.equal(r.statusCode, 503);
    assert.equal(json(r).error.code, "job.no_gpu_worker");
    assert.equal(Number((await h.s.db.query("SELECT count(*) AS n FROM jobs WHERE user_id = $1", [a.id])).rows[0].n), 0);
    assert.equal(Number((await h.s.db.query("SELECT count(*) AS n FROM ledger WHERE user_id = $1 AND kind = 'reserve'", [a.id])).rows[0].n), 0);
    // A GPU worker busy with a long job heartbeats instead of claiming: it is still about.
    await h.s.db.query("UPDATE jobs SET state = 'cancelled' WHERE state = 'queued'");
    const gpu = await register("gpu");
    const b = await signUp(h.app);
    const long = json(await submitPreset(b.cookie)).job.id;
    assert.equal((await claim(gpu)).jobId, long);
    await noGpu();
    assert.equal((await inject({ method: "POST", url: `/v1/worker/jobs/${long}/heartbeat`, headers: worker, payload: { workerId: gpu } })).statusCode, 200);
    assert.equal((await submitPreset(a.cookie)).statusCode, 201);
  });

  it("records where each job's time went and gives operators percentiles per preset and mode", async () => {
    const { latencyStats } = await import("../src/latency.js");
    const since = new Date(Date.now() - 1000);
    const a = await signUp(h.app);
    for (const run of [1, 2, 3])
      await runPreset(a.cookie, { "scene.png": PNG_1x1, "moderation.json": scores(0.01) }, PNG_1x1, { fetchSeconds: 0.1, loadSeconds: run === 1 ? 40 : 0, runSeconds: run, uploadSeconds: 0.05, bogus: 9 });
    const t = (await h.s.db.query("SELECT timings FROM jobs WHERE user_id = $1 ORDER BY created_at LIMIT 1", [a.id])).rows[0].timings;
    assert.deepEqual([t.fetchSeconds, t.loadSeconds, t.runSeconds, t.uploadSeconds, t.bogus], [0.1, 40, 1, 0.05, undefined]);
    assert.ok(t.queueSeconds >= 0 && t.totalSeconds >= t.queueSeconds);
    const rows = (await latencyStats(h.s.db, since)).filter((r) => r.preset === "sketch_to_scene" && r.variant === "map");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.jobs, 3);
    assert.equal(rows[0]!.run.p50, 2);
    assert.ok(rows[0]!.run.p95 > 2.8 && rows[0]!.load.p95 > 30);
    assert.equal(rows[0]!.warm, 0);
  });
});

describe("partner allowances", () => {
  it("grants allowance from the partner's server only, idempotent on externalRef; jobs draw on it", async () => {
    const { createToken } = await import("../src/auth.js");
    await presetCatalog();
    const p = await signUp(h.app);
    const app = await createToken(h.s.db, p.id, "app", "GM Cebi", ["jobs:submit", "jobs:read", "assets:read"], null);
    const server = { authorization: `Bearer ${(await createToken(h.s.db, p.id, "app", "GM Cebi server", ["partner:manage"], null)).secret}` };
    const as = (e: string) => ({ authorization: `Bearer ${app.secret}`, "x-end-user": e });
    await h.s.db.query("INSERT INTO partners (user_id, allowance_required) VALUES ($1, true)", [p.id]);
    const grant = (headers: Record<string, string>, body: object) => inject({ method: "POST", url: "/v1/partner/end-users/install-a/allowance", headers, payload: body });

    // The app cannot grant itself credits.
    const self = await grant(as("install-a"), { credits: 10, externalRef: "GPA.1" });
    assert.equal(self.statusCode, 403);
    assert.equal(json(self).error.code, "auth.scope_missing");
    assert.equal((await grant(server, { credits: -1, externalRef: "x" })).statusCode, 400);
    assert.equal((await grant(server, { credits: 5 })).statusCode, 400);

    // No allowance yet: refused before anything is reserved.
    const submit = () => inject({ method: "POST", url: "/v1/presets/sketch_to_scene/jobs", headers: as("install-a"), payload: { params: { mode: "map", prompt: "a bridge" }, inputs: { sketch: { inline: PNG_1x1.toString("base64"), contentType: "image/png" } } } });
    const broke = await submit();
    assert.equal(broke.statusCode, 402);
    assert.equal(json(broke).error.code, "allowance.insufficient");
    assert.deepEqual(json(broke).error.params, { needed: 5000, balance: 0 });
    assert.equal(Number((await h.s.db.query("SELECT count(*) AS n FROM ledger WHERE user_id = $1 AND kind = 'reserve'", [p.id])).rows[0].n), 0);

    const first = await grant(server, { credits: 8, reason: "pack of 8", externalRef: "GPA.3392-1" });
    assert.equal(first.statusCode, 201);
    assert.equal(json(first).balance, 8000);
    const again = await grant(server, { credits: 8, reason: "pack of 8", externalRef: "GPA.3392-1" });
    assert.equal(again.statusCode, 200);
    assert.equal(json(again).grant.id, json(first).grant.id);
    assert.equal(json(again).balance, 8000);

    // A job: the reservation comes out of the allowance, then only what it used.
    const job = await runPreset(as("install-a"), { "scene.png": PNG_1x1, "moderation.json": scores(0.01) });
    assert.equal(job.state, "succeeded");
    const usage = json(await inject({ method: "GET", url: "/v1/partner/end-users/install-a/usage", headers: server }));
    const charged = usage.jobs[0].charged;
    assert.equal(usage.allowance.balance, 8000 - charged);
    assert.deepEqual(usage.allowance.entries.map((e: { kind: string }) => e.kind), ["use", "release", "reserve", "grant"]);
    assert.equal(usage.allowance.entries[3].externalRef, "GPA.3392-1");
    // Another end user has none of it.
    assert.equal(json(await inject({ method: "POST", url: "/v1/presets/sketch_to_scene/jobs", headers: as("install-b"), payload: { params: { mode: "map", prompt: "a bridge" }, inputs: { sketch: { inline: PNG_1x1.toString("base64"), contentType: "image/png" } } } })).error.code, "allowance.insufficient");
    // A held result costs the end user nothing.
    const before = usage.allowance.balance;
    h.s.moderator = { judge: async () => ({ checked: true, flagged: true, scores: { nsfw: 0.9 } }) };
    await runPreset(as("install-a"), { "scene.png": PNG_1x1 }).finally(() => (h.s.moderator = undefined));
    assert.equal(json(await inject({ method: "GET", url: "/v1/partner/end-users/install-a/usage", headers: server })).allowance.balance, before);
  });
});

describe("sessions and on-demand GPUs", () => {
  const appUser = async () => {
    const { createToken } = await import("../src/auth.js");
    const p = await signUp(h.app);
    const t = await createToken(h.s.db, p.id, "app", "GM Cebi", ["jobs:submit", "jobs:read", "assets:read"], null);
    return { p, as: (e: string) => ({ authorization: `Bearer ${t.secret}`, "x-end-user": e }) };
  };
  const noWorkers = () => h.s.db.query("UPDATE workers SET last_seen_at = now() - interval '1 hour'");
  const open = (headers: Record<string, string>) => inject({ method: "POST", url: "/v1/sessions", headers });

  it("opens one session per end user, keeps it with heartbeats, closes it, and limits a partner", async () => {
    await noWorkers();
    const { p, as } = await appUser();
    const first = await open(as("install-a"));
    assert.equal(first.statusCode, 201, first.body);
    const s1 = json(first);
    assert.equal(s1.session.heartbeatSeconds, 120);
    assert.deepEqual(s1.capacity, { state: "unavailable", reason: "no GPU worker" });  // no provider here, no GPU
    const again = await open(as("install-a"));
    assert.equal(again.statusCode, 200);
    assert.equal(json(again).session.id, s1.session.id);
    const hb = await inject({ method: "POST", url: `/v1/sessions/${s1.session.id}/heartbeat`, headers: as("install-a") });
    assert.equal(hb.statusCode, 200);
    assert.equal((await inject({ method: "POST", url: `/v1/sessions/${s1.session.id}/heartbeat`, headers: as("install-b") })).statusCode, 404);
    // A partner may hold max_sessions open at once.
    await h.s.db.query("INSERT INTO partners (user_id, max_sessions) VALUES ($1, 1)", [p.id]);
    const limited = await open(as("install-b"));
    assert.equal(limited.statusCode, 429);
    assert.equal(json(limited).error.code, "session.limit");
    assert.equal((await inject({ method: "DELETE", url: `/v1/sessions/${s1.session.id}`, headers: as("install-a") })).statusCode, 200);
    const gone = await inject({ method: "POST", url: `/v1/sessions/${s1.session.id}/heartbeat`, headers: as("install-a") });
    assert.equal(gone.statusCode, 410);
    assert.equal(json(gone).error.code, "session.closed");
    assert.equal((await open(as("install-b"))).statusCode, 201);
    // Without heartbeats a session is closed by the manager's next look.
    const { CapacityManager } = await import("../src/capacity.js");
    const m = new CapacityManager(h.s.db, h.s.config.capacity, h.s.config.sessions, null);
    const r = await m.tick(new Date(Date.now() + 11 * 60_000));
    assert.ok(r!.closed >= 1);
    const row = (await h.s.db.query("SELECT close_reason FROM app_sessions WHERE user_id = $1 AND end_user = 'install-b'", [p.id])).rows[0];
    assert.equal(row.close_reason, "expired");
  });

  it("rents a GPU pod for open sessions, queues jobs while it starts, and gives it back after the grace", async () => {
    const { CapacityManager, CapacityUnavailable } = await import("../src/capacity.js");
    const pods = new Map<string, { name: string; status: "starting" | "running" | "stopped" }>();
    let fail: "none" | "capacity" = "none";
    let n = 0;
    const provider = {
      name: "fake",
      rent: async (spec: { id: string; name: string }) => {
        if (fail === "capacity") throw new CapacityUnavailable("no GPUs");
        const providerId = `fake-${++n}`;
        pods.set(providerId, { name: spec.name, status: "starting" });
        return { providerId, gpuType: "RTX A5000", region: "EU-RO-1", pricePerHour: 0.27 };
      },
      terminate: async (id: string) => void pods.delete(id),
      list: async () => [...pods.entries()].map(([providerId, p]) => ({ providerId, ...p })),
    };
    const cfg = { ...h.s.config.capacity, provider: "runpod" as const, dailyBudgetUsd: 10 };
    const saved = h.s.config.capacity;
    h.s.config.capacity = cfg;
    const m = new CapacityManager(h.s.db, cfg, h.s.config.sessions, provider);
    h.s.capacity = m;
    try {
      await h.s.db.query("UPDATE app_sessions SET closed_at = now() - interval '1 day', close_reason = coalesce(close_reason, 'closed')");
      await h.s.db.query("UPDATE gpu_pods SET state = 'stopped' WHERE state IN ('requested', 'starting', 'running', 'draining')");
      await h.s.db.query("UPDATE jobs SET state = 'cancelled' WHERE state = 'queued'");
      await noWorkers();
      assert.deepEqual((await m.tick())!.rented, []);  // nobody asks
      await presetCatalog();
      await noWorkers();  // (presetCatalog brought a GPU worker online)

      const { as } = await appUser();
      const opened = json(await open(as("table-1")));
      await new Promise((r) => setTimeout(r, 50));  // the kick from opening runs a tick
      await m.tick();
      const live = (await h.s.db.query("SELECT id, provider_id, state, price_per_hour FROM gpu_pods WHERE state IN ('requested', 'starting', 'running')")).rows;
      assert.equal(live.length, 1);
      assert.equal(live[0].state, "starting");
      assert.equal(pods.size, 1);
      const hb = json(await inject({ method: "POST", url: `/v1/sessions/${opened.session.id}/heartbeat`, headers: as("table-1") }));
      assert.equal(hb.capacity.state, "warming");
      assert.ok(hb.capacity.etaSeconds > 0 && hb.capacity.etaSeconds <= 90);

      // A job while the pod starts waits for it (no job.no_gpu_worker) and keeps the session asking.
      const sub = await inject({ method: "POST", url: "/v1/presets/sketch_to_scene/jobs", headers: as("table-1"), payload: { params: { mode: "map", prompt: "a bridge" }, inputs: { sketch: { inline: PNG_1x1.toString("base64"), contentType: "image/png" } } } });
      assert.equal(sub.statusCode, 201, sub.body);
      const tied = (await h.s.db.query("SELECT session_id FROM jobs WHERE id = $1", [json(sub).job.id])).rows[0].session_id;
      assert.equal(tied, opened.session.id);

      // The pod's worker registers: the pod is running, the session's capacity ready.
      const workerId = json(await inject({ method: "POST", url: "/v1/worker/register", headers: worker, payload: { class: "gpu", cores: 8, memoryBytes: 1, engineVersion: "test", interactiveOnly: true, podId: live[0].id } })).workerId;
      const pod = (await h.s.db.query("SELECT state, worker_id FROM gpu_pods WHERE id = $1", [live[0].id])).rows[0];
      assert.deepEqual([pod.state, pod.worker_id], ["running", workerId]);
      assert.equal(json(await inject({ method: "POST", url: `/v1/sessions/${opened.session.id}/heartbeat`, headers: as("table-1") })).capacity.state, "ready");
      assert.deepEqual((await m.tick())!.rented, []);  // one session: one pod
      await h.s.db.query("UPDATE jobs SET state = 'cancelled' WHERE id = $1", [json(sub).job.id]);

      // The session ends: the pod stays through the grace, then drains and is stopped.
      await inject({ method: "DELETE", url: `/v1/sessions/${opened.session.id}`, headers: as("table-1") });
      assert.deepEqual((await m.tick())!.drained, []);
      const later = new Date(Date.now() + 16 * 60_000);
      await h.s.db.query("UPDATE workers SET last_seen_at = $2 WHERE id = $1", [workerId, later]);
      const r = await m.tick(later);
      assert.deepEqual(r!.drained, [live[0].id]);
      assert.ok(r!.stopped.includes(live[0].id));  // idle: drained and stopped in the same look
      assert.equal(pods.size, 0);
      assert.equal(json(await inject({ method: "POST", url: "/v1/worker/claim", headers: worker, payload: { workerId, loadedModels: [], waitSeconds: 0 } })).stop, true);

      // A pod the provider has but this service does not know of is terminated.
      pods.set("stray", { name: "nc-gpu-deadbeef", status: "running" });
      await m.tick();
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(!pods.has("stray"));

      // A pod whose worker never registers is given up; no GPU at the provider blocks renting.
      const s2 = json(await open(as("table-2")));
      await new Promise((r) => setTimeout(r, 200));  // the kick from opening rents it
      await m.tick();
      assert.equal(pods.size, 1);
      const r3 = await m.tick(new Date(Date.now() + 11 * 60_000));
      assert.equal(r3!.failed.length, 1);
      assert.equal(pods.size, 0);
      assert.ok(s2.session.id);
      fail = "capacity";
      const m2 = new CapacityManager(h.s.db, cfg, h.s.config.sessions, provider);
      h.s.capacity = m2;
      const s3 = json(await open(as("table-3")));
      await new Promise((r) => setTimeout(r, 200));
      await m2.tick();
      assert.match(m2.blocked ?? "", /no GPU/);
      const blocked = json(await inject({ method: "POST", url: `/v1/sessions/${s3.session.id}/heartbeat`, headers: as("table-3") }));
      assert.deepEqual(blocked.capacity, { state: "unavailable", reason: m2.blocked });

      // The daily budget: no more pods once today's cost it.
      fail = "none";
      const m3 = new CapacityManager(h.s.db, { ...cfg, dailyBudgetUsd: 0 }, h.s.config.sessions, provider);
      await m3.tick();
      assert.match(m3.blocked ?? "", /budget/);
      assert.equal(pods.size, 0);
      assert.ok((await m.spentToday()) >= 0);
    } finally {
      await h.s.capacity?.settle();
      await m.settle();
      h.s.config.capacity = saved;
      h.s.capacity = undefined;
    }
  });

  it("rents Runpod pods with the worker's settings, trying GPU types in order", async () => {
    const { RunpodProvider } = await import("../src/providers/runpod.js");
    const calls: { method: string; url: string; body: any }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method: String(init.method), url, body });
      if (init.method === "POST" && body.gpu.id === "NVIDIA RTX A5000")
        return new Response(JSON.stringify({ detail: "There are no longer any instances available with the requested specifications." }), { status: 400 });
      if (init.method === "POST") return new Response(JSON.stringify({ id: "pod123", cost: 0.25, dataCenterId: "EU-RO-1" }), { status: 201 });
      if (init.method === "DELETE") return new Response(null, { status: 404 });
      return new Response(JSON.stringify({ pods: [{ id: "pod123", name: "nc-gpu-1234abcd", status: "RUNNING" }, { id: "x", name: "someone-else", status: "RUNNING" }], pagination: { hasNextPage: false } }), { status: 200 });
    }) as typeof fetch;
    const rp = new RunpodProvider(
      { ...h.s.config.capacity.runpod, apiKey: "k", image: "ghcr.io/x/worker-gpu:1", workerApiUrl: "https://api.example", workerToken: "wt", gpuTypes: ["NVIDIA RTX A5000", "NVIDIA RTX A4000"], networkVolumeId: "vol1", dataCenters: ["EU-RO-1"], workerEnv: { KEEP_MODELS: "8", INTERACTIVE_ONLY: "1" } },
      fakeFetch,
    );
    const pod = await rp.rent({ id: "1234abcd-0000-0000-0000-000000000000", name: "nc-gpu-1234abcd" });
    assert.deepEqual(pod, { providerId: "pod123", gpuType: "NVIDIA RTX A4000", region: "EU-RO-1", pricePerHour: 0.25 });
    const sent = calls[1]!.body;
    assert.equal(calls[1]!.url, "https://api.runpod.io/v2/pods");
    assert.deepEqual(sent.env, { KEEP_MODELS: "8", INTERACTIVE_ONLY: "1", API_URL: "https://api.example", WORKER_TOKEN: "wt", WORKER_CLASS: "gpu", WORKER_POD_ID: "1234abcd-0000-0000-0000-000000000000", CACHE_DIR: "/runpod-volume/cache" });
    assert.deepEqual(sent.mounts, { network: [{ volumeId: "vol1", path: "/runpod-volume" }] });
    assert.deepEqual(sent.dataCenterIds, ["EU-RO-1"]);
    assert.deepEqual(await rp.list(), [{ providerId: "pod123", name: "nc-gpu-1234abcd", status: "running" }]);
    await rp.terminate("gone");  // already gone: fine
  });

  it("rate-limits an app token per end user, not for the whole app", async () => {
    const { TOKEN_RATE_PER_MINUTE } = await import("../src/auth.js");
    const { as } = await appUser();
    let n = 0;  // the bucket refills a little while the loop runs
    while (n < TOKEN_RATE_PER_MINUTE * 2 && (await inject({ method: "GET", url: "/v1/jobs", headers: as("busy-install") })).statusCode === 200) n++;
    assert.ok(n >= TOKEN_RATE_PER_MINUTE && n < TOKEN_RATE_PER_MINUTE + 20, String(n));
    assert.equal((await inject({ method: "GET", url: "/v1/jobs", headers: as("other-install") })).statusCode, 200);
  });

  it("warms a starting GPU worker up: its own preset jobs on a blank sketch, ready only once it claims", async () => {
    await noWorkers();
    await presetCatalog();
    await noWorkers();
    const { capacityState } = await import("../src/capacity.js");
    const { WARMUP_INPUT } = await import("../src/warmup.js");
    const state = () => capacityState(h.s.db, h.s.config.capacity, [], h.s.config.interactiveGraceSeconds);
    const workerId = json(await inject({ method: "POST", url: "/v1/worker/register", headers: worker, payload: { class: "gpu", cores: 8, memoryBytes: 1, engineVersion: "test", warmup: true } })).workerId;
    assert.notEqual((await state()).state, "ready");  // loading its models
    assert.equal((await inject({ method: "POST", url: "/v1/worker/warmup", payload: { workerId } })).statusCode, 401);
    const r = await inject({ method: "POST", url: "/v1/worker/warmup", headers: worker, payload: { workerId } });
    assert.equal(r.statusCode, 200, r.body);
    const [job, ...rest] = json(r).jobs;
    assert.equal(rest.length, 0);
    assert.equal(job.jobId, "warmup-sketch_to_scene");
    const steps = job.workflow.steps as { op: string; path?: string; lora?: string[] }[];
    assert.equal(steps[0]!.path, `asset:${WARMUP_INPUT}`);
    assert.ok(steps.find((st) => st.op === "txt2img")!.lora, "map mode: the LCM LoRA is loaded too");
    assert.ok(steps.some((st) => st.op === "classify"), "and the output classifier");
    const blank = job.files.find((f: { assetId: string }) => f.assetId === WARMUP_INPUT);
    assert.equal(job.files.length, 6);  // five catalog models and the blank sketch
    const png = await h.s.storage.get(`blobs/${blank.sha256}`);
    assert.deepEqual([...png.subarray(1, 4)], [...Buffer.from("PNG")]);
    assert.equal(png.readUInt32BE(16), 512);
    assert.equal(json(await inject({ method: "POST", url: "/v1/worker/claim", headers: worker, payload: { workerId, loadedModels: [], waitSeconds: 0 } })).job, null);
    assert.equal((await state()).state, "ready");
    // A CPU worker gets none.
    const cpu = json(await inject({ method: "POST", url: "/v1/worker/register", headers: worker, payload: { class: "cpu", cores: 1, memoryBytes: 1, engineVersion: "test", warmup: true } })).workerId;
    assert.deepEqual(json(await inject({ method: "POST", url: "/v1/worker/warmup", headers: worker, payload: { workerId: cpu } })).jobs, []);
  });
});
