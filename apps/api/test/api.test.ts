import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
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
