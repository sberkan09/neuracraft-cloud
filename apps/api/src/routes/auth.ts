import type { FastifyInstance } from "fastify";
import type { Services } from "../app.js";
import { checkPassword, createSession, endSession, hashPassword, requireUser, SESSION_COOKIE } from "../auth.js";
import { tx } from "../db.js";
import { fail } from "../errors.js";
import { balance, entry } from "../ledger.js";

export const LOCALES = ["en", "tr"] as const;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;

export async function authRoutes(app: FastifyInstance, s: Services) {
  const setCookie = (reply: import("fastify").FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: s.config.secureCookies,
      maxAge: s.config.sessionDays * 86400,
    });

  app.post<{ Body: { email?: string; password?: string; locale?: string } }>("/v1/auth/signup", async (req, reply) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");
    const locale = LOCALES.includes(req.body?.locale as never) ? (req.body!.locale as string) : "en";
    if (!EMAIL.test(email)) fail(400, "auth.invalid_email");
    if (password.length < 10 || password.length > 200) fail(400, "auth.weak_password", { min: 10 });
    const hash = await hashPassword(password);
    const user = await tx(s.db, async (c) => {
      const r = await c.query<{ id: string }>("INSERT INTO users (email, password_hash, locale) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING id", [
        email,
        hash,
        locale,
      ]);
      if (!r.rows[0]) fail(409, "auth.email_taken");
      if (s.config.signupCredits) await entry(c, r.rows[0]!.id, "grant", s.config.signupCredits, undefined, "signup");
      return r.rows[0]!;
    });
    setCookie(reply, await createSession(s.db, user.id, s.config.sessionDays));
    return reply.status(201).send({ user: { id: user.id, email, locale, plan: "free" } });
  });

  app.post<{ Body: { email?: string; password?: string } }>("/v1/auth/login", async (req, reply) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const r = await s.db.query<{ id: string; password_hash: string | null; locale: string; plan: string }>(
      "SELECT id, password_hash, locale, plan FROM users WHERE email = $1",
      [email],
    );
    const u = r.rows[0];
    // (the hash is computed even for unknown emails, so timing does not reveal which exist)
    const ok = await checkPassword(String(req.body?.password ?? ""), u?.password_hash ?? "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    if (!u || !ok) fail(401, "auth.invalid_credentials");
    setCookie(reply, await createSession(s.db, u!.id, s.config.sessionDays));
    return { user: { id: u!.id, email, locale: u!.locale, plan: u!.plan } };
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await endSession(s.db, token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/v1/me", async (req) => {
    const u = await requireUser(s.db, req);
    return { user: u, credits: await balance(s.db, u.id) };
  });

  app.patch<{ Body: { locale?: string } }>("/v1/me", async (req) => {
    const u = await requireUser(s.db, req);
    const locale = req.body?.locale;
    if (!LOCALES.includes(locale as never)) fail(400, "request.invalid");
    await s.db.query("UPDATE users SET locale = $2 WHERE id = $1", [u.id, locale]);
    return { user: { ...u, locale } };
  });
}
