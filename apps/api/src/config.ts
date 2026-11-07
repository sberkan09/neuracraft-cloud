// Settings from the environment (deploy/.env.example lists them).
import { randomBytes } from "node:crypto";
import path from "node:path";

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  publicUrl: string; // prefix of local-storage signed URLs; "" (the default) makes them relative to the API's origin
  storage: { kind: "local"; dir: string } | { kind: "s3"; bucket: string; region: string; endpoint?: string };
  signingKey: Buffer; // signs local-storage URLs
  workerTokens: string[];
  sessionDays: number;
  secureCookies: boolean;
  migrationsDir: string;
  signupCredits: number; // millicredits granted to a new account
  anthropicApiKey: string; // the prompt step's LLM (issue #17); "" = the template only
  promptModel: string;
  promptTimeoutMs: number;
  moderationThresholds: string; // labels of the output classifier that hold a result: "nsfw=0.5"
  interactiveRegions: string[]; // interactive presets run only on workers in these regions; [] = anywhere
  retentionEvery: number; // seconds between cleanups (retention.ts); 0 = never
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8080);
  const storageKind = env.STORAGE ?? "local";
  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    databaseUrl: env.DATABASE_URL ?? "postgres://nc@localhost:5432/neuracraft",
    publicUrl: (env.STORAGE_URL_PREFIX ?? "").replace(/\/$/, ""),
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
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    promptModel: env.PROMPT_MODEL ?? "claude-haiku-5-5",
    promptTimeoutMs: Number(env.PROMPT_TIMEOUT_MS ?? 3000),
    moderationThresholds: env.MODERATION_THRESHOLDS ?? "nsfw=0.5",
    interactiveRegions: (env.INTERACTIVE_REGIONS ?? "").split(",").map((r) => r.trim()).filter(Boolean),
    retentionEvery: Number(env.RETENTION_EVERY_SECONDS ?? 600),
  };
}
