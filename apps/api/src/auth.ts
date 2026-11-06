// Passwords (scrypt) and sessions (random cookie values; only their hashes are stored).
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyRequest } from "fastify";
import type { Db } from "./db.js";
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

export async function requireUser(db: Db, req: FastifyRequest): Promise<SessionUser> {
  return (await sessionUser(db, req)) ?? fail(401, "auth.required");
}
