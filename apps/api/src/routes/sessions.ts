// Sessions (capacity.ts): an app opens one when interactive work may come soon (GM Cebi: a game
// starts), keeps it alive with heartbeats and closes it at the end. While sessions ask for it, GPU
// workers are kept warm; the answers say whether one is ready, starting (with an estimate) or not
// available.
//   POST   /v1/sessions                 open (or the one already open for this user / end user)
//   POST   /v1/sessions/:id/heartbeat   keep it open (every heartbeatSeconds)
//   DELETE /v1/sessions/:id             close it
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import type { Services } from "../app.js";
import { requireUser, type AuthedUser } from "../auth.js";
import { capacityState } from "../capacity.js";
import { tx, type Db } from "../db.js";
import { fail } from "../errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface SessionRow {
  id: string;
  user_id: string;
  end_user: string | null;
  regions: string[];
  started_at: Date;
  last_seen_at: Date;
  last_job_at: Date | null;
  ends_at: Date;
  closed_at: Date | null;
  close_reason: string | null;
}

// The open session of this user / end user, if any (used to tie interactive jobs to it).
export async function openSession(q: Db | pg.PoolClient, userId: string, endUser: string | null, expireSeconds: number): Promise<SessionRow | null> {
  const r = await q.query<SessionRow>(
    `SELECT * FROM app_sessions WHERE user_id = $1 AND end_user IS NOT DISTINCT FROM $2 AND closed_at IS NULL
        AND ends_at > now() AND last_seen_at > now() - make_interval(secs => $3) ORDER BY started_at DESC LIMIT 1`,
    [userId, endUser, expireSeconds],
  );
  return r.rows[0] ?? null;
}

export async function sessionRoutes(app: FastifyInstance, s: Services) {
  const cfg = s.config.sessions;
  const view = async (row: SessionRow) => ({
    session: {
      id: row.id,
      startedAt: row.started_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      heartbeatSeconds: cfg.heartbeatSeconds,
      expiresWithoutHeartbeatSeconds: cfg.expireSeconds,
      idleMinutes: cfg.idleMinutes,
    },
    capacity: await capacityState(s.db, s.config.capacity, row.regions, s.config.interactiveGraceSeconds, s.capacity),
  });
  const own = async (u: AuthedUser, id: string): Promise<SessionRow> => {
    if (!UUID.test(id)) fail(404, "not_found");
    const r = await s.db.query<SessionRow>("SELECT * FROM app_sessions WHERE id = $1 AND user_id = $2 AND end_user IS NOT DISTINCT FROM $3", [id, u.id, u.endUser]);
    return r.rows[0] ?? fail(404, "not_found");
  };
  const isOpen = (row: SessionRow) =>
    !row.closed_at && row.ends_at.getTime() > Date.now() && Date.now() - row.last_seen_at.getTime() < cfg.expireSeconds * 1000;

  app.post("/v1/sessions", async (req, reply) => {
    const u = await requireUser(s.db, req, "jobs:submit");
    const { row, created } = await tx(s.db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext('session:' || $1))", [u.id]);
      const existing = await openSession(c, u.id, u.endUser, cfg.expireSeconds);
      if (existing) {
        const r = await c.query<SessionRow>("UPDATE app_sessions SET last_seen_at = now() WHERE id = $1 RETURNING *", [existing.id]);
        return { row: r.rows[0]!, created: false };
      }
      const limit = await c.query<{ max_sessions: number | null }>("SELECT max_sessions FROM partners WHERE user_id = $1", [u.id]);
      const max = limit.rows[0]?.max_sessions ?? cfg.maxPerPartner;
      const n = await c.query<{ n: string }>(
        "SELECT count(*) AS n FROM app_sessions WHERE user_id = $1 AND closed_at IS NULL AND ends_at > now() AND last_seen_at > now() - make_interval(secs => $2)",
        [u.id, cfg.expireSeconds],
      );
      if (Number(n.rows[0]!.n) >= max) fail(429, "session.limit", { max });
      const r = await c.query<SessionRow>(
        "INSERT INTO app_sessions (user_id, end_user, regions, ends_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4)) RETURNING *",
        [u.id, u.endUser, s.config.interactiveRegions, cfg.maxHours],
      );
      return { row: r.rows[0]!, created: true };
    });
    if (created) s.capacity?.kick();  // rent a GPU now rather than at the next tick
    return reply.status(created ? 201 : 200).send(await view(row));
  });

  app.post<{ Params: { id: string } }>("/v1/sessions/:id/heartbeat", async (req) => {
    const u = await requireUser(s.db, req, "jobs:submit");
    const row = await own(u, req.params.id);
    if (!isOpen(row)) fail(410, "session.closed", { reason: row.close_reason ?? (row.ends_at.getTime() <= Date.now() ? "limit" : "expired") });
    const r = await s.db.query<SessionRow>("UPDATE app_sessions SET last_seen_at = now() WHERE id = $1 RETURNING *", [row.id]);
    return view(r.rows[0]!);
  });

  app.delete<{ Params: { id: string } }>("/v1/sessions/:id", async (req) => {
    const u = await requireUser(s.db, req, "jobs:submit");
    const row = await own(u, req.params.id);
    await s.db.query("UPDATE app_sessions SET closed_at = coalesce(closed_at, now()), close_reason = coalesce(close_reason, 'closed') WHERE id = $1", [row.id]);
    return { closed: true };
  });
}
