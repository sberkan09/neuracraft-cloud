// Signed-in end users of partner apps (issue #48, phase 1): emailed codes, short-lived access tokens
// (nc_eu_...) and rotating refresh tokens (nc_rt_...), bound to (partner, end user, client).
//
// The app ships only a public client id (nc_client_...). The end user's id (eu_...) goes in the same
// end_user column app tokens with X-End-User fill, so quotas, allowances, ownership and deletion work
// unchanged. No plaintext address is stored: an identity is HMAC(SIGNING_KEY, normalized address), so
// rotating SIGNING_KEY starts every end user afresh.
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { tx } from "./db.js";
import { fail } from "./errors.js";

type Q = Db | pg.PoolClient;

export const CLIENT_ID = /^nc_client_[A-Za-z0-9_-]{16,64}$/;
export const ACCESS_TOKEN = /^nc_eu_[A-Za-z0-9_-]{32}$/;
const REFRESH_TOKEN = /^nc_rt_[A-Za-z0-9_-]{43}$/;
const CODE = /^[0-9]{6}$/;

const sha256 = (s: string) => createHash("sha256").update(s).digest();

// The address an identity is keyed by: lower-cased, without a "+tag", and without dots for Gmail
// (where those reach the same inbox), so one inbox is one identity. The code goes to the address as
// typed.
export function normalizeEmail(email: string): string {
  const [local = "", domain = ""] = email.trim().toLowerCase().split(/@(?=[^@]*$)/);
  let l = local.split("+")[0]!;
  const d = domain === "googlemail.com" ? "gmail.com" : domain;
  if (d === "gmail.com") l = l.replace(/\./g, "");
  return `${l}@${d}`;
}

export const identityKey = (key: Buffer, email: string) => createHmac("sha256", key).update(`identity/v1:${normalizeEmail(email)}`).digest();
const codeHash = (key: Buffer, identity: Buffer, code: string) => createHmac("sha256", key).update(`code/v1:${identity.toString("hex")}:${code}`).digest();

export interface PartnerClient {
  id: string;
  userId: string;
  name: string;
  scopes: string[];
}

export async function createClient(q: Q, userId: string, name: string): Promise<PartnerClient> {
  const id = `nc_client_${randomBytes(18).toString("base64url")}`;
  const r = await q.query<{ scopes: string[] }>("INSERT INTO partner_clients (id, user_id, name) VALUES ($1, $2, $3) RETURNING scopes", [id, userId, name]);
  return { id, userId, name, scopes: r.rows[0]!.scopes };
}

export async function liveClient(q: Q, id: unknown): Promise<PartnerClient> {
  if (typeof id !== "string" || !CLIENT_ID.test(id)) fail(400, "auth.client_invalid");
  const r = await q.query<{ id: string; user_id: string; name: string; scopes: string[] }>(
    "SELECT id, user_id, name, scopes FROM partner_clients WHERE id = $1 AND enabled",
    [id],
  );
  const c = r.rows[0] ?? fail(400, "auth.client_invalid");
  return { id: c.id, userId: c.user_id, name: c.name, scopes: c.scopes };
}

// ---- Per-IP limits (in memory, per API process; one process in production) ----

const windows = new Map<string, number[]>();
// Counts a hit against `limit` per hour; returns the seconds to wait, or 0 when allowed.
export function hitPerHour(key: string, limit: number, now = Date.now()): number {
  const hits = (windows.get(key) ?? []).filter((t) => t > now - 3600_000);
  if (hits.length >= limit) {
    windows.set(key, hits);
    return Math.max(1, Math.ceil((hits[0]! + 3600_000 - now) / 1000));
  }
  hits.push(now);
  windows.set(key, hits);
  if (windows.size > 100_000) windows.clear();  // bounded memory
  return 0;
}

// ---- Codes ----

// POST /v1/auth/email/start. Nothing tells the caller whether the identity exists (or is blocked:
// no code is sent then).
export async function startEmailSignIn(
  db: Db,
  config: Config,
  send: (code: string) => Promise<void>,
  client: PartnerClient,
  email: string,
): Promise<{ expiresIn: number; resendAfter: number }> {
  const a = config.endUserAuth;
  const key = identityKey(config.signingKey, email);
  const recent = await db.query<{ last: Date | null; n: string; oldest: Date | null }>(
    `SELECT max(created_at) AS last, count(*) AS n, min(created_at) AS oldest
       FROM sign_in_codes WHERE identity_key = $1 AND created_at > now() - interval '1 hour'`,
    [key],
  );
  const { last, n, oldest } = recent.rows[0]!;
  const now = Date.now();
  if (last && now - last.getTime() < a.codeEverySeconds * 1000)
    fail(429, "auth.code_rate_limited", { retryAfter: Math.ceil((last.getTime() + a.codeEverySeconds * 1000 - now) / 1000) });
  if (Number(n) >= a.codesPerHour && oldest) fail(429, "auth.code_rate_limited", { retryAfter: Math.max(1, Math.ceil((oldest.getTime() + 3600_000 - now) / 1000)) });

  const blocked = await db.query("SELECT 1 FROM partner_end_users WHERE user_id = $1 AND identity_key = $2 AND blocked_at IS NOT NULL", [client.userId, key]);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const row = await db.query<{ id: string }>(
    `INSERT INTO sign_in_codes (client_id, identity_key, code_hash, expires_at, used_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4), CASE WHEN $5 THEN now() END) RETURNING id`,
    [client.id, key, codeHash(config.signingKey, key, code), a.codeMinutes, blocked.rows.length > 0],
  );
  if (!blocked.rows.length) {
    try {
      await send(code);
    } catch (e) {
      await db.query("DELETE FROM sign_in_codes WHERE id = $1", [row.rows[0]!.id]);  // does not count against the address
      throw e;
    }
  }
  return { expiresIn: a.codeMinutes * 60, resendAfter: a.codeEverySeconds };
}

