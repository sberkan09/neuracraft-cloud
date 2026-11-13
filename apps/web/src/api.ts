// The API, from the browser (same origin; the session is a cookie).
import type { Job, JobEvent } from "@neuracraft/shared";

export class ApiError extends Error {
  constructor(readonly code: string, readonly params: Record<string, string | number> = {}) {
    super(code);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("network");
  }
  const data = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) throw new ApiError(data?.error?.code ?? "internal", data?.error?.params ?? {});
  return data as T;
}

export interface User {
  id: string;
  email: string;
  locale: string;
  plan: string;
}
export interface Asset {
  id: string;
  kind: string;
  modelKind: string | null;
  name: string;
  bytes: number;
  license: string | null;
  catalog: boolean;
}

// Inputs are pictures or 3D models (.glb).
export const isModelFile = (a: { name: string }) => /\.glb$/i.test(a.name);

export interface ApiToken {
  id: string;
  kind: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

// ---- The operator console (routes/admin.ts) ----
type Row = Record<string, unknown>;
export interface AdminOverview {
  capacity: {
    provider: string | null;
    maxPods: number;
    pods: { id: string; gpu_type: string | null; region: string | null; state: string; price_per_hour: number | null; requested_at: string; ready_at: string | null; error: string | null }[];
    spend: { todayUsd: number; monthUsd: number; dailyBudgetUsd: number; monthlyBudgetUsd: number | null };
  };
  sessions: { email: string; user_id: string; open: number; last_seen: string }[];
  jobs24h: { email: string; user_id: string; total: number; succeeded: number; failed: number; active: number }[];
  events: { at: string; kind: string; pod_id: string | null; detail: Row }[];
  openReports: number;
  seeAllContent: boolean;
}
export interface AdminAccountRow {
  id: string; email: string; plan: string; created_at: string; operator: boolean; flagged_at: string | null; support_access_until: string | null;
  credits: number; partner: boolean; signed_in_end_users: number; jobs_7d: number; last_job_at: string | null;
}
export interface AdminAccount {
  account: AdminAccountRow & { locale: string; flag_note: string | null; support_access_note: string | null };
  partner: Row | null;
  clients: { id: string; name: string; enabled: boolean; created_at: string }[];
  tokens: { id: string; kind: string; name: string; prefix: string; scopes: string[]; created_at: string; last_used_at: string | null; expires_at: string | null; revoked_at: string | null }[];
  endUsers: { end_user: string; created_at: string; last_seen_at: string; blocked_at: string | null; jobs_24h: number; jobs_total: number }[];
  daily: { day: string; jobs: number; failed: number; end_users: number }[];
  ledger: { kind: string; credits: number; job_id: string | null; reference: string | null; created_at: string }[];
}
export interface AdminJob {
  id: string; account: { id: string; email: string }; endUser: string | null; preset: string | null; mode: string | null; state: string; error: string | null;
  createdAt: string; finishedAt: string | null; queueSeconds: number | null; runSeconds: number | null; workerSeconds: number | null;
  gpu: { type: string; region: string | null } | null; charged: number | null; regions: boolean;
  generation: { op: string; steps: number; strength: number | null; control_scale: number | null; sampler: string; seed: number } | null;
  content: "support_access" | "report" | "beta" | null;
  pictures?: { sketch?: string; hint?: string; result?: string };
  prompt?: string | null;
  narrative?: string | null;
}
export interface AdminReport {
  id: string; jobId: string | null; account: { id: string; email: string | null; flagged: boolean } | null; source: string; reason: string; note: string | null;
  status: string; createdAt: string; resolvedAt: string | null; resolvedBy: string | null; snapshot: Row; output: string | null; inputs: { name: string; url: string | null }[];
}
export interface AdminAuditEntry { at: string; operator: string; action: string; user_id: string | null; email: string | null; job_id: string | null; report_id: string | null; note: string | null }

export const api = {
  tokens: () => call<{ tokens: ApiToken[] }>("GET", "/v1/tokens"),
  createToken: (name: string, scopes: string[], expiresInDays?: number) =>
    call<{ token: ApiToken; secret: string }>("POST", "/v1/tokens", { name, scopes, ...(expiresInDays ? { expiresInDays } : {}) }),
  revokeToken: (id: string) => call("DELETE", `/v1/tokens/${id}`),
  me: () => call<{ user: User; credits: number; operator?: boolean; supportAccessUntil?: string | null }>("GET", "/v1/me"),
  setSupportAccess: (days: number) => call<{ supportAccessUntil: string | null }>("PATCH", "/v1/me", { supportAccessDays: days }),
  admin: {
    overview: () => call<AdminOverview>("GET", "/v1/admin/overview"),
    accounts: () => call<{ accounts: AdminAccountRow[] }>("GET", "/v1/admin/accounts"),
    account: (id: string) => call<AdminAccount>("GET", `/v1/admin/accounts/${id}`),
    endSupportAccess: (id: string) => call("POST", `/v1/admin/accounts/${id}/support-access`, { days: 0 }),
    block: (id: string, endUser: string, blocked: boolean) =>
      call("POST", `/v1/admin/accounts/${id}/end-users/${encodeURIComponent(endUser)}/${blocked ? "block" : "unblock"}`, {}),
    jobs: (f: Record<string, string>) => call<{ jobs: AdminJob[] }>("GET", `/v1/admin/jobs?${new URLSearchParams(f)}`),
    reports: (all: boolean) => call<{ reports: AdminReport[] }>("GET", `/v1/admin/reports${all ? "?status=all" : ""}`),
    act: (id: string, action: "dismiss" | "remove" | "flag-account", note: string) => call("POST", `/v1/admin/reports/${id}/${action}`, note ? { note } : {}),
    audit: () => call<{ entries: AdminAuditEntry[] }>("GET", "/v1/admin/audit"),
    usage: (from: string, to: string) => call<{ summary: unknown; files: Record<string, string> }>("GET", `/v1/admin/usage-report?from=${from}&to=${to}`),
  },
  signup: (email: string, password: string, locale: string) => call<{ user: User }>("POST", "/v1/auth/signup", { email, password, locale }),
  login: (email: string, password: string) => call<{ user: User }>("POST", "/v1/auth/login", { email, password }),
  logout: () => call("POST", "/v1/auth/logout"),
  setLocale: (locale: string) => call("PATCH", "/v1/me", { locale }),
  assets: (kind?: string) => call<{ assets: Asset[] }>("GET", `/v1/assets${kind ? `?kind=${kind}` : ""}`),
  catalog: () => call<{ models: Asset[] }>("GET", "/v1/catalog"),
  jobs: () => call<{ jobs: Job[] }>("GET", "/v1/jobs"),
  submit: (workflow: unknown) => call<{ job: Job }>("POST", "/v1/jobs", { workflow }),
  cancel: (id: string) => call("POST", `/v1/jobs/${id}/cancel`),
  content: (assetId: string) => `/v1/assets/${assetId}/content`,

  // A picture: converted to PNG in the browser (the engine reads PNG), then uploaded to a signed URL.
  // A 3D model (.glb), as it is.
  async uploadModelFile(file: File): Promise<Asset> {
    const name = file.name.replace(/\.[^.]*$/, "") + ".glb";
    const start = await call<{ asset: Asset; uploadUrl: string }>("POST", "/v1/assets", { name, kind: "input", bytes: file.size, contentType: "model/gltf-binary" });
    const put = await fetch(start.uploadUrl, { method: "PUT", body: file, headers: { "content-type": "model/gltf-binary" } });
    if (!put.ok) throw new ApiError(put.status === 413 ? "request.too_large" : "internal");
    return (await call<{ asset: Asset }>("POST", `/v1/assets/${start.asset.id}/complete`)).asset;
  },

  async uploadPicture(file: File): Promise<Asset> {
    const png = await toPng(file);
    const name = file.name.replace(/\.[^.]*$/, "") + ".png";
    const start = await call<{ asset: Asset; uploadUrl: string }>("POST", "/v1/assets", { name, kind: "input", bytes: png.size, contentType: "image/png" });
    const put = await fetch(start.uploadUrl, { method: "PUT", body: png, headers: { "content-type": "image/png" } });
    if (!put.ok) throw new ApiError(put.status === 413 ? "request.too_large" : "internal");
    return (await call<{ asset: Asset }>("POST", `/v1/assets/${start.asset.id}/complete`)).asset;
  },

  // Live job events; returns a function that stops listening.
  watch(id: string, on: (e: JobEvent | { type: "job"; job: Job }) => void): () => void {
    const es = new EventSource(`/v1/jobs/${id}/events`);
    es.onmessage = (m) => on(JSON.parse(m.data));
    return () => es.close();
  },
};

async function toPng(file: File): Promise<Blob> {
  if (file.type === "image/png") return file;
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new ApiError("request.invalid"))), "image/png"));
}
