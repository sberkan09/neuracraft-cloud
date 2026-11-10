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
  adminTokens: string[]; // operator endpoints (routes/admin.ts)
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
  interactiveGraceSeconds: number; // interactive jobs are refused when no GPU worker was seen for this long
  ssePingSeconds: number; // a job's event stream pings (and looks at the job) this often
  interactiveOnCpu: boolean; // development and tests only: interactive jobs may run on CPU workers (and need no GPU)
  sessions: {
    heartbeatSeconds: number; // how often apps should send a heartbeat
    expireSeconds: number; // a session without a heartbeat for this long is closed
    maxHours: number; // the longest a session stays open
    idleMinutes: number; // a session without an interactive job for this long no longer asks for capacity
    maxPerPartner: number; // open sessions per account (partners: partners.max_sessions overrides)
  };
  capacity: CapacityConfig;
  mail: {
    provider: "" | "brevo" | "log"; // "": no email, so no end-user sign-in (issue #48)
    brevoApiKey: string;
    from: string; // "NeuraCraft <no-reply@neuracraft.app>"
  };
  endUserAuth: {
    accessMinutes: number; // nc_eu_ access tokens
    refreshDays: number; // nc_rt_ refresh tokens (sliding: every refresh starts the period again)
    codeMinutes: number; // emailed codes
    codeAttempts: number;
    codeEverySeconds: number; // one code per address this often
    codesPerHour: number; // per address
    startsPerIpPerHour: number; // codes asked for from one IP
    verifiesPerIpPerHour: number;
  };
}