export interface TokenResponse {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  refreshToken: string;
  endUser: { id: string };
}

async function issueTokens(c: pg.PoolClient, config: Config, client: PartnerClient, endUser: string, family: string): Promise<TokenResponse> {
  const access = `nc_eu_${randomBytes(24).toString("base64url")}`;
  const refresh = `nc_rt_${randomBytes(32).toString("base64url")}`;
  const a = config.endUserAuth;
  await c.query(
    `INSERT INTO end_user_tokens (user_id, end_user, client_id, kind, family, secret_hash, expires_at) VALUES
       ($1, $2, $3, 'access', $4, $5, now() + make_interval(mins => $7)),
       ($1, $2, $3, 'refresh', $4, $6, now() + make_interval(days => $8))`,
    [client.userId, endUser, client.id, family, sha256(access), sha256(refresh), a.accessMinutes, a.refreshDays],
  );
  return { accessToken: access, tokenType: "Bearer", expiresIn: a.accessMinutes * 60, refreshToken: refresh, endUser: { id: endUser } };
}

// POST /v1/auth/email/verify. The identity is made on the first success.
export async function verifyEmailSignIn(db: Db, config: Config, client: PartnerClient, email: string, code: unknown): Promise<TokenResponse> {
  if (typeof code !== "string" || !CODE.test(code.trim())) fail(400, "auth.code_invalid", { attemptsLeft: -1 });
  const key = identityKey(config.signingKey, email);
  const max = config.endUserAuth.codeAttempts;
  type Out = { ok: TokenResponse } | { expired: true } | { wrong: number } | { blocked: true };
  const out = await tx<Out>(db, async (c) => {
    const r = await c.query<{ id: string; code_hash: Buffer; attempts: number; live: boolean }>(
      `SELECT id, code_hash, attempts, (expires_at > now() AND used_at IS NULL) AS live FROM sign_in_codes
        WHERE client_id = $1 AND identity_key = $2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [client.id, key],
    );
    const row = r.rows[0];
    if (!row || !row.live || row.attempts >= max) return { expired: true };
    if (!timingSafeEqual(row.code_hash, codeHash(config.signingKey, key, (code as string).trim()))) {
      await c.query("UPDATE sign_in_codes SET attempts = attempts + 1 WHERE id = $1", [row.id]);
      return { wrong: max - row.attempts - 1 };
    }
    await c.query("UPDATE sign_in_codes SET used_at = now() WHERE id = $1", [row.id]);
    const eu = await c.query<{ end_user: string; blocked: boolean }>(
      `INSERT INTO partner_end_users (user_id, end_user, identity_key) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, identity_key) DO UPDATE SET last_seen_at = now()
       RETURNING end_user, blocked_at IS NOT NULL AS blocked`,
      [client.userId, `eu_${randomBytes(12).toString("base64url")}`, key],
    );
    if (eu.rows[0]!.blocked) return { blocked: true };
    return { ok: await issueTokens(c, config, client, eu.rows[0]!.end_user, randomUUID()) };
  });
  if ("ok" in out) return out.ok;
  if ("blocked" in out) fail(403, "auth.end_user_blocked");
  if ("wrong" in out && out.wrong > 0) fail(400, "auth.code_invalid", { attemptsLeft: out.wrong });
  return fail(400, "auth.code_expired");  // no live code, or the last attempt failed
}

// POST /v1/auth/token (grantType refresh_token). Rotates the refresh token; a rotated one presented
// again means it leaked: the whole family (the access tokens too) is revoked.
export async function refreshTokens(db: Db, config: Config, client: PartnerClient, token: unknown): Promise<TokenResponse> {
  if (typeof token !== "string" || !REFRESH_TOKEN.test(token)) fail(401, "auth.refresh_invalid");
  type Out = { ok: TokenResponse } | { invalid: true } | { blocked: true };
  const out = await tx<Out>(db, async (c) => {
    const r = await c.query<{ id: string; end_user: string; client_id: string; family: string; live: boolean; used: boolean; blocked: boolean }>(
      `SELECT t.id, t.end_user, t.client_id, t.family, (t.expires_at > now() AND t.revoked_at IS NULL) AS live, t.used_at IS NOT NULL AS used,
              eu.blocked_at IS NOT NULL AS blocked
         FROM end_user_tokens t JOIN partner_end_users eu ON eu.user_id = t.user_id AND eu.end_user = t.end_user
        WHERE t.secret_hash = $1 AND t.kind = 'refresh' FOR UPDATE OF t`,
      [sha256(token as string)],
    );
    const t = r.rows[0];
    if (!t || t.client_id !== client.id || !t.live) return { invalid: true };
    if (t.used) {
      await c.query("UPDATE end_user_tokens SET revoked_at = now() WHERE family = $1 AND revoked_at IS NULL", [t.family]);
      return { invalid: true };
    }
    if (t.blocked) return { blocked: true };
    await c.query("UPDATE end_user_tokens SET used_at = now() WHERE id = $1", [t.id]);
    await c.query("UPDATE partner_end_users SET last_seen_at = now() WHERE user_id = $1 AND end_user = $2", [client.userId, t.end_user]);
    return { ok: await issueTokens(c, config, client, t.end_user, t.family) };
  });
  if ("ok" in out) return out.ok;
  if ("blocked" in out) fail(403, "auth.end_user_blocked");
  return fail(401, "auth.refresh_invalid");
}

// POST /v1/auth/revoke: signing out ends the refresh token's family. Unknown tokens are fine.
export async function revokeRefreshToken(db: Db, client: PartnerClient, token: unknown): Promise<void> {
  if (typeof token !== "string" || !REFRESH_TOKEN.test(token)) return;
  await db.query(
    `UPDATE end_user_tokens SET revoked_at = now()
      WHERE revoked_at IS NULL AND family = (SELECT family FROM end_user_tokens WHERE secret_hash = $1 AND kind = 'refresh' AND client_id = $2)`,
    [sha256(token), client.id],
  );
}

// ---- Access tokens on requests (auth.ts) ----

export interface EndUserToken {
  id: string; // the partner account
  email: string;
  locale: string;
  plan: string;
  tokenId: string;
  clientId: string;
  endUser: string;
  scopes: string[];
}

export async function accessTokenUser(db: Db, secret: string): Promise<EndUserToken> {
  if (!ACCESS_TOKEN.test(secret)) fail(401, "auth.required");
  const r = await db.query<{
    id: string; email: string; locale: string; plan: string; token_id: string; client_id: string; end_user: string; scopes: string[];
    enabled: boolean; blocked: boolean; expired: boolean; revoked: boolean; seen_long_ago: boolean;
  }>(
    `SELECT u.id, u.email, u.locale, u.plan, t.id AS token_id, t.client_id, t.end_user, c.scopes, c.enabled,
            eu.blocked_at IS NOT NULL AS blocked, t.expires_at <= now() AS expired, t.revoked_at IS NOT NULL AS revoked,
            eu.last_seen_at < now() - interval '5 minutes' AS seen_long_ago
       FROM end_user_tokens t
       JOIN partner_clients c ON c.id = t.client_id
       JOIN partner_end_users eu ON eu.user_id = t.user_id AND eu.end_user = t.end_user
       JOIN users u ON u.id = t.user_id
      WHERE t.secret_hash = $1 AND t.kind = 'access'`,
    [sha256(secret)],
  );
  const t = r.rows[0] ?? fail(401, "auth.required");
  if (t.revoked || !t.enabled) fail(401, "auth.token_revoked");
  if (t.blocked) fail(403, "auth.end_user_blocked");
  if (t.expired) fail(401, "auth.token_expired");
  if (t.seen_long_ago) await db.query("UPDATE partner_end_users SET last_seen_at = now() WHERE user_id = $1 AND end_user = $2", [t.id, t.end_user]);
  return { id: t.id, email: t.email, locale: t.locale, plan: t.plan, tokenId: t.token_id, clientId: t.client_id, endUser: t.end_user, scopes: t.scopes };
}

// ---- Blocking (the partner's server or the operator) ----

// Returns false when the partner has no such signed-in end user.
export async function setBlocked(q: Q, userId: string, endUser: string, blocked: boolean): Promise<boolean> {
  const r = await q.query("UPDATE partner_end_users SET blocked_at = CASE WHEN $3 THEN coalesce(blocked_at, now()) END WHERE user_id = $1 AND end_user = $2", [userId, endUser, blocked]);
  if (!r.rowCount) return false;
  if (blocked) await q.query("UPDATE end_user_tokens SET revoked_at = now() WHERE user_id = $1 AND end_user = $2 AND revoked_at IS NULL", [userId, endUser]);
  return true;
}

export async function endUserIdentity(q: Q, userId: string, endUser: string): Promise<{ createdAt: Date; blocked: boolean } | null> {
  const r = await q.query<{ created_at: Date; blocked: boolean }>(
    "SELECT created_at, blocked_at IS NOT NULL AS blocked FROM partner_end_users WHERE user_id = $1 AND end_user = $2",
    [userId, endUser],
  );
  return r.rows[0] ? { createdAt: r.rows[0].created_at, blocked: r.rows[0].blocked } : null;
}
