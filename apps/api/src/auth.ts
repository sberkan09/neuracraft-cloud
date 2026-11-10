// Passwords (scrypt) and sessions (random cookie values; only their hashes are stored).
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyRequest } from "fastify";
import type { Db } from "./db.js";
import { accessTokenUser, ACCESS_TOKEN } from "./endusers.js";
import { fail } from "./errors.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const N = 1 << 15, R = 8, P = 1;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, { N, r: R, p: P, maxmem: 64 << 20 });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function checkPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [kind, n, r, p, salt, key] = stored.split("$");
  if (kind !== "scrypt" || !salt || !key) return false;
  const want = Buffer.from(key, "base64");
  const got = await scrypt(password, Buffer.from(salt, "base64"), want.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 << 20 });
  return timingSafeEqual(got, want);
}

export const SESSION_COOKIE = "nc_session";
const hashToken = (t: string) => createHash("sha256").update(t).digest();

export async function createSession(db: Db, userId: string, days: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.query("INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))", [hashToken(token), userId, days]);
  return token;
}

export async function endSession(db: Db, token: string): Promise<void> {
  await db.query("DELETE FROM sessions WHERE id_hash = $1", [hashToken(token)]);
}

export interface SessionUser {
  id: string;
  email: string;
  locale: string;
  plan: string;
}

export async function sessionUser(db: Db, req: FastifyRequest): Promise<SessionUser | null> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const r = await db.query<SessionUser>(
    "SELECT u.id, u.email, u.locale, u.plan FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = $1 AND s.expires_at > now()",
    [hashToken(token)],
  );
  return r.rows[0] ?? null;
}

// ---- Bearer tokens (issue #16) ----

// What a token may do. Nothing that changes the account, billing or tokens is ever a scope: those need
// a session.
export const SCOPES = ["jobs:submit", "jobs:read", "assets:write", "assets:read"] as const;
export type Scope = (typeof SCOPES)[number];
// Partner apps (issue #21): an app token for the partner's own server, never shipped in an app. It
// manages end users (allowance grants, data deletion, usage) and needs no X-End-User header.
export const PARTNER_SCOPE = "partner:manage";
export const APP_SCOPES = [...SCOPES, PARTNER_SCOPE] as const;
export type AppScope = (typeof APP_SCOPES)[number];
// "session": only a signed-in person (cookie), never a token; "any": a session or any valid token.
export type Access = AppScope | "session" | "any";

export interface AuthedUser extends SessionUser {
  tokenId?: string; // set when the request carried a bearer token
  tokenKind?: "pat" | "app" | "eu"; // eu: a signed-in end user of a partner app (issue #48)
  clientId?: string; // the partner client of an eu token
  scopes?: string[];
  // The partner app's end user the request acts for (X-End-User, required on app tokens without
  // partner:manage); null for people and personal tokens. Ownership is (account, end user).
  endUser: string | null;
}

export const END_USER = /^[A-Za-z0-9._:@-]{1,64}$/;

const TOKEN = /^nc_(pat|app)_[A-Za-z0-9_-]{32}$/;

export async function createToken(
  db: Db,
  userId: string,
  kind: "pat" | "app",
  name: string,
  scopes: AppScope[],
  expiresAt: Date | null,
): Promise<{ id: string; secret: string; prefix: string }> {
  const secret = `nc_${kind}_${randomBytes(24).toString("base64url")}`;
  const prefix = secret.slice(0, 12);
  const r = await db.query<{ id: string }>(
    "INSERT INTO api_tokens (user_id, kind, name, prefix, secret_hash, scopes, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    [userId, kind, name, prefix, hashToken(secret), scopes, expiresAt],
  );
  return { id: r.rows[0]!.id, secret, prefix };
}

