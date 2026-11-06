// Settings from the environment (deploy/.env.example lists them).
import { randomBytes } from "node:crypto";
import path from "node:path";

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  publicUrl: string; // how browsers and workers reach this API (signed URLs point here for local storage)
  storage: { kind: "local"; dir: string } | { kind: "s3"; bucket: string; region: string; endpoint?: string };
  signingKey: Buffer; // signs local-storage URLs
  workerTokens: string[];
  sessionDays: number;
  secureCookies: boolean;
  migrationsDir: string;
  signupCredits: number; // millicredits granted to a new account
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8080);
  const storageKind = env.STORAGE ?? "local";
  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    databaseUrl: env.DATABASE_URL ?? "postgres://nc@localhost:5432/neuracraft",
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    storage:
      storageKind === "s3"
        ? { kind: "s3", bucket: env.S3_BUCKET ?? "neuracraft", region: env.S3_REGION ?? "auto", endpoint: env.S3_ENDPOINT }
        : { kind: "local", dir: path.resolve(env.STORAGE_DIR ?? ".data/storage") },
    signingKey: env.SIGNING_KEY ? Buffer.from(env.SIGNING_KEY, "hex") : randomBytes(32),
    workerTokens: (env.WORKER_TOKENS ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    sessionDays: Number(env.SESSION_DAYS ?? 30),
    secureCookies: env.SECURE_COOKIES === "1",
    migrationsDir: path.resolve(env.MIGRATIONS_DIR ?? new URL("../../../../db/migrations", import.meta.url).pathname),
    signupCredits: Number(env.SIGNUP_CREDITS ?? 50_000),
  };
}
