// Partner apps' end users (issue #21, #19):
//   GET    /v1/partner/end-users/:id/usage  jobs, cost, today's quota
//   DELETE /v1/partner/end-users/:id        everything stored for that end user
//   POST   /v1/partner/end-users/:id/allowance  credits for that end user (partner:manage only)
//   POST   /v1/partner/end-users/:id/block      a signed-in end user can no longer sign in or use
//   DELETE /v1/partner/end-users/:id/block      their tokens (issue #48; partner:manage only)
// Callers: the partner's server (an app token with partner:manage, any end user), or the app itself
// acting for that same end user (X-End-User equal to :id), so an app without a backend can offer
// "delete my data" and "my usage".
import type { FastifyInstance } from "fastify";
import type { Services } from "../app.js";
import { END_USER, PARTNER_SCOPE, requireUser, type AuthedUser } from "../auth.js";
import { tx } from "../db.js";
import { fail } from "../errors.js";
import { setBlocked } from "../endusers.js";
import { allowanceBalance, allowanceEntries, deleteEndUser, endUserDay, endUserUsage, grantAllowance, partnerSettings } from "../partners.js";

export async function partnerRoutes(app: FastifyInstance, s: Services) {
  const allowed = async (req: Parameters<typeof requireUser>[1], id: string): Promise<AuthedUser> => {
    const u = await requireUser(s.db, req, "any");
    if (u.tokenKind !== "app" && u.tokenKind !== "eu") fail(403, "forbidden");
    if (!END_USER.test(id)) fail(404, "not_found");
    if (!u.scopes?.includes(PARTNER_SCOPE) && u.endUser !== id) fail(403, "forbidden");
    return u;
  };

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/v1/partner/end-users/:id/usage", async (req) => {
    const u = await allowed(req, req.params.id);
    const p = await partnerSettings(s.db, u.id);
    const day = p ? await endUserDay(s.db, u.id, req.params.id, p.quotaTimezone) : null;
    return {
      endUser: req.params.id,
      today: p && day ? { used: day.used, limit: p.endUserDailyJobs, resetsAt: day.resetsAt.toISOString() } : null,
      allowance: { balance: await allowanceBalance(s.db, u.id, req.params.id), entries: await allowanceEntries(s.db, u.id, req.params.id) },
      jobs: await endUserUsage(s.db, u.id, req.params.id, Number(req.query.limit ?? 500) || 500),
    };
  });

  // Called by the partner's server after it validated a store receipt; never by the app (it would
  // grant itself credits), hence partner:manage. Idempotent on externalRef. credits in credits
  // (1 credit = 1000 millicredits, the amounts elsewhere).
  app.post<{ Params: { id: string }; Body: { credits?: unknown; reason?: unknown; externalRef?: unknown } }>(
    "/v1/partner/end-users/:id/allowance",
    async (req, reply) => {
      const u = await requireUser(s.db, req, PARTNER_SCOPE);
      if (u.tokenKind !== "app") fail(403, "forbidden");
      if (!END_USER.test(req.params.id)) fail(404, "not_found");
      const b = req.body ?? {};
      const credits = Number(b.credits);
      if (typeof b.credits !== "number" || !Number.isFinite(credits) || credits <= 0 || credits > 1_000_000) fail(400, "request.invalid", { field: "credits" });
      if (typeof b.externalRef !== "string" || !b.externalRef.trim() || b.externalRef.length > 200) fail(400, "request.invalid", { field: "externalRef" });
      if (b.reason !== undefined && (typeof b.reason !== "string" || b.reason.length > 200)) fail(400, "request.invalid", { field: "reason" });
      const grant = await tx(s.db, (c) =>
        grantAllowance(c, u.id, req.params.id, Math.round(credits * 1000), typeof b.reason === "string" ? b.reason : null, (b.externalRef as string).trim()),
      );
      const { created, ...rest } = grant;
      return reply.status(created ? 201 : 200).send({ grant: rest, balance: await allowanceBalance(s.db, u.id, req.params.id) });
    },
  );

  app.delete<{ Params: { id: string } }>("/v1/partner/end-users/:id", async (req) => {
    const u = await allowed(req, req.params.id);
    const deleted = await tx(s.db, (c) => deleteEndUser(c, u.id, req.params.id));
    return { endUser: req.params.id, deleted };
  });

  for (const [method, blocked] of [["POST", true], ["DELETE", false]] as const)
    app.route<{ Params: { id: string } }>({
      method,
      url: "/v1/partner/end-users/:id/block",
      handler: async (req) => {
        const u = await requireUser(s.db, req, PARTNER_SCOPE);
        if (u.tokenKind !== "app") fail(403, "forbidden");
        if (!END_USER.test(req.params.id) || !(await setBlocked(s.db, u.id, req.params.id, blocked))) fail(404, "not_found");
        return { endUser: req.params.id, blocked };
      },
    });
}