// Requests per minute a token may make (per API process; an app token: per end user).
export const TOKEN_RATE_PER_MINUTE = 240;
const buckets = new Map<string, { tokens: number; at: number }>();
function takeToken(id: string): boolean {
  const now = Date.now();
  const b = buckets.get(id) ?? { tokens: TOKEN_RATE_PER_MINUTE, at: now };
  b.tokens = Math.min(TOKEN_RATE_PER_MINUTE, b.tokens + ((now - b.at) / 60000) * TOKEN_RATE_PER_MINUTE);
  b.at = now;
  if (b.tokens < 1) {
    buckets.set(id, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(id, b);
  if (buckets.size > 100000) buckets.clear();  // bounded memory
  return true;
}

// A signed-in end user's access token: acts like an app token with X-End-User set to that end user
// (the header is ignored), with the partner client's scopes.
async function endUserTokenUser(db: Db, secret: string, access: Access): Promise<AuthedUser> {
  const t = await accessTokenUser(db, secret);
  if (access === "session" || access === PARTNER_SCOPE) fail(403, "forbidden");
  if (access !== "any" && !t.scopes.includes(access)) fail(403, "auth.scope_missing", { scope: access });
  if (!takeToken(`${t.clientId}:${t.endUser}`)) fail(429, "rate_limited");
  return { id: t.id, email: t.email, locale: t.locale, plan: t.plan, tokenId: t.tokenId, tokenKind: "eu", clientId: t.clientId, scopes: t.scopes, endUser: t.endUser };
}

async function tokenUser(db: Db, req: FastifyRequest, secret: string, access: Access): Promise<AuthedUser> {
  if (ACCESS_TOKEN.test(secret)) return endUserTokenUser(db, secret, access);
  if (!TOKEN.test(secret)) fail(401, "auth.required");
  const r = await db.query<SessionUser & { token_id: string; kind: "pat" | "app"; scopes: string[]; expired: boolean; revoked: boolean; eu_only: boolean }>(
    `SELECT u.id, u.email, u.locale, u.plan, t.id AS token_id, t.kind, t.scopes,
            (t.expires_at IS NOT NULL AND t.expires_at <= now()) AS expired, t.revoked_at IS NOT NULL AS revoked,
            coalesce(p.require_end_user_tokens, false) AS eu_only
       FROM api_tokens t JOIN users u ON u.id = t.user_id LEFT JOIN partners p ON p.user_id = t.user_id WHERE t.secret_hash = $1`,
    [hashToken(secret)],
  );
  const t = r.rows[0] ?? fail(401, "auth.required");
  if (t.revoked) fail(401, "auth.token_revoked");
  if (t.expired) fail(401, "auth.token_expired");
  if (access === "session") fail(403, "forbidden");
  if (access !== "any" && !t.scopes.includes(access)) fail(403, "auth.scope_missing", { scope: access });
  // App tokens act for one end user at a time; the partner's server token (partner:manage) names
  // end users in the path instead.
  const header = req.headers["x-end-user"];
  let endUser: string | null = null;
  if (t.kind === "app" && !t.scopes.includes(PARTNER_SCOPE)) {
    // Once the partner's app signs its end users in (issue #48), the shipped app token stops working.
    if (t.eu_only) fail(401, "auth.end_user_token_required");
    if (typeof header !== "string" || !header) fail(400, "partner.end_user_required");
    if (!END_USER.test(header as string)) fail(400, "partner.end_user_required", { reason: "1-64 of A-Z a-z 0-9 . _ : @ -" });
    endUser = header as string;
  }
  // An app token is shared by every install of the app: each end user gets the rate on their own.
  if (!takeToken(endUser ? `${t.token_id}:${endUser}` : t.token_id)) fail(429, "rate_limited");
  await db.query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [t.token_id]);
  return { id: t.id, email: t.email, locale: t.locale, plan: t.plan, tokenId: t.token_id, tokenKind: t.kind, scopes: t.scopes, endUser };
}

// The signed-in person (session cookie) or, with an `Authorization: Bearer nc_...` header, the token's
// user, if the token is live and holds `access`. Token requests carry no ambient credential, so they
// need no CSRF protection.
export async function requireUser(db: Db, req: FastifyRequest, access: Access = "any"): Promise<AuthedUser> {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) return tokenUser(db, req, header.slice(7).trim(), access);
  const u = (await sessionUser(db, req)) ?? fail(401, "auth.required");
  return { ...u, endUser: null };
}