// On-demand GPU workers (capacity.ts). provider "" = none: workers are started by hand, as before.
export interface CapacityConfig {
  provider: "" | "runpod";
  everySeconds: number; // how often the manager looks
  sessionsPerWorker: number; // open sessions one warm worker serves
  maxPods: number;
  graceMinutes: number; // pods stay this long after the last session stopped asking
  startTimeoutSeconds: number; // a pod whose worker has not registered by then is given up
  expectedStartSeconds: number; // what apps are told to expect while a pod with the model cache starts
  expectedStartSecondsNoCache: number; // ... and one without it (a fallback data centre: the worker downloads the models)
  maxPodHours: number; // a pod is replaced after this long
  dailyBudgetUsd: number; // no GPU pods once today's pods cost this much (UTC days)
  monthlyBudgetUsd: number; // the same for the month (Infinity: no limit)
  runpod: {
    apiKey: string;
    url: string;
    image: string;
    registryAuthId: string;
    gpuTypes: string[]; // tried in order
    cloud: "SECURE" | "COMMUNITY";
    dataCenters: string[];
    fallbackDataCenters: string[]; // tried without the network volume when dataCenters have no free GPU
    networkVolumeId: string; // the models cache, shared by the pods (mounted at /runpod-volume)
    workerApiUrl: string; // how the pods reach this API
    workerToken: string;
    workerEnv: Record<string, string>; // anything else for the worker (KEEP_MODELS=8, WARMUP=1, WORKER_REGION=eu, ...)
  };
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
    adminTokens: (env.ADMIN_TOKENS ?? "").split(",").map((t) => t.trim()).filter((t) => t.length >= 16),
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
    interactiveGraceSeconds: Number(env.INTERACTIVE_GRACE_SECONDS ?? 60),
    ssePingSeconds: Number(env.SSE_PING_SECONDS ?? 15),
    interactiveOnCpu: env.INTERACTIVE_ON_CPU === "1",
    sessions: {
      heartbeatSeconds: Number(env.SESSION_HEARTBEAT_SECONDS ?? 120),
      expireSeconds: Number(env.SESSION_EXPIRE_SECONDS ?? 600),
      maxHours: Number(env.SESSION_MAX_HOURS ?? 8),
      idleMinutes: Number(env.SESSION_IDLE_MINUTES ?? 45),
      maxPerPartner: Number(env.SESSION_MAX_PER_ACCOUNT ?? 50),
    },
    capacity: {
      provider: env.CAPACITY_PROVIDER === "runpod" ? "runpod" : "",
      everySeconds: Number(env.CAPACITY_EVERY_SECONDS ?? 15),
      sessionsPerWorker: Number(env.CAPACITY_SESSIONS_PER_WORKER ?? 20),
      maxPods: Number(env.CAPACITY_MAX_PODS ?? 3),
      graceMinutes: Number(env.CAPACITY_GRACE_MINUTES ?? 15),
      startTimeoutSeconds: Number(env.CAPACITY_START_TIMEOUT_SECONDS ?? 600),
      expectedStartSeconds: Number(env.CAPACITY_EXPECTED_START_SECONDS ?? 75),
      expectedStartSecondsNoCache: Number(env.CAPACITY_EXPECTED_START_SECONDS_NO_CACHE ?? 120),
      maxPodHours: Number(env.CAPACITY_MAX_POD_HOURS ?? 12),
      dailyBudgetUsd: Number(env.CAPACITY_DAILY_BUDGET_USD ?? 10),
      monthlyBudgetUsd: env.CAPACITY_MONTHLY_BUDGET_USD ? Number(env.CAPACITY_MONTHLY_BUDGET_USD) : Infinity,
      runpod: {
        apiKey: env.RUNPOD_API_KEY ?? "",
        url: env.RUNPOD_API_URL || "https://api.runpod.io",
        image: env.RUNPOD_IMAGE ?? "",
        registryAuthId: env.RUNPOD_REGISTRY_AUTH_ID ?? "",
        gpuTypes: (env.RUNPOD_GPU_TYPES || "NVIDIA RTX A5000,NVIDIA RTX A4000,NVIDIA GeForce RTX 4090").split(",").map((x) => x.trim()).filter(Boolean),
        cloud: env.RUNPOD_CLOUD === "COMMUNITY" ? "COMMUNITY" : "SECURE",
        dataCenters: (env.RUNPOD_DATA_CENTERS ?? "").split(",").map((x) => x.trim()).filter(Boolean),
        fallbackDataCenters: (env.RUNPOD_FALLBACK_DATA_CENTERS ?? "").split(",").map((x) => x.trim()).filter(Boolean),
        networkVolumeId: env.RUNPOD_NETWORK_VOLUME_ID ?? "",
        workerApiUrl: env.RUNPOD_WORKER_API_URL || env.STORAGE_URL_PREFIX || "",
        workerToken: env.RUNPOD_WORKER_TOKEN ?? (env.WORKER_TOKENS ?? "").split(",")[0] ?? "",
        workerEnv: Object.fromEntries(
          (env.RUNPOD_WORKER_ENV || "KEEP_MODELS=8,INTERACTIVE_ONLY=1,WARMUP=1")
            .split(",")
            .map((kv) => kv.split("=").map((x) => x.trim()))
            .filter((kv) => kv.length === 2 && kv[0]),
        ),
      },
    },
    mail: {
      provider: env.MAIL_PROVIDER === "brevo" ? "brevo" : env.MAIL_PROVIDER === "log" ? "log" : "",
      brevoApiKey: env.BREVO_API_KEY ?? "",
      from: env.MAIL_FROM ?? "",
    },
    endUserAuth: {
      accessMinutes: Number(env.END_USER_ACCESS_MINUTES ?? 60),
      refreshDays: Number(env.END_USER_REFRESH_DAYS ?? 90),
      codeMinutes: Number(env.SIGN_IN_CODE_MINUTES ?? 10),
      codeAttempts: Number(env.SIGN_IN_CODE_ATTEMPTS ?? 5),
      codeEverySeconds: Number(env.SIGN_IN_CODE_EVERY_SECONDS ?? 60),
      codesPerHour: Number(env.SIGN_IN_CODES_PER_HOUR ?? 5),
      startsPerIpPerHour: Number(env.SIGN_IN_STARTS_PER_IP_PER_HOUR ?? 20),
      verifiesPerIpPerHour: Number(env.SIGN_IN_VERIFIES_PER_IP_PER_HOUR ?? 60),
    },
  };
}
