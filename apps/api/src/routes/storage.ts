// Signed URLs of the local storage driver (STORAGE=local): PUT and GET /v1/storage/<token>.
import type { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { Services } from "../app.js";
import { fail } from "../errors.js";
import { LocalStorage } from "../storage.js";

export async function storageRoutes(app: FastifyInstance, s: Services) {
  if (!(s.storage instanceof LocalStorage)) return;
  const store = s.storage;
  app.put<{ Params: { token: string } }>("/v1/storage/:token", { bodyLimit: 8 * 1024 ** 3 }, async (req) => {
    const g = store.verify(req.params.token, "PUT") ?? fail(403, "forbidden");
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > (g.n ?? 0)) fail(413, "request.too_large");
    try {
      const bytes = await store.write(g.k, req.body as Readable, g.n ?? 0);
      return { ok: true, bytes };
    } catch {
      return fail(413, "request.too_large");
    }
  });
  app.get<{ Params: { token: string } }>("/v1/storage/:token", async (req, reply) => {
    const g = store.verify(req.params.token, "GET") ?? fail(403, "forbidden");
    reply.header("cache-control", "private, max-age=600");
    if (g.f) reply.header("content-disposition", `inline; filename="${g.f.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
    const type = /\.png$/i.test(g.f ?? "") ? "image/png" : /\.jpe?g$/i.test(g.f ?? "") ? "image/jpeg" : /\.gif$/i.test(g.f ?? "") ? "image/gif" : /\.mov$/i.test(g.f ?? "") ? "video/quicktime" : "application/octet-stream";
    reply.type(type);
    try {
      store.path(g.k);
    } catch {
      fail(404, "not_found");
    }
    const stream = store.read(g.k);
    return new Promise((resolve) => {
      stream.once("error", () => resolve(reply.status(404).send({ error: { code: "not_found" } })));
      stream.once("open", () => resolve(reply.send(stream)));
    });
  });
}
