import path from "node:path";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { ADMIN_TOKEN, harness, json, local, PNG_1x1, signUp, uploadPicture, worker, type Harness } from "./helpers.js";

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

  it("ends a job's event stream with the finished job, even when the event itself is lost", async () => {
    const a = await signUp(h.app);
    const pic = await uploadPicture(h.app, a.cookie);
    const jobId = json(await inject({ method: "POST", url: "/v1/jobs", headers: { cookie: a.cookie }, payload: { workflow: resize(pic) } })).job.id;
    const ping = h.s.config.ssePingSeconds;
    h.s.config.ssePingSeconds = 0.2;
    try {
      const stream = inject({ method: "GET", url: `/v1/jobs/${jobId}/events`, headers: { cookie: a.cookie } });
      await new Promise((r) => setTimeout(r, 100));
      // Finished by another API process, say: no event here.
      await h.s.db.query("UPDATE jobs SET state = 'cancelled', finished_at = now() WHERE id = $1", [jobId]);
      const r = await Promise.race([stream, new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
      assert.ok(r, "the stream ended");
      const events = r.body.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
      assert.equal(events[0].job.state, "queued");
      assert.deepEqual([events.at(-1).type, events.at(-1).job.state], ["job", "cancelled"]);
    } finally {
      h.s.config.ssePingSeconds = ping;
    }
    // A job already finished: one event, then the end.
    const again = await inject({ method: "GET", url: `/v1/jobs/${jobId}/events`, headers: { cookie: a.cookie } });
    assert.equal(again.body.split("\n").filter((l) => l.startsWith("data: ")).length, 1);
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
    assert.equal(draw.control_scale, 0.8);  // map mode (issue #42)
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

  it("turns a region layer into a colour hint for map mode (issue #42)", async () => {
    const { PNG } = await import("pngjs");
    const { regionHint } = await import("../src/regions.js");
    // A water band painted across a transparent 512 x 512 layer, with an anti-aliased edge row.
    const layer = (paint: boolean) => {
      const p = new PNG({ width: 512, height: 512 });
      p.data.fill(0);
      if (paint)
        for (let y = 200; y <= 260; y++)
          for (let x = 0; x < 512; x++) {
            const i = (y * 512 + x) * 4;
            p.data.set([0x20, 0x60, 0xa0, y === 200 || y === 260 ? 128 : 255], i);
          }
      return PNG.sync.write(p);
    };
    const pixel = (png: Buffer, x: number, y: number) => {
      const p = PNG.sync.read(png);
      const i = (y * p.width + x) * 4;
      return [p.data[i], p.data[i + 1], p.data[i + 2]];
    };
    const hint = regionHint(layer(true), "stone")!;
    assert.deepEqual([PNG.sync.read(hint).width, PNG.sync.read(hint).height], [512, 512]);
    assert.deepEqual(pixel(hint, 256, 230), [40, 96, 150]);     // the middle of the band: water
    assert.deepEqual(pixel(hint, 256, 20), [128, 124, 118]);    // unpainted: the stone ground
    const edge = pixel(hint, 256, 200)!;                        // blurred between the two
    assert.ok(edge[2]! < 150 && edge[2]! > 118, String(edge));
    assert.equal(regionHint(layer(false), "grass"), null);      // nothing painted

    // Through the API: listed as optional, used in map mode, a sketch alone works as before.
    const listed = json(await inject({ method: "GET", url: "/v1/presets" })).presets.find((x: { id: string }) => x.id === "sketch_to_scene");
    assert.deepEqual(listed.inputs.map((i: { name: string; required: boolean }) => [i.name, i.required]), [["sketch", true], ["regions", false]]);
    assert.deepEqual(listed.params.ground.options, ["grass", "stone", "dirt", "sand", "snow"]);
    await catalog();
    const a = await signUp(h.app);
    await h.s.db.query("INSERT INTO ledger (user_id, kind, amount) VALUES ($1, 'grant', 1000000)", [a.id]);
    const submit = (params: object, inputs: object) =>
      inject({ method: "POST", url: "/v1/presets/sketch_to_scene/jobs", headers: { cookie: a.cookie }, payload: { params, inputs } });
    const regions = (png: Buffer) => ({ inline: png.toString("base64"), contentType: "image/png" });
    const done = (job: { id: string }) => h.s.db.query("UPDATE jobs SET state = 'cancelled' WHERE id = $1", [job.id]);

    const plain = json(await submit({ mode: "map", prompt: "a river" }, { sketch })).job;
    assert.deepEqual(plain.workflow.steps.map((x: { op: string }) => x.op), ["load", "resize", "scribble", "txt2img", "save", "classify"]);
    await done(plain);

    const r = await submit({ mode: "map", prompt: "a river", ground: "stone", seed: 3 }, { sketch, regions: regions(layer(true)) });
    assert.equal(r.statusCode, 201, r.body);
    const job = json(r).job;
    assert.deepEqual(job.workflow.steps.map((x: { op: string }) => x.op), ["load", "resize", "scribble", "load", "img2img", "save", "classify"]);
    const draw = job.workflow.steps[4];
    assert.deepEqual([draw.in, draw.strength, draw.steps, draw.control, draw.control_scale, draw.sampler], ["hint", 0.6, 6, "lines", 0.8, "lcm"]);
    // The stored input is the hint, not the layer.
    const hintAsset = /^asset:(.+)$/.exec(job.workflow.steps[3].path)![1];
    const blob = (await h.s.db.query("SELECT sha256 FROM assets WHERE id = $1", [hintAsset])).rows[0].sha256;
    assert.deepEqual(pixel(await h.s.storage.get(`blobs/${blob}`), 256, 20), [128, 124, 118]);
    await done(job);

    const atmosphere = json(await submit({ mode: "atmosphere", prompt: "a river" }, { sketch, regions: regions(layer(true)) })).job;
    assert.ok(!atmosphere.workflow.steps.some((x: { op: string }) => x.op === "img2img"));
    await done(atmosphere);
    const empty = json(await submit({ mode: "map", prompt: "a river" }, { sketch, regions: regions(layer(false)) })).job;
    assert.ok(!empty.workflow.steps.some((x: { op: string }) => x.op === "img2img"));
    await done(empty);

    const ref = await submit({ mode: "map", prompt: "a river" }, { sketch, regions: `asset:${hintAsset}` });
    assert.equal(json(ref).error.params.field, "inputs.regions");
    const broken = Buffer.concat([layer(true).subarray(0, 40), Buffer.alloc(100)]);
    const bad = await submit({ mode: "map", prompt: "a river" }, { sketch, regions: regions(broken) });
    assert.deepEqual([bad.statusCode, json(bad).error.params.reason], [400, "not a readable PNG picture"]);
  });

  it("keeps inputs longer during a beta (INPUT_RETENTION_HOURS) and exports jobs with their pictures", async () => {
    const { setInputRetentionHours, runRetention } = await import("../src/retention.js");
    const { PNG } = await import("pngjs");
    const { execFileSync } = await import("node:child_process");
    const { gunzipSync } = await import("node:zlib");
    await catalog();
    const a = await signUp(h.app);
    await h.s.db.query("INSERT INTO ledger (user_id, kind, amount) VALUES ($1, 'grant', 1000000)", [a.id]);
    const layer = new PNG({ width: 64, height: 64 });
    layer.data.fill(0);
    for (let i = 0; i < 64 * 20; i++) layer.data.set([0x20, 0x60, 0xa0, 255], i * 4);
    const submit = () =>
      inject({ method: "POST", url: "/v1/presets/sketch_to_scene/jobs", headers: { cookie: a.cookie },
        payload: { params: { mode: "map", prompt: "a river", seed: 9 }, inputs: { sketch, regions: { inline: PNG.sync.write(layer).toString("base64"), contentType: "image/png" } } } });
    const expiryHours = async (jobId: string) =>
      (await h.s.db.query<{ h: number }>(
        `SELECT round(extract(epoch FROM a.expires_at - a.created_at) / 3600) AS h FROM jobs j, jsonb_array_elements(j.workflow->'steps') st
           JOIN assets a ON 'asset:' || a.id = st->>'path' WHERE j.id = $1 AND st->>'op' = 'load' LIMIT 1`, [jobId])).rows[0]!.h;
    const before = json(await submit()).job;
    assert.equal(Number(await expiryHours(before.id)), 24);
    try {
      setInputRetentionHours(168);
      const job = json(await submit()).job;
      assert.equal(Number(await expiryHours(job.id)), 168);
      await runRetention(h.s.db, h.s.storage);  // inputs already kept move to the new window too
      assert.equal(Number(await expiryHours(before.id)), 168);

      // A result, as a worker would upload it.
      const result = PNG.sync.write(new PNG({ width: 8, height: 8 }));
      const { createHash } = await import("node:crypto");
      const sha = createHash("sha256").update(result).digest("hex");
      await h.s.storage.put(`blobs/${sha}`, result);
      await h.s.db.query("INSERT INTO blobs (sha256, bytes) VALUES ($1, $2) ON CONFLICT DO NOTHING", [sha, result.length]);
      const out = await h.s.db.query<{ id: string }>("INSERT INTO assets (owner_id, kind, name, content_type, sha256, bytes) VALUES ($1, 'output', 'scene.png', 'image/png', $2, $3) RETURNING id", [a.id, sha, result.length]);
      await h.s.db.query("INSERT INTO job_outputs (job_id, name, asset_id) VALUES ($1, 'scene.png', $2)", [job.id, out.rows[0]!.id]);
      await h.s.db.query("UPDATE jobs SET state = 'succeeded', finished_at = now() WHERE id IN ($1, $2)", [job.id, before.id]);

      const tgz = execFileSync("node", ["dist/src/cli/job-export.js", "--job", job.id], {
        env: { ...process.env, DATABASE_URL: h.s.config.databaseUrl, STORAGE_DIR: h.s.config.storage.kind === "local" ? h.s.config.storage.dir : "" },
        stdio: ["ignore", "pipe", "ignore"],
      });
      const tar = gunzipSync(tgz);
      const names: string[] = [];
      for (let at = 0; at + 512 <= tar.length && tar[at] !== 0; ) {
        const name = tar.subarray(at, at + 100).toString().replace(/\0.*$/s, "");
        const size = parseInt(tar.subarray(at + 124, at + 135).toString(), 8);
        names.push(name);
        if (name.endsWith("job.json")) {
          const info = JSON.parse(tar.subarray(at + 512, at + 512 + size).toString());
          assert.equal(info.regions, true);
          assert.equal(info.generation.prompt.includes("river"), true);
        }
        at += 512 + Math.ceil(size / 512) * 512;
      }
      assert.deepEqual(names.map((n) => n.split("/").pop()).sort(), ["hint.png", "index.txt", "job.json", "scene.png", "sketch.png"]);
    } finally {
      setInputRetentionHours(null);
    }
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
        const st = mode === "map" ? ["top-down tabletop RPG battle map", "bird's eye view", "detailed painted texture"] : ["fantasy landscape illustration"];
        for (const s of st) assert.ok(w.prompt.includes(s), `${name} ${mode}: ${w.prompt}`);
        assert.ok(w.prompt.includes(terrain), `${name}: ${w.prompt}`);
        assert.ok(noCreatures(w.prompt), `${name}: ${w.prompt}`);
        assert.ok(w.prompt.split(/\s+/).length <= 60);
      }
  });

  it("names the scribbled shapes as seen from above in map mode (issue #42)", async () => {
    const { templatePrompt, styled } = await import("../src/prompts.js");
    const map = templatePrompt("Nehrin üzerinde ahşap bir köprü, kuzeyde sık bir orman", "map").prompt;
    for (const s of ["blue river of flowing water", "wooden plank bridge crossing the water", "round green tree canopies"]) assert.ok(map.includes(s), map);
    const atmosphere = templatePrompt("Nehrin üzerinde ahşap bir köprü, kuzeyde sık bir orman", "atmosphere").prompt;
    assert.ok(atmosphere.includes("a river") && !atmosphere.includes("seen from above"), atmosphere);
    // A long scene is cut, never the style words; style words already there are not repeated.
    const long = styled(Array.from({ length: 80 }, (_, i) => `rock${i}`).join(" "), "map");
    assert.ok(long.startsWith("top-down tabletop RPG battle map") && long.endsWith("detailed painted texture") && long.split(/\s+/).length <= 60, long);
    assert.equal(styled(map, "map"), map);
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
      assert.ok(w.prompt.startsWith("top-down tabletop RPG battle map, bird's eye view from directly above, orthographic, flat even daylight, a wooden bridge"), w.prompt);
      assert.ok(w.prompt.endsWith("clear readable terrain, detailed painted texture"), w.prompt);
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
    assert.equal(info.instructions, "sketch_to_scene/2");
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
    // Hidden from its owner too until reviewed: no download, not among the job's outputs or the assets.
    assert.equal((await inject({ method: "GET", url: `/v1/assets/${asset}/content`, headers: { cookie: a.cookie } })).statusCode, 404);
    assert.equal(json(await inject({ method: "GET", url: `/v1/jobs/${job.id}`, headers: { cookie: a.cookie } })).job.outputs.length, 0);
    assert.ok(!json(await inject({ method: "GET", url: "/v1/assets", headers: { cookie: a.cookie } })).assets.some((x: { id: string }) => x.id === asset));
    // A review that finds nothing wrong gives it back.
    const { dismissReport } = await import("../src/moderation.js");
    await dismissReport(h.s.db, json(first).report.id, "ayse");
    assert.equal((await inject({ method: "GET", url: `/v1/assets/${asset}/content`, headers: { cookie: a.cookie } })).statusCode, 302);
    assert.equal(json(await inject({ method: "GET", url: `/v1/jobs/${job.id}`, headers: { cookie: a.cookie } })).job.outputs.length, 1);
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
    assert.deepEqual(row.prompt_info, { source: "template", instructions: "sketch_to_scene/2", fallback: "no llm configured", scrubbed: true });
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
    // The database clock, so jobs earlier tests finished just before are not counted.
    const since = (await h.s.db.query<{ t: Date }>("SELECT now() AS t")).rows[0]!.t;
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
        return { providerId, gpuType: "RTX A5000", region: "EU-RO-1", pricePerHour: 0.27, modelCache: false };
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
      // The kicked tick may still be renting (state 'requested') when this one returns: wait for it.
      for (let i = 0; i < 40 && (await h.s.db.query("SELECT 1 FROM gpu_pods WHERE state = 'requested'")).rowCount; i++) await new Promise((r) => setTimeout(r, 50));
      const live = (await h.s.db.query("SELECT id, provider_id, state, price_per_hour FROM gpu_pods WHERE state IN ('requested', 'starting', 'running')")).rows;
      assert.equal(live.length, 1);
      assert.equal(live[0].state, "starting");
      assert.equal(pods.size, 1);
      const hb = json(await inject({ method: "POST", url: `/v1/sessions/${opened.session.id}/heartbeat`, headers: as("table-1") }));
      assert.equal(hb.capacity.state, "warming");
      // Without the model cache (a fallback data centre) the estimate is the longer one, and says which GPU it is.
      assert.ok(hb.capacity.etaSeconds > h.s.config.capacity.expectedStartSeconds && hb.capacity.etaSeconds <= h.s.config.capacity.expectedStartSecondsNoCache, String(hb.capacity.etaSeconds));
      assert.deepEqual(hb.capacity.gpu, { type: "RTX A5000", region: "EU-RO-1", modelCache: false });

      // A job while the pod starts waits for it (no job.no_gpu_worker) and keeps the session asking.
      const sub = await inject({ method: "POST", url: "/v1/presets/sketch_to_scene/jobs", headers: as("table-1"), payload: { params: { mode: "map", prompt: "a bridge" }, inputs: { sketch: { inline: PNG_1x1.toString("base64"), contentType: "image/png" } } } });
      assert.equal(sub.statusCode, 201, sub.body);
      const tied = (await h.s.db.query("SELECT session_id FROM jobs WHERE id = $1", [json(sub).job.id])).rows[0].session_id;
      assert.equal(tied, opened.session.id);

      // The pod's worker registers: the pod is running, the session's capacity ready.
      const workerId = json(await inject({ method: "POST", url: "/v1/worker/register", headers: worker, payload: { class: "gpu", cores: 8, memoryBytes: 1, engineVersion: "test", interactiveOnly: true, podId: live[0].id } })).workerId;
      const pod = (await h.s.db.query("SELECT state, worker_id FROM gpu_pods WHERE id = $1", [live[0].id])).rows[0];
      assert.deepEqual([pod.state, pod.worker_id], ["running", workerId]);
      assert.deepEqual(json(await inject({ method: "POST", url: `/v1/sessions/${opened.session.id}/heartbeat`, headers: as("table-1") })).capacity, {
        state: "ready",
        gpu: { type: "RTX A5000", region: "EU-RO-1", modelCache: false },
      });
      assert.deepEqual((await m.tick())!.rented, []);  // one session: one pod
      // The job ran on that pod: its JSON says which GPU.
      assert.equal(json(await inject({ method: "POST", url: "/v1/worker/claim", headers: worker, payload: { workerId, loadedModels: [], waitSeconds: 0 } })).job.jobId, json(sub).job.id);
      assert.deepEqual(json(await inject({ method: "GET", url: `/v1/jobs/${json(sub).job.id}`, headers: as("table-1") })).job.gpu, { type: "RTX A5000", region: "EU-RO-1" });
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

      // The monthly budget: a pod already there is drained as well, even while busy.
      const m4 = new CapacityManager(h.s.db, cfg, h.s.config.sessions, provider);
      await m4.tick();
      assert.equal(pods.size, 1);
      const [podId] = (await h.s.db.query<{ id: string }>("SELECT id FROM gpu_pods WHERE state IN ('requested', 'starting', 'running')")).rows.map((x) => x.id);
      // Five minutes at 1000 USD/h: over a 15 USD month.
      await h.s.db.query("UPDATE gpu_pods SET price_per_hour = 1000, requested_at = now() - interval '5 minutes' WHERE id = $1", [podId]);
      assert.ok((await m4.spentThisMonth()) >= 15);
      const m5 = new CapacityManager(h.s.db, { ...cfg, dailyBudgetUsd: 1e9, monthlyBudgetUsd: 15 }, h.s.config.sessions, provider);
      await m5.tick();
      assert.match(m5.blocked ?? "", /monthly GPU budget reached/);
      const after = (await h.s.db.query<{ state: string }>("SELECT state FROM gpu_pods WHERE id = $1", [podId])).rows[0]!.state;
      assert.ok(["stopped", "draining"].includes(after), after);
      // The usage log saw it all.
      const kinds = (await h.s.db.query<{ kind: string }>("SELECT DISTINCT kind FROM capacity_events")).rows.map((x) => x.kind);
      for (const k of ["pod.requested", "pod.registered", "pod.stopped", "pod.rent_failed", "capacity.demand", "capacity.blocked"]) assert.ok(kinds.includes(k), `${k} in ${kinds}`);
      const stopped = (await h.s.db.query<{ detail: { reason: string; costUsd: number } }>("SELECT detail FROM capacity_events WHERE kind = 'pod.stopped' AND pod_id = $1", [podId])).rows[0]!.detail;
      assert.equal(stopped.reason, "budget");
      assert.ok(stopped.costUsd >= 15);
      await h.s.db.query("UPDATE gpu_pods SET state = 'stopped', requested_at = now() - interval '40 days', stopped_at = now() - interval '40 days' WHERE id = $1", [podId]);
      pods.clear();
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
    assert.deepEqual(pod, { providerId: "pod123", gpuType: "NVIDIA RTX A4000", region: "EU-RO-1", pricePerHour: 0.25, modelCache: true });
    const sent = calls[1]!.body;
    assert.equal(calls[1]!.url, "https://api.runpod.io/v2/pods");
    assert.deepEqual(sent.env, { KEEP_MODELS: "8", INTERACTIVE_ONLY: "1", API_URL: "https://api.example", WORKER_TOKEN: "wt", WORKER_CLASS: "gpu", WORKER_POD_ID: "1234abcd-0000-0000-0000-000000000000", CACHE_DIR: "/runpod-volume/cache" });
    assert.deepEqual(sent.mounts, { network: [{ volumeId: "vol1", path: "/runpod-volume" }] });
    assert.deepEqual(sent.dataCenterIds, ["EU-RO-1"]);
    assert.deepEqual(await rp.list(), [{ providerId: "pod123", name: "nc-gpu-1234abcd", status: "running" }]);
    await rp.terminate("gone");  // already gone: fine

    // Nothing free in the volume's data centre: the fallback ones, without the volume.
    const tried: any[] = [];
    const scarce = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      tried.push(body);
      if (body.mounts || body.gpu.id !== "NVIDIA RTX 2000 Ada Generation")
        return new Response(JSON.stringify({ detail: "There are no longer any instances available with the requested specifications." }), { status: 400 });
      return new Response(JSON.stringify({ id: "pod9", cost: 0.24, dataCenterId: "EUR-IS-1" }), { status: 201 });
    }) as typeof fetch;
    const rp2 = new RunpodProvider(
      { ...h.s.config.capacity.runpod, apiKey: "k", image: "i", workerApiUrl: "https://api.example", workerToken: "wt", gpuTypes: ["NVIDIA RTX A5000", "NVIDIA RTX 2000 Ada Generation"], networkVolumeId: "vol1", dataCenters: ["EU-RO-1"], fallbackDataCenters: ["EUR-IS-1", "EU-SE-1"], workerEnv: {} },
      scarce,
    );
    assert.deepEqual(await rp2.rent({ id: "9", name: "nc-gpu-9" }), { providerId: "pod9", gpuType: "NVIDIA RTX 2000 Ada Generation", region: "EUR-IS-1", pricePerHour: 0.24, modelCache: false });
    assert.deepEqual(tried.map((b) => [b.gpu.id, b.dataCenterIds.join("/"), Boolean(b.mounts), b.env.CACHE_DIR ?? null]), [
      ["NVIDIA RTX A5000", "EU-RO-1", true, "/runpod-volume/cache"],
      ["NVIDIA RTX 2000 Ada Generation", "EU-RO-1", true, "/runpod-volume/cache"],
      ["NVIDIA RTX A5000", "EUR-IS-1/EU-SE-1", false, null],
      ["NVIDIA RTX 2000 Ada Generation", "EUR-IS-1/EU-SE-1", false, null],
    ]);
    const { CapacityUnavailable } = await import("../src/capacity.js");
    const none = new RunpodProvider({ ...h.s.config.capacity.runpod, apiKey: "k", image: "i", workerApiUrl: "u", workerToken: "t", gpuTypes: ["X"], networkVolumeId: "", dataCenters: ["A"], fallbackDataCenters: ["B"], workerEnv: {} }, scarce);
    await assert.rejects(none.rent({ id: "1", name: "n" }), (e: Error) => e instanceof CapacityUnavailable && /X in A\/B/.test(e.message));
  });

  it("rate-limits an app token per end user, not for the whole app", async () => {
    const { TOKEN_RATE_PER_MINUTE } = await import("../src/auth.js");
    const { as } = await appUser();
    let n = 0;  // the bucket refills a little while the loop runs
    while (n < TOKEN_RATE_PER_MINUTE * 2 && (await inject({ method: "GET", url: "/v1/jobs", headers: as("busy-install") })).statusCode === 200) n++;
    assert.ok(n >= TOKEN_RATE_PER_MINUTE && n < TOKEN_RATE_PER_MINUTE + 20, String(n));
    assert.equal((await inject({ method: "GET", url: "/v1/jobs", headers: as("other-install") })).statusCode, 200);
  });

  it("keeps a usage log that outlives the jobs, and exports it", async () => {
    await noWorkers();
    await presetCatalog();
    await noWorkers();
    const { as } = await appUser();
    const workerId = json(await inject({ method: "POST", url: "/v1/worker/register", headers: worker, payload: { class: "gpu", cores: 8, memoryBytes: 1, engineVersion: "test" } })).workerId;
    const opened = json(await inject({ method: "POST", url: "/v1/sessions", headers: as("usage-table") }));
    const sketch = { inline: PNG_1x1.toString("base64"), contentType: "image/png" };
    const sub = await inject({ method: "POST", url: "/v1/presets/sketch_to_scene/jobs", headers: as("usage-table"), payload: { params: { mode: "map", prompt: "a bridge" }, inputs: { sketch } } });
    assert.equal(sub.statusCode, 201, sub.body);
    const jobId = json(sub).job.id;
    assert.equal(json(await inject({ method: "POST", url: "/v1/worker/claim", headers: worker, payload: { workerId, loadedModels: [], waitSeconds: 0 } })).job.jobId, jobId);
    await inject({ method: "POST", url: `/v1/worker/jobs/${jobId}/fail`, headers: worker, payload: { workerId, workerSeconds: 1, code: "job.timeout", detail: "x" } });
    const row = (await h.s.db.query("SELECT * FROM usage_jobs WHERE job_id = $1", [jobId])).rows[0];
    assert.ok(row, "logged when it finished");
    assert.equal(row.session_id, opened.session.id);
    assert.deepEqual(
      [row.preset, row.preset_variant, row.latency, row.op, row.width, row.height, row.steps, row.sampler, row.controlnet, row.lora, row.models, row.state],
      ["sketch_to_scene", "map", "interactive", "txt2img", 512, 512, 4, "lcm", true, 1, 5, "failed"],
    );
    assert.equal(row.error_code, "job.timeout");
    // Closing the session logs it; deleting the end user's data leaves the log.
    await inject({ method: "DELETE", url: `/v1/sessions/${opened.session.id}`, headers: as("usage-table") });
    assert.equal((await h.s.db.query("SELECT 1 FROM usage_sessions WHERE session_id = $1", [opened.session.id])).rowCount, 1);
    await h.s.db.query("DELETE FROM jobs WHERE id = $1", [jobId]);
    assert.equal((await h.s.db.query("SELECT 1 FROM usage_jobs WHERE job_id = $1", [jobId])).rowCount, 1);
    // The export.
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { spawnSync } = await import("node:child_process");
    const out = mkdtempSync(path.join(tmpdir(), "usage-"));
    const r = spawnSync(process.execPath, [new URL("../src/cli/usage-report.js", import.meta.url).pathname, "--from", "2020-01-01", "--out", out, "--fixed-usd-month", "10"], {
      env: { ...process.env, DATABASE_URL: h.s.config.databaseUrl },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const summary = JSON.parse(readFileSync(path.join(out, "summary.json"), "utf8"));
    assert.ok(summary.jobs.total >= 1);
    assert.ok(summary.jobs.byError["job.timeout"] >= 1);
    assert.ok(summary.sessions.total >= 1);
    assert.ok(summary.cost.fixedUsd > 0);
    const jobsCsv = readFileSync(path.join(out, "jobs.csv"), "utf8");
    assert.match(jobsCsv.split("\n")[0]!, /^job_id,session_id,preset,preset_variant/);
    assert.ok(!/usage-table/.test(jobsCsv + readFileSync(path.join(out, "sessions.csv"), "utf8")), "no end-user ids");
    // The same over HTTP, for operators only.
    assert.equal((await inject({ method: "GET", url: "/v1/admin/usage-report" })).statusCode, 401);
    assert.equal((await inject({ method: "GET", url: "/v1/admin/usage-report", headers: { authorization: "Bearer nc_app_wrong" } })).statusCode, 401);
    const viaHttp = await inject({ method: "GET", url: "/v1/admin/usage-report?from=2020-01-01", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    assert.equal(viaHttp.statusCode, 200, viaHttp.body);
    assert.ok(json(viaHttp).summary.jobs.total >= 1);
    assert.match(json(viaHttp).files["jobs.csv"], /^job_id,/);
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

describe("end-user sign-in (issue #48)", () => {
  type Mail = { to: string; code: string; appName: string; locale: string };
  const sent: Mail[] = [];
  const setup = async (name = "GM Cebi") => {
    h.s.mailer = { sendSignInCode: async (m) => void sent.push(m) };
    h.s.config.endUserAuth.startsPerIpPerHour = 10_000;
    h.s.config.endUserAuth.verifiesPerIpPerHour = 10_000;
    const { createToken } = await import("../src/auth.js");
    const { createClient } = await import("../src/endusers.js");
    const p = await signUp(h.app);
    const client = await createClient(h.s.db, p.id, name);
    const server = { authorization: `Bearer ${(await createToken(h.s.db, p.id, "app", "server", ["partner:manage"], null)).secret}` };
    const appToken = (await createToken(h.s.db, p.id, "app", "app", ["jobs:submit", "jobs:read", "assets:read"], null)).secret;
    return { p, client_id: client.id, server, appToken };
  };
  const post = (url: string, payload: object, remoteAddress?: string) => inject({ method: "POST", url, payload, ...(remoteAddress ? { remoteAddress } : {}) });
  // Asks for a code and signs in with it; returns the token response.
  const signIn = async (client_id: string, email: string) => {
    const start = await post("/v1/auth/email/start", { client_id, email, locale: "tr" });
    assert.equal(start.statusCode, 202, start.body);
    const code = sent.at(-1)!.code;
    const r = await post("/v1/auth/email/verify", { client_id, email, code });
    assert.equal(r.statusCode, 200, r.body);
    return json(r) as { accessToken: string; refreshToken: string; expiresIn: number; endUser: { id: string } };
  };
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const sketch = { inline: PNG_1x1.toString("base64"), contentType: "image/png" };
  const submit = (headers: Record<string, string>) =>
    inject({ method: "POST", url: "/v1/presets/sketch_to_scene/jobs", headers, payload: { params: { mode: "map", prompt: "a wooden bridge" }, inputs: { sketch } } });
  // A code older than the resend interval, so the next one can be asked for.
  const age = (seconds = 120) => h.s.db.query("UPDATE sign_in_codes SET created_at = created_at - make_interval(secs => $1)", [seconds]);

  it("signs in with an emailed code; the token acts for that end user only", async () => {
    await presetCatalog();
    const { client_id } = await setup();
    const start = await post("/v1/auth/email/start", { client_id, email: "Ada@Example.com", locale: "tr-TR" });
    assert.equal(start.statusCode, 202);
    assert.deepEqual(json(start), { expiresIn: 600, resendAfter: 60 });
    const mail = sent.at(-1)!;
    assert.deepEqual([mail.to, mail.appName, mail.locale], ["Ada@Example.com", "GM Cebi", "tr"]);
    assert.match(mail.code, /^\d{6}$/);
    // Nothing about the address is stored in the clear.
    const stored = JSON.stringify((await h.s.db.query("SELECT * FROM sign_in_codes")).rows);
    assert.ok(!stored.includes("ada") && !stored.includes(mail.code));

    const wrong = await post("/v1/auth/email/verify", { client_id, email: "ada@example.com", code: mail.code === "000000" ? "111111" : "000000" });
    assert.equal(json(wrong).error.code, "auth.code_invalid");
    assert.equal(json(wrong).error.params.attemptsLeft, 4);
    const ok = await post("/v1/auth/email/verify", { client_id, email: "ada@example.com", code: mail.code });
    assert.equal(ok.statusCode, 200, ok.body);
    const t = json(ok);
    assert.match(t.accessToken, /^nc_eu_/);
    assert.match(t.refreshToken, /^nc_rt_/);
    assert.equal(t.tokenType, "Bearer");
    assert.equal(t.expiresIn, 3600);
    assert.match(t.endUser.id, /^eu_/);
    // A code works once.
    assert.equal(json(await post("/v1/auth/email/verify", { client_id, email: "ada@example.com", code: mail.code })).error.code, "auth.code_expired");

    const me = json(await inject({ method: "GET", url: "/v1/me", headers: bearer(t.accessToken) }));
    assert.equal(me.endUser.id, t.endUser.id);
    assert.equal(me.user, undefined);  // not the partner's account
    // Sessions and jobs are the end user's; X-End-User is ignored.
    assert.equal((await inject({ method: "POST", url: "/v1/sessions", headers: bearer(t.accessToken) })).statusCode, 201);
    const job = await submit({ ...bearer(t.accessToken), "x-end-user": "someone-else" });
    assert.equal(job.statusCode, 201, job.body);
    assert.equal((await h.s.db.query("SELECT end_user FROM jobs WHERE id = $1", [json(job).job.id])).rows[0].end_user, t.endUser.id);
    // Partner-only and account endpoints stay closed.
    assert.equal((await inject({ method: "POST", url: `/v1/partner/end-users/${t.endUser.id}/block`, headers: bearer(t.accessToken) })).statusCode, 403);
    assert.equal((await inject({ method: "GET", url: "/v1/tokens", headers: bearer(t.accessToken) })).statusCode, 403);
    assert.equal((await inject({ method: "GET", url: `/v1/partner/end-users/${t.endUser.id}/usage`, headers: bearer(t.accessToken) })).statusCode, 200);
    assert.equal((await inject({ method: "GET", url: "/v1/partner/end-users/install-x/usage", headers: bearer(t.accessToken) })).statusCode, 403);
  });

  it("keeps one identity per inbox and per partner", async () => {
    const a = await setup(), b = await setup("Other app");
    const first = await signIn(a.client_id, "john.smith+gm@gmail.com");
    await age();
    const again = await signIn(a.client_id, "JohnSmith@googlemail.com");
    assert.equal(again.endUser.id, first.endUser.id);
    await age();
    const elsewhere = await signIn(b.client_id, "johnsmith@gmail.com");
    assert.notEqual(elsewhere.endUser.id, first.endUser.id);
  });

  it("refuses unknown clients, bad addresses and codes; limits codes per address and IP", async () => {
    const { client_id } = await setup();
    assert.equal(json(await post("/v1/auth/email/start", { client_id: "nc_client_nope000000000000000", email: "a@example.com" })).error.code, "auth.client_invalid");
    assert.equal(json(await post("/v1/auth/email/start", { email: "a@example.com" })).error.code, "auth.client_invalid");
    assert.equal(json(await post("/v1/auth/email/start", { client_id, email: "not an address" })).error.code, "auth.invalid_email");
    assert.equal((await post("/v1/auth/email/start", { client_id, email: "rate@example.com" })).statusCode, 202);
    const soon = await post("/v1/auth/email/start", { client_id, email: "rate@example.com" });
    assert.equal(soon.statusCode, 429);
    assert.equal(json(soon).error.code, "auth.code_rate_limited");
    assert.ok(json(soon).error.params.retryAfter > 0 && json(soon).error.params.retryAfter <= 60);
    for (let i = 0; i < 4; i++) {
      await age();
      assert.equal((await post("/v1/auth/email/start", { client_id, email: "rate@example.com" })).statusCode, 202);
    }
    await age();
    assert.equal(json(await post("/v1/auth/email/start", { client_id, email: "rate@example.com" })).error.code, "auth.code_rate_limited");  // 5 an hour

    // Five wrong attempts use the code up.
    await post("/v1/auth/email/start", { client_id, email: "guess@example.com" });
    const real = sent.at(-1)!.code;
    const bad = real === "123456" ? "654321" : "123456";
    for (let left = 4; left >= 1; left--)
      assert.equal(json(await post("/v1/auth/email/verify", { client_id, email: "guess@example.com", code: bad })).error.params.attemptsLeft, left);
    assert.equal(json(await post("/v1/auth/email/verify", { client_id, email: "guess@example.com", code: bad })).error.code, "auth.code_expired");
    assert.equal(json(await post("/v1/auth/email/verify", { client_id, email: "guess@example.com", code: real })).error.code, "auth.code_expired");
    // An expired code.
    await age();
    await post("/v1/auth/email/start", { client_id, email: "late@example.com" });
    await h.s.db.query("UPDATE sign_in_codes SET expires_at = now() - interval '1 second'");
    assert.equal(json(await post("/v1/auth/email/verify", { client_id, email: "late@example.com", code: sent.at(-1)!.code })).error.code, "auth.code_expired");

    // Per IP.
    h.s.config.endUserAuth.startsPerIpPerHour = 2;
    for (const e of ["ip1@example.com", "ip2@example.com"]) assert.equal((await post("/v1/auth/email/start", { client_id, email: e }, "203.0.113.9")).statusCode, 202);
    assert.equal(json(await post("/v1/auth/email/start", { client_id, email: "ip3@example.com" }, "203.0.113.9")).error.code, "auth.code_rate_limited");
    assert.equal((await post("/v1/auth/email/start", { client_id, email: "ip3@example.com" }, "203.0.113.10")).statusCode, 202);
  });

  it("says when email is not set up, and does not count a failed email", async () => {
    const { client_id } = await setup();
    h.s.mailer = null;
    assert.equal(json(await post("/v1/auth/email/start", { client_id, email: "x@example.com" })).error.code, "auth.sign_in_unavailable");
    h.s.mailer = { sendSignInCode: async () => { throw new Error("provider down"); } };
    const r = await post("/v1/auth/email/start", { client_id, email: "x@example.com" });
    assert.equal(r.statusCode, 503);
    assert.equal(Number((await h.s.db.query("SELECT count(*) AS n FROM sign_in_codes WHERE client_id = $1", [client_id])).rows[0].n), 0);
  });

  it("rotates refresh tokens, revokes the family on reuse, and signs out", async () => {
    const { client_id } = await setup();
    const t = await signIn(client_id, "rot@example.com");
    const r1 = await post("/v1/auth/token", { client_id, grantType: "refresh_token", refreshToken: t.refreshToken });
    assert.equal(r1.statusCode, 200, r1.body);
    const t1 = json(r1);
    assert.equal(t1.endUser.id, t.endUser.id);
    assert.notEqual(t1.refreshToken, t.refreshToken);
    assert.equal((await inject({ method: "GET", url: "/v1/me", headers: bearer(t1.accessToken) })).statusCode, 200);
    // The old refresh token again, after the grace window: the whole family goes, access tokens too.
    await h.s.db.query("UPDATE end_user_tokens SET used_at = now() - interval '61 seconds' WHERE used_at IS NOT NULL");
    assert.equal(json(await post("/v1/auth/token", { client_id, grantType: "refresh_token", refreshToken: t.refreshToken })).error.code, "auth.refresh_invalid");
    assert.equal(json(await post("/v1/auth/token", { client_id, grantType: "refresh_token", refreshToken: t1.refreshToken })).error.code, "auth.refresh_invalid");
    assert.equal(json(await inject({ method: "GET", url: "/v1/me", headers: bearer(t1.accessToken) })).error.code, "auth.token_revoked");
    // Another client's id does not refresh this client's token.
    const other = await setup("Other");
    await age();
    const t2 = await signIn(client_id, "rot@example.com");
    assert.equal(json(await post("/v1/auth/token", { client_id: other.client_id, grantType: "refresh_token", refreshToken: t2.refreshToken })).error.code, "auth.refresh_invalid");
    assert.equal(json(await post("/v1/auth/token", { client_id, grantType: "password", refreshToken: t2.refreshToken })).error.code, "request.invalid");
    // Access tokens expire.
    await h.s.db.query("UPDATE end_user_tokens SET expires_at = now() - interval '1 second' WHERE kind = 'access' AND family = (SELECT family FROM end_user_tokens WHERE kind = 'access' ORDER BY created_at DESC LIMIT 1)");
    assert.equal(json(await inject({ method: "GET", url: "/v1/me", headers: bearer(t2.accessToken) })).error.code, "auth.token_expired");
    // Sign out.
    assert.equal((await post("/v1/auth/revoke", { client_id, refreshToken: t2.refreshToken })).statusCode, 204);
    assert.equal(json(await post("/v1/auth/token", { client_id, grantType: "refresh_token", refreshToken: t2.refreshToken })).error.code, "auth.refresh_invalid");
    assert.equal((await post("/v1/auth/revoke", { client_id, refreshToken: "nc_rt_unknown" })).statusCode, 204);
  });

  it("lets the previous refresh token back within the grace window (issue #52)", async () => {
    const { client_id } = await setup();
    const refresh = (refreshToken: string) => post("/v1/auth/token", { client_id, grantType: "refresh_token", refreshToken });
    const a = await signIn(client_id, "grace@example.com");
    const b = json(await refresh(a.refreshToken));
    // The answer was lost: A again gets B back, with a fresh access token.
    const again = await refresh(a.refreshToken);
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(json(again).refreshToken, b.refreshToken);
    assert.notEqual(json(again).accessToken, b.accessToken);
    for (const access of [b.accessToken, json(again).accessToken]) assert.equal((await inject({ method: "GET", url: "/v1/me", headers: bearer(access) })).statusCode, 200);
    // One chain: B goes on, and once B is rotated A is two generations old, even inside the window.
    const c = json(await refresh(b.refreshToken));
    assert.match(c.refreshToken, /^nc_rt_/);
    assert.equal(json(await refresh(a.refreshToken)).error.code, "auth.refresh_invalid");
    assert.equal(json(await refresh(c.refreshToken)).error.code, "auth.refresh_invalid");  // the chain was revoked
    assert.equal(Number((await h.s.db.query("SELECT count(*) AS n FROM end_user_tokens WHERE successor_secret IS NOT NULL AND end_user = $1", [a.endUser.id])).rows[0].n), 0);

    // Two refreshes racing with the same token: both succeed with the same successor.
    await age();
    const d = await signIn(client_id, "grace@example.com");
    const [r1, r2] = await Promise.all([refresh(d.refreshToken), refresh(d.refreshToken)]);
    assert.equal(r1.statusCode, 200, r1.body);
    assert.equal(r2.statusCode, 200, r2.body);
    assert.equal(json(r1).refreshToken, json(r2).refreshToken);
    assert.equal((await refresh(json(r1).refreshToken)).statusCode, 200);

    // After the window: revoked, as before.
    await age();
    const e = await signIn(client_id, "grace@example.com");
    const f = json(await refresh(e.refreshToken));
    await h.s.db.query("UPDATE end_user_tokens SET used_at = now() - interval '61 seconds' WHERE used_at IS NOT NULL");
    assert.equal(json(await refresh(e.refreshToken)).error.code, "auth.refresh_invalid");
    assert.equal(json(await refresh(f.refreshToken)).error.code, "auth.refresh_invalid");
    // Retention drops the kept secrets after 10 minutes.
    const g = await signIn(client_id, "grace2@example.com");
    await refresh(g.refreshToken);
    await h.s.db.query("UPDATE end_user_tokens SET used_at = now() - interval '11 minutes' WHERE successor_secret IS NOT NULL");
    const { runRetention } = await import("../src/retention.js");
    await runRetention(h.s.db, h.s.storage);
    assert.equal(Number((await h.s.db.query("SELECT count(*) AS n FROM end_user_tokens WHERE successor_secret IS NOT NULL")).rows[0].n), 0);
  });

  it("blocks an end user from the partner's server", async () => {
    const { client_id, server } = await setup();
    const t = await signIn(client_id, "troll@example.com");
    const block = await inject({ method: "POST", url: `/v1/partner/end-users/${t.endUser.id}/block`, headers: server });
    assert.deepEqual(json(block), { endUser: t.endUser.id, blocked: true });
    assert.equal(json(await inject({ method: "GET", url: "/v1/me", headers: bearer(t.accessToken) })).error.code, "auth.token_revoked");
    assert.equal(json(await post("/v1/auth/token", { client_id, grantType: "refresh_token", refreshToken: t.refreshToken })).error.code, "auth.refresh_invalid");
    // No code is sent to a blocked identity, but the answer is the same.
    await age();
    const before = sent.length;
    assert.equal((await post("/v1/auth/email/start", { client_id, email: "troll@example.com" })).statusCode, 202);
    assert.equal(sent.length, before);
    assert.equal((await inject({ method: "POST", url: "/v1/partner/end-users/eu_unknown/block", headers: server })).statusCode, 404);
    assert.equal(json(await inject({ method: "DELETE", url: `/v1/partner/end-users/${t.endUser.id}/block`, headers: server })).blocked, false);
    await age();
    assert.equal((await signIn(client_id, "troll@example.com")).endUser.id, t.endUser.id);
  });

  it("deletes the account from the app: identity, data and tokens", async () => {
    await presetCatalog();
    const { client_id } = await setup();
    const t = await signIn(client_id, "gone@example.com");
    const job = await submit(bearer(t.accessToken));
    assert.equal(job.statusCode, 201, job.body);
    assert.equal((await inject({ method: "DELETE", url: "/v1/me", headers: bearer(t.accessToken) })).statusCode, 204);
    assert.equal(Number((await h.s.db.query("SELECT count(*) AS n FROM partner_end_users WHERE end_user = $1", [t.endUser.id])).rows[0].n), 0);
    assert.equal(Number((await h.s.db.query("SELECT count(*) AS n FROM end_user_tokens WHERE end_user = $1", [t.endUser.id])).rows[0].n), 0);
    assert.equal(Number((await h.s.db.query("SELECT count(*) AS n FROM assets WHERE end_user = $1", [t.endUser.id])).rows[0].n), 0);
    assert.equal((await h.s.db.query("SELECT 1 FROM jobs WHERE id = $1", [json(job).job.id])).rows.length, 0);  // cancelled, then deleted
    assert.equal((await inject({ method: "GET", url: "/v1/me", headers: bearer(t.accessToken) })).statusCode, 401);
    await age();
    assert.notEqual((await signIn(client_id, "gone@example.com")).endUser.id, t.endUser.id);
  });

  it("turns the shipped app token off, and caps all end users of a partner per day", async () => {
    await presetCatalog();
    const { p, client_id, appToken } = await setup();
    const t = await signIn(client_id, "cap@example.com");
    await age();
    const t2 = await signIn(client_id, "cap2@example.com");
    await h.s.db.query("INSERT INTO partners (user_id, partner_daily_jobs, require_end_user_tokens) VALUES ($1, 2, true)", [p.id]);
    const old = await submit({ authorization: `Bearer ${appToken}`, "x-end-user": "install-1" });
    assert.equal(old.statusCode, 401);
    assert.equal(json(old).error.code, "auth.end_user_token_required");
    const done = async (r: { body: string }) => h.s.db.query("UPDATE jobs SET state = 'succeeded' WHERE id = $1", [JSON.parse(r.body).job.id]);
    await done(await submit(bearer(t.accessToken)));
    const second = await submit(bearer(t2.accessToken));
    assert.equal(second.statusCode, 201, second.body);
    await done(second);
    const third = await submit(bearer(t.accessToken));
    assert.equal(third.statusCode, 429);
    assert.equal(json(third).error.code, "quota.partner_daily");
  });

  it("sends the code through Brevo's API", async () => {
    const { BrevoMailer, signInMessage } = await import("../src/mailer.js");
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"messageId":"x"}', { status: 201 });
    }) as unknown as typeof fetch;
    await new BrevoMailer("key-123", "NeuraCraft <no-reply@neuracraft.app>", fake).sendSignInCode({ to: "ada@example.com", code: "042137", appName: "GM Cebi", locale: "tr", minutes: 10 });
    assert.equal(calls[0]!.url, "https://api.brevo.com/v3/smtp/email");
    assert.equal((calls[0]!.init.headers as Record<string, string>)["api-key"], "key-123");
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.deepEqual(body.sender, { email: "no-reply@neuracraft.app", name: "NeuraCraft" });
    assert.deepEqual(body.to, [{ email: "ada@example.com" }]);
    assert.equal(body.subject, "GM Cebi giriş kodun: 042137");
    assert.match(body.textContent, /10 dakika/);
    const failing = (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch;
    await assert.rejects(new BrevoMailer("k", "a@b.co", failing).sendSignInCode({ to: "x@example.com", code: "1", appName: "A", locale: "en", minutes: 10 }));
    assert.match(signInMessage({ to: "", code: "1", appName: "<b>", locale: "en", minutes: 10 }).html, /&lt;b&gt;/);
  });

  it("cleans up old codes and dead tokens", async () => {
    const { runRetention } = await import("../src/retention.js");
    const { client_id } = await setup();
    const t = await signIn(client_id, "old@example.com");
    await post("/v1/auth/revoke", { client_id, refreshToken: t.refreshToken });
    await h.s.db.query("UPDATE end_user_tokens SET revoked_at = now() - interval '2 days'");
    await h.s.db.query("UPDATE sign_in_codes SET created_at = now() - interval '2 days'");
    await runRetention(h.s.db, h.s.storage);
    assert.equal(Number((await h.s.db.query("SELECT count(*) AS n FROM end_user_tokens WHERE end_user = $1", [t.endUser.id])).rows[0].n), 0);
    assert.equal(Number((await h.s.db.query("SELECT count(*) AS n FROM sign_in_codes WHERE client_id = $1", [client_id])).rows[0].n), 0);
  });
});

describe("operator console", () => {
  it("is for operators only, shows every account's metadata, and content only with support access (logged)", async () => {
    await presetCatalog();
    const { createToken } = await import("../src/auth.js");
    const mail = (n: string) => `${n}${Math.random().toString(36).slice(2, 8)}@example.com`;
    const [opEmail, partnerEmail] = [mail("op"), mail("partner")];
    const op = { ...(await signUp(h.app, opEmail)), email: opEmail };
    const partner = { ...(await signUp(h.app, partnerEmail)), email: partnerEmail };
    const other = await signUp(h.app);
    const get = (url: string, cookie = op.cookie) => inject({ method: "GET", url, headers: { cookie } });
    // Not yet an operator; tokens never reach the console.
    assert.equal((await get("/v1/admin/overview")).statusCode, 403);
    await h.s.db.query("UPDATE users SET operator = true WHERE id = $1", [op.id]);
    assert.equal(json(await get("/v1/me")).operator, true);
    assert.equal(json(await get("/v1/me", partner.cookie)).operator, false);
    const pat = (await createToken(h.s.db, op.id, "pat", "script", ["jobs:read"], null)).secret;
    assert.equal((await inject({ method: "GET", url: "/v1/admin/overview", headers: { authorization: `Bearer ${pat}` } })).statusCode, 403);
    assert.equal((await get("/v1/admin/overview", other.cookie)).statusCode, 403);

    // A partner end user's map job.
    await h.s.db.query("INSERT INTO partners (user_id) VALUES ($1)", [partner.id]);
    await h.s.db.query("INSERT INTO ledger (user_id, kind, amount) VALUES ($1, 'grant', 1000000)", [partner.id]);
    const appToken = (await createToken(h.s.db, partner.id, "app", "app", ["jobs:submit", "jobs:read", "assets:read"], null)).secret;
    const submitted = await inject({
      method: "POST", url: "/v1/presets/sketch_to_scene/jobs", headers: { authorization: `Bearer ${appToken}`, "x-end-user": "tester-1" },
      payload: { params: { mode: "map", narrative: "Nehrin üzerinde köprü" }, inputs: { sketch: { inline: PNG_1x1.toString("base64"), contentType: "image/png" } } },
    });
    assert.equal(submitted.statusCode, 201, submitted.body);
    const jobId = json(submitted).job.id;

    const ov = json(await get("/v1/admin/overview"));
    assert.ok(ov.jobs24h.some((r: { email: string; total: number }) => r.email === partner.email && r.total >= 1));
    assert.equal(typeof ov.capacity.spend.todayUsd, "number");
    assert.ok(Array.isArray(ov.events));
    const list = json(await get("/v1/admin/accounts")).accounts;
    const row = list.find((a: { id: string }) => a.id === partner.id);
    assert.equal(row.partner, true);
    assert.ok(row.credits > 1000 && row.credits < 1100, String(row.credits));  // grant + sign-up credits - the reservation
    const detail = json(await get(`/v1/admin/accounts/${partner.id}`));
    assert.equal(detail.account.email, partner.email);
    assert.ok(detail.partner);
    assert.equal(detail.tokens[0].name, "app");
    assert.equal(JSON.stringify(detail).includes("secret_hash"), false);

    // Metadata only: no pictures, no texts, nothing logged.
    const meta = json(await get(`/v1/admin/jobs?account=${partner.id}`)).jobs;
    assert.equal(meta.length, 1);
    assert.deepEqual([meta[0].id, meta[0].endUser, meta[0].mode, meta[0].content, meta[0].pictures, meta[0].narrative], [jobId, "tester-1", "map", null, undefined, undefined]);
    assert.equal(meta[0].regions, false);
    assert.equal(Number((await h.s.db.query("SELECT count(*) AS n FROM moderation_log WHERE action = 'view_content'")).rows[0].n), 0);

    // The account grants support access itself: pictures and texts, each view logged.
    const grant = await inject({ method: "PATCH", url: "/v1/me", headers: { cookie: partner.cookie }, payload: { supportAccessDays: 30 } });
    assert.equal(grant.statusCode, 200, grant.body);
    assert.ok(json(grant).supportAccessUntil);
    assert.equal((await inject({ method: "PATCH", url: "/v1/me", headers: { cookie: partner.cookie }, payload: { supportAccessDays: 91 } })).statusCode, 400);
    const full = json(await get(`/v1/admin/jobs/${jobId}`)).job;
    assert.equal(full.content, "support_access");
    assert.match(full.pictures.sketch, /\/v1\/storage\//);
    assert.equal(full.narrative, "Nehrin üzerinde köprü");
    assert.ok(full.prompt);
    const log = json(await get("/v1/admin/audit")).entries;
    assert.ok(log.some((e: { action: string; job_id: string; operator: string }) => e.action === "view_content" && e.job_id === jobId && e.operator === op.email));
    await get(`/v1/admin/jobs?account=${partner.id}`);  // looked at again: still one entry this hour
    assert.equal(Number((await h.s.db.query("SELECT count(*) AS n FROM moderation_log WHERE action = 'view_content' AND job_id = $1", [jobId])).rows[0].n), 1);
    assert.ok(log.some((e: { action: string; email: string }) => e.action === "support_access" && e.email === partner.email));
    // Filters.
    assert.equal(json(await get(`/v1/admin/jobs?account=${other.id}`)).jobs.length, 0);
    assert.equal(json(await get(`/v1/admin/jobs?account=${partner.id}&regions=true`)).jobs.length, 0);
    assert.equal(json(await get(`/v1/admin/jobs?account=${partner.id}&endUser=tester-1&state=queued`)).jobs.length, 1);
    assert.equal(json(await get(`/v1/admin/jobs?account=${partner.id}&endUser=test`)).jobs.length, 1);  // the start is enough
    assert.equal(json(await get(`/v1/admin/jobs?account=${partner.id}&endUser=test_r`)).jobs.length, 0);  // "_" is not a wildcard
    assert.equal((await get("/v1/admin/jobs?account=nope")).statusCode, 400);

    // The operator can end support access, not grant it.
    const post = (url: string, payload: object) => inject({ method: "POST", url, headers: { cookie: op.cookie }, payload });
    assert.equal((await post(`/v1/admin/accounts/${partner.id}/support-access`, { days: 30 })).statusCode, 400);
    assert.equal((await post(`/v1/admin/accounts/${partner.id}/support-access`, { days: 0 })).statusCode, 200);
    assert.equal(json(await get(`/v1/admin/jobs/${jobId}`)).job.content, null);

    // The closed-beta switch: every account's content, still logged.
    const { setOperatorSeesAllContent } = await import("../src/console.js");
    setOperatorSeesAllContent(true);
    try {
      assert.equal(json(await get(`/v1/admin/jobs/${jobId}`)).job.content, "beta");
      assert.equal(json(await get("/v1/admin/overview")).seeAllContent, true);
    } finally {
      setOperatorSeesAllContent(false);
    }

    // Blocking a signed-in end user for abuse.
    await h.s.db.query("INSERT INTO partner_end_users (user_id, end_user, identity_key) VALUES ($1, 'eu_console', '\\x00')", [partner.id]);
    assert.equal(json(await post(`/v1/admin/accounts/${partner.id}/end-users/eu_console/block`, { note: "spam" })).blocked, true);
    assert.ok((await h.s.db.query("SELECT blocked_at FROM partner_end_users WHERE end_user = 'eu_console'")).rows[0].blocked_at);
    assert.equal((await post(`/v1/admin/accounts/${partner.id}/end-users/eu_nobody/block`, {})).statusCode, 404);
    assert.equal(json(await post(`/v1/admin/accounts/${partner.id}/end-users/eu_console/unblock`, {})).blocked, false);

    // The usage report, from the console.
    assert.equal((await get("/v1/admin/usage-report?from=2020-01-01")).statusCode, 200);
  });

  it("makes OPERATOR_EMAILS operators on sign-up", async () => {
    const email = `boot${Math.random().toString(36).slice(2, 8)}@example.com`;
    h.s.config.operatorEmails = [email];
    try {
      const u = await signUp(h.app, email);
      assert.equal(json(await inject({ method: "GET", url: "/v1/me", headers: { cookie: u.cookie } })).operator, true);
      const other = await signUp(h.app);
      assert.equal(json(await inject({ method: "GET", url: "/v1/me", headers: { cookie: other.cookie } })).operator, false);
    } finally {
      h.s.config.operatorEmails = [];
    }
  });

  it("works the report queue with the evidence", async () => {
    const opEmail = `op${Math.random().toString(36).slice(2, 8)}@example.com`;
    const op = { ...(await signUp(h.app, opEmail)), email: opEmail };
    await h.s.db.query("UPDATE users SET operator = true WHERE id = $1", [op.id]);
    const owner = await signUp(h.app);
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(PNG_1x1).digest("hex");
    await h.s.storage.put(`blobs/${sha}`, PNG_1x1);
    await h.s.db.query("INSERT INTO blobs (sha256, bytes) VALUES ($1, $2) ON CONFLICT DO NOTHING", [sha, PNG_1x1.length]);
    const asset = (await h.s.db.query<{ id: string }>("INSERT INTO assets (owner_id, kind, name, content_type, sha256, bytes) VALUES ($1, 'output', 'scene.png', 'image/png', $2, $3) RETURNING id", [owner.id, sha, PNG_1x1.length])).rows[0]!.id;
    assert.equal((await inject({ method: "POST", url: `/v1/assets/${asset}/report`, headers: { cookie: owner.cookie }, payload: { reason: "other", note: "test" } })).statusCode, 202);
    const reports = json(await inject({ method: "GET", url: "/v1/admin/reports", headers: { cookie: op.cookie } })).reports;
    const r = reports.find((x: { account: { id: string } | null }) => x.account?.id === owner.id);
    assert.equal(r.reason, "other");
    assert.match(r.output, /\/v1\/storage\//);
    assert.equal((await inject({ method: "POST", url: `/v1/admin/reports/${r.id}/dismiss`, headers: { cookie: op.cookie }, payload: { note: "fine" } })).statusCode, 200);
    const after = json(await inject({ method: "GET", url: "/v1/admin/reports?status=all", headers: { cookie: op.cookie } })).reports.find((x: { id: string }) => x.id === r.id);
    assert.deepEqual([after.status, after.resolvedBy, after.output], ["dismissed", op.email, null]);
    assert.equal((await inject({ method: "POST", url: "/v1/admin/reports/00000000-0000-0000-0000-000000000000/remove", headers: { cookie: op.cookie }, payload: {} })).statusCode, 404);
  });
});
