// Each test file gets its own database (TEST_DATABASE_URL points at a server; a database named
// nc_test_<random> is made and dropped) and its own storage folder.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp, type Services } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { connect, migrate } from "../src/db.js";
import { JobEvents } from "../src/events.js";
import { LocalStorage } from "../src/storage.js";

export const WORKER_TOKEN = "test-worker-token";

export interface Harness {
  app: FastifyInstance;
  s: Services;
  close(): Promise<void>;
}

export async function harness(): Promise<Harness> {
  const server = process.env.TEST_DATABASE_URL ?? "postgres://nc@localhost:5433/postgres";
  const name = `nc_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: server });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(server);
  url.pathname = `/${name}`;
  const dir = await mkdtemp(path.join(tmpdir(), "nc-storage-"));
  const config = loadConfig({ DATABASE_URL: url.toString(), STORAGE_DIR: dir, WORKER_TOKENS: WORKER_TOKEN, PUBLIC_URL: "http://api.test", SIGNUP_CREDITS: "50000" });
  const db = connect(config.databaseUrl);
  await migrate(db, config.migrationsDir);
  const events = new JobEvents(config.databaseUrl);
  await events.start();
  const storage = new LocalStorage(dir, config.signingKey, config.publicUrl);
  const s: Services = { config, db, storage, events };
  const app = await buildApp(s);
  return {
    app,
    s,
    async close() {
      await app.close();
      await events.stop();
      await db.end();
      const a = new pg.Client({ connectionString: server });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// A signed-in user: the cookie to send.
export async function signUp(app: FastifyInstance, email = `u${randomBytes(4).toString("hex")}@example.com`): Promise<{ cookie: string; id: string }> {
  const r = await app.inject({ method: "POST", url: "/v1/auth/signup", payload: { email, password: "correct horse battery" } });
  if (r.statusCode !== 201) throw new Error(`signup: ${r.statusCode} ${r.body}`);
  const c = r.cookies.find((x) => x.name === "nc_session")!;
  return { cookie: `nc_session=${c.value}`, id: r.json().user.id };
}

export const json = (r: LightMyRequestResponse) => r.json() as any;

// A signed storage URL as an inject path.
export const local = (url: string) => new URL(url).pathname;

export const PNG_1x1 = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63f8cfc0000003010100c9fe92ef0000000049454e44ae426082", "hex");

// Uploads a picture as the user; returns the asset id.
export async function uploadPicture(app: FastifyInstance, cookie: string, bytes = PNG_1x1, name = "in.png"): Promise<string> {
  const a = await app.inject({ method: "POST", url: "/v1/assets", headers: { cookie }, payload: { name, kind: "input", bytes: bytes.length, contentType: "image/png" } });
  if (a.statusCode !== 201) throw new Error(a.body);
  const put = await app.inject({ method: "PUT", url: local(json(a).uploadUrl), payload: bytes, headers: { "content-type": "application/octet-stream" } });
  if (put.statusCode !== 200) throw new Error(put.body);
  const done = await app.inject({ method: "POST", url: `/v1/assets/${json(a).asset.id}/complete`, headers: { cookie } });
  if (done.statusCode !== 200) throw new Error(done.body);
  return json(a).asset.id;
}

export const worker = { authorization: `Bearer ${WORKER_TOKEN}` };
