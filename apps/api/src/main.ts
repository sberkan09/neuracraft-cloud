import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { connect, migrate } from "./db.js";
import { JobEvents } from "./events.js";
import { reapLeases } from "./scheduler.js";
import { runRetention } from "./retention.js";
import { LocalStorage } from "./storage.js";

const config = loadConfig();
if (config.storage.kind !== "local") throw new Error("STORAGE=s3 arrives with the deployment milestone");
const db = connect(config.databaseUrl);
const applied = await migrate(db, config.migrationsDir);
const events = new JobEvents(config.databaseUrl);
await events.start();
const storage = new LocalStorage(config.storage.dir, config.signingKey, config.publicUrl);
const app = await buildApp({ config, db, storage, events }, { logger: true });
if (applied.length) app.log.info({ applied }, "migrations applied");
const reaper = setInterval(() => reapLeases(db).catch((e) => app.log.error(e)), 5000);
const cleaner = config.retentionEvery > 0
  ? setInterval(() => runRetention(db, storage).then((r) => (r.assets || r.blobs || r.jobs || r.reports) && app.log.info({ retention: r }, "cleanup")).catch((e) => app.log.error(e)), config.retentionEvery * 1000)
  : undefined;
await app.listen({ port: config.port, host: config.host });
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, async () => {
    clearInterval(reaper);
    clearInterval(cleaner);
    await app.close();
    await events.stop();
    await db.end();
    process.exit(0);
  });
