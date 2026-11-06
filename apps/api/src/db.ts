import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

export type Db = pg.Pool;

export function connect(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 10 });
}

// Applies db/migrations/*.sql in name order, each once, under an advisory lock (several API copies may start together).
export async function migrate(db: Db, dir: string): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(727001)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727001)").catch(() => {});
    client.release();
  }
  return applied;
}

// Runs fn in a transaction.
export async function tx<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
