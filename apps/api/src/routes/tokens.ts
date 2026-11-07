// Personal access tokens (issue #16): a signed-in person makes, lists and revokes them; the secret is
// shown once. Tokens cannot manage tokens.
import type { FastifyInstance } from "fastify";
import type { Services } from "../app.js";
import { createToken, requireUser, SCOPES, type Scope } from "../auth.js";
import { fail } from "../errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface TokenRow {
  id: string;
  kind: string;
  name: string;
  prefix: string;
  scopes: string[];
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}
const tokenJson = (t: TokenRow) => ({
  id: t.id,
  kind: t.kind,
  name: t.name,
  prefix: t.prefix,
  scopes: t.scopes,
  createdAt: t.created_at.toISOString(),
  lastUsedAt: t.last_used_at?.toISOString() ?? null,
  expiresAt: t.expires_at?.toISOString() ?? null,
  revokedAt: t.revoked_at?.toISOString() ?? null,
});

export async function tokenRoutes(app: FastifyInstance, s: Services) {
  app.post<{ Body: { name?: unknown; scopes?: unknown; expiresInDays?: unknown } }>("/v1/tokens", async (req, reply) => {
    const u = await requireUser(s.db, req, "session");
    const b = req.body ?? {};
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 100) : "";
    if (!name) fail(400, "request.invalid", { field: "name" });
    const scopes = Array.isArray(b.scopes) ? b.scopes : [];
    if (!scopes.length || !scopes.every((x) => SCOPES.includes(x as Scope))) fail(400, "request.invalid", { field: "scopes" });
    let expires: Date | null = null;
    if (b.expiresInDays !== undefined && b.expiresInDays !== null) {
      const d = Number(b.expiresInDays);
      if (!Number.isInteger(d) || d < 1 || d > 3650) fail(400, "request.invalid", { field: "expiresInDays" });
      expires = new Date(Date.now() + d * 86400000);
    }
    const live = await s.db.query<{ n: string }>("SELECT count(*) AS n FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL", [u.id]);
    if (Number(live.rows[0]!.n) >= 50) fail(429, "rate_limited");
    const t = await createToken(s.db, u.id, "pat", name, [...new Set(scopes as Scope[])], expires);
    const row = await s.db.query<TokenRow>("SELECT * FROM api_tokens WHERE id = $1", [t.id]);
    return reply.status(201).send({ token: tokenJson(row.rows[0]!), secret: t.secret });
  });

  app.get("/v1/tokens", async (req) => {
    const u = await requireUser(s.db, req, "session");
    const r = await s.db.query<TokenRow>("SELECT * FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100", [u.id]);
    return { tokens: r.rows.map(tokenJson) };
  });

  app.delete<{ Params: { id: string } }>("/v1/tokens/:id", async (req) => {
    const u = await requireUser(s.db, req, "session");
    if (!UUID.test(req.params.id)) fail(404, "not_found");
    const r = await s.db.query("UPDATE api_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1 AND user_id = $2", [req.params.id, u.id]);
    if (!r.rowCount) fail(404, "not_found");
    return { ok: true };
  });
}
