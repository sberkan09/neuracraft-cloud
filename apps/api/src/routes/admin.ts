// Operator endpoints.
//
// The operator console (apps/web, #admin) uses a signed-in operator's session (users.operator, set
// with cli/operator.js):
//   GET  /v1/admin/overview                  GPU pods, spend against the budgets, open sessions, jobs
//                                            in the last 24 h per account, capacity events, open reports
//   GET  /v1/admin/accounts                  every account with credits, partner or not, recent jobs
//   GET  /v1/admin/accounts/:id              one account: partner settings, clients, tokens, signed-in
//                                            end users, jobs per day, ledger
//   POST /v1/admin/accounts/:id/support-access   {days: 0}: ends the account's support access (only the
//                                            account owner or cli/support-access.js grants it)
//   POST /v1/admin/accounts/:id/end-users/:eu/block|unblock   for abuse, on behalf of the service
//   GET  /v1/admin/jobs?account=&endUser=&preset=&state=&regions=true|false&before=&limit=
//   GET  /v1/admin/jobs/:id
//   GET  /v1/admin/reports?status=open|all, POST /v1/admin/reports/:id/dismiss|remove|flag-account {note}
//   GET  /v1/admin/audit                     the moderation log: operator actions and content views
//   GET  /v1/admin/usage-report?from=&to=&fixedUsdMonth=   (also with ADMIN_TOKENS, for scripts)
// Metadata of every account is visible; pictures and texts only with the account's support access or
// an open report (console.ts), and each such view is logged.
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Services } from "../app.js";
import { requireUser } from "../auth.js";
import { account, accounts, auditLog, job, jobs, logAction, overview } from "../console.js";
import { setBlocked } from "../endusers.js";
import { fail } from "../errors.js";
import { dismissReport, flagAccount, listReports, removeReportedAsset, showReport } from "../moderation.js";
import { usageReport } from "../usage.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function adminRoutes(app: FastifyInstance, s: Services) {
  const tokens = s.config.adminTokens.map((t) => Buffer.from(t));
  const adminToken = (req: FastifyRequest) => {
    const h = req.headers.authorization ?? "";
    const got = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
    return got.length > 0 && tokens.some((t) => t.length === got.length && timingSafeEqual(t, got));
  };
  // A signed-in operator (cookie session only: no API token reaches the console). Returns the name the
  // moderation log records.
  const operator = async (req: FastifyRequest): Promise<string> => {
    const u = await requireUser(s.db, req, "session");
    const r = await s.db.query<{ operator: boolean }>("SELECT operator FROM users WHERE id = $1", [u.id]);
    if (!r.rows[0]?.operator) fail(403, "forbidden");
    return u.email;
  };
  const uuid = (v: string | undefined) => (v && UUID.test(v) ? v : fail(404, "not_found"));

  app.get<{ Querystring: { from?: string; to?: string; fixedUsdMonth?: string } }>("/v1/admin/usage-report", async (req) => {
    if (!adminToken(req)) await operator(req);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 30 * 86400_000);
    const fixed = Number(req.query.fixedUsdMonth ?? 0);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || !(from < to) || !Number.isFinite(fixed) || fixed < 0) fail(400, "request.invalid");
    return usageReport(s.db, from, to, fixed);
  });

  app.get("/v1/admin/overview", async (req) => {
    await operator(req);
    return overview(s.db, s.config);
  });

  app.get("/v1/admin/accounts", async (req) => {
    await operator(req);
    return { accounts: await accounts(s.db) };
  });

  app.get<{ Params: { id: string } }>("/v1/admin/accounts/:id", async (req) => {
    await operator(req);
    return (await account(s.db, uuid(req.params.id))) ?? fail(404, "not_found");
  });

  app.post<{ Params: { id: string }; Body: { days?: unknown; note?: unknown } }>("/v1/admin/accounts/:id/support-access", async (req) => {
    const op = await operator(req);
    const id = uuid(req.params.id);
    // Granting is the account's decision (PATCH /v1/me) or recorded with cli/support-access.js; here only ending it.
    if (req.body?.days !== 0) fail(400, "request.invalid", { field: "days" });
    const r = await s.db.query("UPDATE users SET support_access_until = NULL WHERE id = $1", [id]);
    if (!r.rowCount) fail(404, "not_found");
    await logAction(s.db, op, "support_access", id, "ended by operator");
    return { supportAccessUntil: null };
  });

  for (const action of ["block", "unblock"] as const)
    app.post<{ Params: { id: string; eu: string }; Body: { note?: unknown } }>(`/v1/admin/accounts/:id/end-users/:eu/${action}`, async (req) => {
      const op = await operator(req);
      const id = uuid(req.params.id);
      if (!(await setBlocked(s.db, id, req.params.eu, action === "block"))) fail(404, "not_found");
      await logAction(s.db, op, `${action}_end_user`, id, `${req.params.eu}${typeof req.body?.note === "string" ? `: ${req.body.note.slice(0, 500)}` : ""}`);
      return { endUser: req.params.eu, blocked: action === "block" };
    });

  app.get<{ Querystring: { account?: string; endUser?: string; preset?: string; state?: string; regions?: string; before?: string; limit?: string } }>(
    "/v1/admin/jobs",
    async (req) => {
      const op = await operator(req);
      const q = req.query;
      const before = q.before ? new Date(q.before) : undefined;
      if (before && Number.isNaN(before.getTime())) fail(400, "request.invalid", { field: "before" });
      if (q.account && !UUID.test(q.account)) fail(400, "request.invalid", { field: "account" });
      const limit = Math.min(Math.max(Number(q.limit ?? 30) || 30, 1), 100);
      return {
        jobs: await jobs(s.db, s.storage, op, {
          ...(q.account ? { account: q.account } : {}),
          ...(q.endUser ? { endUser: q.endUser } : {}),
          ...(q.preset ? { preset: q.preset } : {}),
          ...(q.state ? { state: q.state } : {}),
          ...(q.regions === "true" || q.regions === "false" ? { regions: q.regions === "true" } : {}),
          ...(before ? { before } : {}),
          limit,
        }),
      };
    },
  );

  app.get<{ Params: { id: string } }>("/v1/admin/jobs/:id", async (req) => {
    const op = await operator(req);
    return { job: (await job(s.db, s.storage, op, uuid(req.params.id))) ?? fail(404, "not_found") };
  });

  app.get<{ Querystring: { status?: string } }>("/v1/admin/reports", async (req) => {
    await operator(req);
    const rows = await listReports(s.db, { status: req.query.status === "all" ? "all" : "open", limit: 100 });
    // Open reports carry links to the reported output and its inputs (the evidence), 15 minutes long.
    const reports = [];
    for (const r of rows) {
      const shown = r.status === "open" ? await showReport(s.db, s.storage, r.id, 900) : null;
      reports.push({
        id: r.id, jobId: r.job_id, account: r.owner_id ? { id: r.owner_id, email: r.owner_email, flagged: r.owner_flagged !== null } : null,
        source: r.source, reason: r.reason, note: r.note, status: r.status, createdAt: r.created_at, resolvedAt: r.resolved_at, resolvedBy: r.resolved_by,
        snapshot: r.snapshot, output: shown?.output ?? null, inputs: shown?.inputs ?? [],
      });
    }
    return { reports };
  });

  const actions = { dismiss: dismissReport, remove: removeReportedAsset, "flag-account": flagAccount } as const;
  for (const [name, act] of Object.entries(actions))
    app.post<{ Params: { id: string }; Body: { note?: unknown } }>(`/v1/admin/reports/:id/${name}`, async (req) => {
      const op = await operator(req);
      const id = uuid(req.params.id);
      try {
        await act(s.db, id, op, typeof req.body?.note === "string" ? req.body.note.slice(0, 1000) : undefined);
      } catch (e) {
        if (/no report/.test(String((e as Error).message))) fail(404, "not_found");
        throw e;
      }
      return { ok: true };
    });

  app.get("/v1/admin/audit", async (req) => {
    await operator(req);
    return { entries: await auditLog(s.db) };
  });
}
