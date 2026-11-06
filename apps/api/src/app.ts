import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { ApiFailure } from "./errors.js";
import type { JobEvents } from "./events.js";
import { assetRoutes } from "./routes/assets.js";
import { authRoutes } from "./routes/auth.js";
import { jobRoutes } from "./routes/jobs.js";
import { storageRoutes } from "./routes/storage.js";
import { workerRoutes } from "./routes/worker.js";
import type { Storage } from "./storage.js";

export interface Services {
  config: Config;
  db: Db;
  storage: Storage;
  events: JobEvents;
}

export async function buildApp(s: Services, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 << 20, trustProxy: true, routerOptions: { maxParamLength: 2048 } });
  await app.register(cookie);
  // Uploads to signed storage URLs arrive as raw streams of any type.
  app.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiFailure) return reply.status(err.status).send({ error: { code: err.code, params: err.params } });
    const e = err as { statusCode?: number; code?: string; validation?: unknown };
    if (e.statusCode === 413 || e.code === "FST_ERR_CTP_BODY_TOO_LARGE") return reply.status(413).send({ error: { code: "request.too_large" } });
    if (e.validation || (e.statusCode && e.statusCode >= 400 && e.statusCode < 500))
      return reply.status(e.statusCode ?? 400).send({ error: { code: "request.invalid" } });
    req.log.error(err);
    return reply.status(500).send({ error: { code: "internal" } });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: "not_found" } }));

  app.get("/v1/health", async () => {
    await s.db.query("SELECT 1");
    return { ok: true };
  });
  await authRoutes(app, s);
  await assetRoutes(app, s);
  await jobRoutes(app, s);
  await workerRoutes(app, s);
  await storageRoutes(app, s);
  return app;
}
