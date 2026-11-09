// Operator endpoints, behind ADMIN_TOKENS (never given to apps or users).
//   GET /v1/admin/usage-report?from=2026-11-10&to=2026-12-10&fixedUsdMonth=10
//     the usage log's export (usage.ts) as JSON: {summary, files: {"jobs.csv": "...", ...}}
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Services } from "../app.js";
import { fail } from "../errors.js";
import { usageReport } from "../usage.js";

export async function adminRoutes(app: FastifyInstance, s: Services) {
  const tokens = s.config.adminTokens.map((t) => Buffer.from(t));
  const authorize = (req: FastifyRequest) => {
    const h = req.headers.authorization ?? "";
    const got = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
    if (!got.length || !tokens.some((t) => t.length === got.length && timingSafeEqual(t, got))) fail(401, "auth.required");
  };

  app.get<{ Querystring: { from?: string; to?: string; fixedUsdMonth?: string } }>("/v1/admin/usage-report", async (req) => {
    authorize(req);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 30 * 86400_000);
    const fixed = Number(req.query.fixedUsdMonth ?? 0);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || !(from < to) || !Number.isFinite(fixed) || fixed < 0) fail(400, "request.invalid");
    return usageReport(s.db, from, to, fixed);
  });
}
