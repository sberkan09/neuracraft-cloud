import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { ApiFailure } from "./errors.js";
import type { JobEvents } from "./events.js";
import { assetRoutes } from "./routes/assets.js";
import { authRoutes } from "./routes/auth.js";
import { jobRoutes } from "./routes/jobs.js";
import { presetRoutes } from "./routes/presets.js";
import { reportRoutes } from "./routes/reports.js";
import { tokenRoutes } from "./routes/tokens.js";
import { storageRoutes } from "./routes/storage.js";
import { workerRoutes } from "./routes/worker.js";
import type { Storage } from "./storage.js";
import { LlmPromptWriter, TemplatePromptWriter, type PromptWriter } from "./prompts.js";
import { EngineModerator, parseThresholds, type Moderator } from "./moderation.js";

export interface Services {
  config: Config;
  db: Db;
  storage: Storage;
  events: JobEvents;
  promptWriter?: PromptWriter; // default: Claude when ANTHROPIC_API_KEY is set, else the template
  moderator?: Moderator; // default: the engine's classify scores against MODERATION_THRESHOLDS
}

export function moderatorFor(s: Services): Moderator {
  s.moderator ??= new EngineModerator(parseThresholds(s.config.moderationThresholds));
  return s.moderator;
}

export function promptWriterFor(s: Services): PromptWriter {
  s.promptWriter ??= s.config.anthropicApiKey
    ? new LlmPromptWriter(s.config.anthropicApiKey, s.config.promptModel, s.config.promptTimeoutMs)
    : new TemplatePromptWriter();
  return s.promptWriter;
}

// A request path for the logs: no query string, no signed storage token.
export const logUrl = (url: string) => url.split("?")[0]!.replace(/^\/v1\/storage\/[^/]+/, "/v1/storage/<signed>");

export async function buildApp(s: Services, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // Request logs carry the method, the path (signed storage tokens cut out) and the status: never
    // bodies (narratives, prompts, pictures), query strings or headers (issue #19).
    logger: opts.logger ? { serializers: { req: (r: { method: string; url: string }) => ({ method: r.method, url: logUrl(r.url) }) } } : false,
    bodyLimit: 2 << 20,
    trustProxy: true,
    routerOptions: { maxParamLength: 2048 },
  });
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
  await presetRoutes(app, s);
  await reportRoutes(app, s);
  await tokenRoutes(app, s);
  await workerRoutes(app, s);
  await storageRoutes(app, s);
  return app;
}
