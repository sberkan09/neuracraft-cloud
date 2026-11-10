// End-user sign-in for partner apps (issue #48, phase 1). JSON bodies, no Authorization header, a
// public client_id on every call:
//   POST /v1/auth/email/start   {client_id, email, locale?}      → 202 {expiresIn, resendAfter}
//   POST /v1/auth/email/verify  {client_id, email, code}         → 200 tokens
//   POST /v1/auth/token         {client_id, grantType: "refresh_token", refreshToken} → 200 tokens
//   POST /v1/auth/revoke        {client_id, refreshToken}        → 204
// With the access token, every endpoint the app uses works as with an app token and X-End-User;
// GET /v1/me and DELETE /v1/me are the end user's own (routes/auth.ts).
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Services } from "../app.js";
import { hitPerHour, liveClient, refreshTokens, revokeRefreshToken, startEmailSignIn, verifyEmailSignIn } from "../endusers.js";
import { fail } from "../errors.js";
import { mailerFrom, type Mailer } from "../mailer.js";
import { EMAIL } from "./auth.js";

type Body = { client_id?: unknown; email?: unknown; locale?: unknown; code?: unknown; grantType?: unknown; refreshToken?: unknown };

export async function endUserAuthRoutes(app: FastifyInstance, s: Services) {
  const mailer = (): Mailer => {
    if (s.mailer === undefined) s.mailer = mailerFrom(s.config);
    return s.mailer ?? fail(503, "auth.sign_in_unavailable");
  };
  const address = (b: Body): string => {
    const e = typeof b.email === "string" ? b.email.trim() : "";
    if (!EMAIL.test(e) || e.length > 254) fail(400, "auth.invalid_email");
    return e;
  };
  const perIp = (req: FastifyRequest, what: string, limit: number) => {
    const wait = hitPerHour(`${what}:${req.ip}`, limit);
    if (wait) fail(429, "auth.code_rate_limited", { retryAfter: wait });
  };

  app.post<{ Body: Body }>("/v1/auth/email/start", async (req, reply) => {
    const b = req.body ?? {};
    const client = await liveClient(s.db, b.client_id);
    const email = address(b);
    const m = mailer();
    perIp(req, "start", s.config.endUserAuth.startsPerIpPerHour);
    const locale = typeof b.locale === "string" && b.locale.toLowerCase().startsWith("tr") ? "tr" : "en";
    try {
      const r = await startEmailSignIn(s.db, s.config, (code) => m.sendSignInCode({ to: email, code, appName: client.name, locale, minutes: s.config.endUserAuth.codeMinutes }), client, email);
      return reply.status(202).send(r);
    } catch (e) {
      if ((e as { status?: number }).status) throw e;  // our own refusals (rate limits)
      req.log.error({ err: (e as Error).message }, "sign-in code email failed");
      return fail(503, "auth.sign_in_unavailable");
    }
  });

  app.post<{ Body: Body }>("/v1/auth/email/verify", async (req) => {
    const b = req.body ?? {};
    const client = await liveClient(s.db, b.client_id);
    const email = address(b);
    perIp(req, "verify", s.config.endUserAuth.verifiesPerIpPerHour);
    return verifyEmailSignIn(s.db, s.config, client, email, b.code);
  });

  app.post<{ Body: Body }>("/v1/auth/token", async (req) => {
    const b = req.body ?? {};
    const client = await liveClient(s.db, b.client_id);
    if (b.grantType !== "refresh_token") fail(400, "request.invalid", { field: "grantType" });
    return refreshTokens(s.db, s.config, client, b.refreshToken);
  });

  app.post<{ Body: Body }>("/v1/auth/revoke", async (req, reply) => {
    const b = req.body ?? {};
    const client = await liveClient(s.db, b.client_id);
    await revokeRefreshToken(s.db, client, b.refreshToken);
    return reply.status(204).send();
  });
}
