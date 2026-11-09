import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { connect, migrate } from "./db.js";
import { JobEvents } from "./events.js";
import { reapLeases } from "./scheduler.js";
import { runRetention } from "./retention.js";
import { LocalStorage } from "./storage.js";
import { CapacityManager } from "./capacity.js";
import { RunpodProvider } from "./providers/runpod.js";

const config = loadConfig();
if (config.storage.kind !== "local") throw new Error("STORAGE=s3 arrives with the deployment milestone");
const db = connect(config.databaseUrl);
const applied = await migrate(db, config.migrationsDir);
const events = new JobEvents(config.databaseUrl);
await events.start();
const storage = new LocalStorage(config.storage.dir, config.signingKey, config.publicUrl);
// Sessions and on-demand GPU pods (capacity.ts): without CAPACITY_PROVIDER the manager only closes
// stale sessions; GPU workers are started by hand.
const services = { config, db, storage, events } as Parameters<typeof buildApp>[0];
const app = await buildApp(services, { logger: true });
const provider = config.capacity.provider === "runpod" ? new RunpodProvider(config.capacity.runpod) : null;
services.capacity = new CapacityManager(db, config.capacity, config.sessions, provider, (msg, extra) => app.log.info(extra ?? {}, msg));
const capacityLoop = setInterval(() => services.capacity!.kick(), config.capacity.everySeconds * 1000);
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
    clearInterval(capacityLoop);
    await services.capacity?.settle();
    await app.close();
    await events.stop();
    await db.end();
    process.exit(0);
  });
