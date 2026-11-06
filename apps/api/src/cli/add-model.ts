// Adds a model to the catalog (offered to everyone): a file, or a folder stored as a bundle.
//   node dist/src/cli/add-model.js <file|folder> --kind onnx --license Apache-2.0 [--name "..."] [--entry model.onnx]
// Uses DATABASE_URL and the storage settings of the API.
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { connect, migrate, tx } from "../db.js";
import { LocalStorage } from "../storage.js";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const source = args[0];
const kind = opt("kind"), license = opt("license");
if (!source || !kind || !license) {
  console.error("usage: add-model <file|folder> --kind <engine model kind> --license <license> [--name name] [--entry file]");
  process.exit(2);
}
const config = loadConfig();
if (config.storage.kind !== "local") throw new Error("only local storage so far");
const db = connect(config.databaseUrl);
await migrate(db, config.migrationsDir);
const storage = new LocalStorage(config.storage.dir, config.signingKey, config.publicUrl);

async function store(file: string): Promise<{ sha256: string; bytes: number }> {
  const key = `uploads/catalog-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await storage.write(key, createReadStream(file), Number.MAX_SAFE_INTEGER);
  const r = await storage.finalize(key);
  await db.query("INSERT INTO blobs (sha256, bytes) VALUES ($1, $2) ON CONFLICT DO NOTHING", [r.sha256, r.bytes]);
  return r;
}
async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error(`symlink in a model folder: ${p}`);
    if (e.isDirectory()) out.push(...(await walk(p, base)));
    else out.push(path.relative(base, p));
  }
  return out;
}

const name = opt("name") ?? path.basename(source);
const info = await stat(source);
const id = await tx(db, async (c) => {
  if (info.isDirectory()) {
    const files = await walk(source);
    const stored = [];
    for (const f of files) stored.push({ path: f.split(path.sep).join("/"), ...(await store(path.join(source, f))) });
    const total = stored.reduce((n, f) => n + f.bytes, 0);
    const a = await c.query<{ id: string }>(
      "INSERT INTO assets (owner_id, kind, model_kind, name, bytes, license, entry) VALUES (NULL, 'model', $1, $2, $3, $4, $5) RETURNING id",
      [kind, name, total, license, opt("entry") ?? null],
    );
    for (const f of stored) await c.query("INSERT INTO asset_files (asset_id, path, sha256, bytes) VALUES ($1, $2, $3, $4)", [a.rows[0]!.id, f.path, f.sha256, f.bytes]);
    return a.rows[0]!.id;
  }
  const b = await store(source);
  const a = await c.query<{ id: string }>(
    "INSERT INTO assets (owner_id, kind, model_kind, name, sha256, bytes, license) VALUES (NULL, 'model', $1, $2, $3, $4, $5) RETURNING id",
    [kind, path.basename(source), b.sha256, b.bytes, license],
  );
  return a.rows[0]!.id;
});
console.log(id);
await db.end();
