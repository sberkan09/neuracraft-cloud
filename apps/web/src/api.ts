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

export const api = {
  tokens: () => call<{ tokens: ApiToken[] }>("GET", "/v1/tokens"),
  createToken: (name: string, scopes: string[], expiresInDays?: number) =>
    call<{ token: ApiToken; secret: string }>("POST", "/v1/tokens", { name, scopes, ...(expiresInDays ? { expiresInDays } : {}) }),
  revokeToken: (id: string) => call("DELETE", `/v1/tokens/${id}`),
  me: () => call<{ user: User; credits: number }>("GET", "/v1/me"),
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
