// Partner apps' end users (issue #21, #19):
//   GET    /v1/partner/end-users/:id/usage  jobs, cost, today's quota
//   DELETE /v1/partner/end-users/:id        everything stored for that end user
// Callers: the partner's server (an app token with partner:manage, any end user), or the app itself
// acting for that same end user (X-End-User equal to :id), so an app without a backend can offer
// "delete my data" and "my usage".
import type { FastifyInstance } from "fastify";
import type { Services } from "../app.js";
import { END_USER, PARTNER_SCOPE, requireUser, type AuthedUser } from "../auth.js";
import { tx } from "../db.js";
import { fail } from "../errors.js";
import { deleteEndUser, endUserDay, endUserUsage, partnerSettings } from "../partners.js";

export async function partnerRoutes(app: FastifyInstance, s: Services) {
  const allowed = async (req: Parameters<typeof requireUser>[1], id: string): Promise<AuthedUser> => {
    const u = await requireUser(s.db, req, "any");
    if (u.tokenKind !== "app") fail(403, "forbidden");
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
      jobs: await endUserUsage(s.db, u.id, req.params.id, Number(req.query.limit ?? 500) || 500),
    };
  });

  app.delete<{ Params: { id: string } }>("/v1/partner/end-users/:id", async (req) => {
    const u = await allowed(req, req.params.id);
    const deleted = await tx(s.db, (c) => deleteEndUser(c, u.id, req.params.id));
    return { endUser: req.params.id, deleted };
  });
}
