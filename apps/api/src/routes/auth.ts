import type { FastifyInstance } from "fastify";
import type { Services } from "../app.js";
import { checkPassword, createSession, endSession, hashPassword, requireUser, SESSION_COOKIE } from "../auth.js";
import { tx } from "../db.js";
import { endUserIdentity } from "../endusers.js";
import { fail } from "../errors.js";
import { balance, entry } from "../ledger.js";
import { deleteEndUser, endUserDay, partnerSettings } from "../partners.js";

export const LOCALES = ["en", "tr"] as const;
export const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;

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
      if (s.config.operatorEmails?.includes(email)) await c.query("UPDATE users SET operator = true WHERE id = $1", [r.rows[0]!.id]);
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
    const u = await requireUser(s.db, req, "any");
    // A partner app's end user sees themselves, not the partner's account (issue #48).
    if (u.endUser) {
      const p = await partnerSettings(s.db, u.id);
      const day = p ? await endUserDay(s.db, u.id, u.endUser, p.quotaTimezone) : null;
      const identity = await endUserIdentity(s.db, u.id, u.endUser);
      return {
        endUser: { id: u.endUser, createdAt: identity?.createdAt.toISOString() ?? null },
        quota: p && day ? { daily: p.endUserDailyJobs, used: day.used, resetsAt: day.resetsAt.toISOString() } : null,
      };
    }
    const extra = u.tokenKind ? null : (await s.db.query<{ operator: boolean; until: Date | null }>(
      "SELECT operator, CASE WHEN support_access_until > now() THEN support_access_until END AS until FROM users WHERE id = $1",
      [u.id],
    )).rows[0];
    return {
      user: u,
      credits: await balance(s.db, u.id),
      // The web app only (a cookie session): the operator console, and the account's support access.
      ...(extra ? { operator: extra.operator, supportAccessUntil: extra.until?.toISOString() ?? null } : {}),
    };
  });

  // Deletes the account and everything it owns (issue #19): rows at once, the bytes with the next
  // cleanup (retention.ts). The password confirms it (accounts without one confirm their email).
  app.delete<{ Body: { password?: string; email?: string } }>("/v1/me", async (req, reply) => {
    // A signed-in end user deletes their identity and everything stored for them, and every token
    // (the in-app account deletion the stores require; issue #48).
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer nc_eu_")) {
      const eu = await requireUser(s.db, req, "any");
      await tx(s.db, (c) => deleteEndUser(c, eu.id, eu.endUser!));
      return reply.status(204).send();
    }
    const u = await requireUser(s.db, req, "session");
    const r = await s.db.query<{ password_hash: string | null }>("SELECT password_hash FROM users WHERE id = $1", [u.id]);
    const hash = r.rows[0]?.password_hash ?? null;
    const confirmed = hash ? await checkPassword(String(req.body?.password ?? ""), hash) : String(req.body?.email ?? "").trim().toLowerCase() === u.email;
    if (!confirmed) fail(401, "auth.invalid_credentials");
    await s.db.query("DELETE FROM users WHERE id = $1", [u.id]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.patch<{ Body: { locale?: string; supportAccessDays?: unknown } }>("/v1/me", async (req) => {
    const u = await requireUser(s.db, req, "session");
    const b = req.body ?? {};
    // Support access (the operator console): the account lets NeuraCraft's operators see its jobs'
    // pictures and texts for N days (1-90), to help with problems or a beta; 0 ends it at once.
    if (b.supportAccessDays !== undefined) {
      const days = b.supportAccessDays;
      if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > 90) fail(400, "request.invalid", { field: "supportAccessDays" });
      const r = await s.db.query<{ until: Date | null }>(
        "UPDATE users SET support_access_until = CASE WHEN $2 > 0 THEN now() + make_interval(days => $2) END, support_access_note = CASE WHEN $2 > 0 THEN 'granted by the account' END WHERE id = $1 RETURNING support_access_until AS until",
        [u.id, days],
      );
      await s.db.query("INSERT INTO moderation_log (operator, action, user_id, note) VALUES ($1, 'support_access', $2, $3)", [u.email, u.id, days ? `granted ${days} days by the account` : "ended by the account"]);
      if (b.locale === undefined) return { user: u, supportAccessUntil: r.rows[0]!.until?.toISOString() ?? null };
    }
    const locale = b.locale;
    if (!LOCALES.includes(locale as never)) fail(400, "request.invalid");
    await s.db.query("UPDATE users SET locale = $2 WHERE id = $1", [u.id, locale]);
    return { user: { ...u, locale } };
  });
}
