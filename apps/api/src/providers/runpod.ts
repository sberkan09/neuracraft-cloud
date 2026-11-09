// Runpod GPU pods for the capacity manager (capacity.ts), through Runpod's REST API v2
// (https://api.runpod.io/v2/openapi.json): POST /v2/pods, DELETE /v2/pods/{id}, GET /v2/pods.
//
// A pod runs the GPU worker image (deploy/worker-gpu.Dockerfile, RUNPOD_IMAGE) and registers with
// this API (RUNPOD_WORKER_API_URL) as an interactive-only GPU worker. With RUNPOD_NETWORK_VOLUME_ID
// the worker's model cache lives on that volume, shared by every pod, so a new pod skips downloading
// the models (the volume pins the data center).
import type { CapacityConfig } from "../config.js";
import { CapacityUnavailable, POD_PREFIX, type GpuProvider, type PodSpec, type ProviderPod, type RentedPod } from "../capacity.js";

type Fetch = typeof fetch;

export class RunpodProvider implements GpuProvider {
  readonly name = "runpod";
  constructor(
    private readonly cfg: CapacityConfig["runpod"],
    private readonly fetchImpl: Fetch = fetch,
  ) {
    if (!cfg.apiKey) throw new Error("CAPACITY_PROVIDER=runpod needs RUNPOD_API_KEY");
    if (!cfg.image) throw new Error("CAPACITY_PROVIDER=runpod needs RUNPOD_IMAGE (the GPU worker image)");
    if (!cfg.workerApiUrl || !cfg.workerToken) throw new Error("CAPACITY_PROVIDER=runpod needs RUNPOD_WORKER_API_URL and a worker token");
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const r = await this.fetchImpl(this.cfg.url + path, {
      method,
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { detail: text.slice(0, 300) };
    }
    return { status: r.status, json };
  }

  async rent(spec: PodSpec): Promise<RentedPod> {
    const env: Record<string, string> = {
      ...this.cfg.workerEnv,
      API_URL: this.cfg.workerApiUrl,
      WORKER_TOKEN: this.cfg.workerToken,
      WORKER_CLASS: "gpu",
      WORKER_POD_ID: spec.id,
    };
    if (this.cfg.networkVolumeId) env.CACHE_DIR ??= "/runpod-volume/cache";
    let lastCapacityError = "";
    for (const gpu of this.cfg.gpuTypes) {
      const body: Record<string, unknown> = {
        name: spec.name,
        image: this.cfg.image,
        cloud: this.cfg.cloud,
        gpu: { id: gpu, count: 1 },
        disk: 30,
        env,
      };
      if (this.cfg.registryAuthId) body.registry = this.cfg.registryAuthId;
      if (this.cfg.dataCenters.length) body.dataCenterIds = this.cfg.dataCenters;
      if (this.cfg.networkVolumeId) body.mounts = { network: [{ volumeId: this.cfg.networkVolumeId, path: "/runpod-volume" }] };
      const r = await this.call("POST", "/v2/pods", body);
      if (r.status === 201 || r.status === 200) {
        return { providerId: String(r.json.id), gpuType: gpu, region: r.json.dataCenterId ?? null, pricePerHour: Number(r.json.cost ?? 0) };
      }
      const detail = String(r.json?.detail ?? r.json?.title ?? r.status);
      // No machine with this GPU right now: try the next kind.
      if (r.status === 400 && /no longer any instances|not enough free|no available|capacity/i.test(detail + String(r.json?.hint ?? ""))) {
        lastCapacityError = `${gpu}: ${detail}`;
        continue;
      }
      throw new Error(`runpod: creating a pod failed (${r.status}): ${detail}`);
    }
    throw new CapacityUnavailable(`runpod: no GPU available (${lastCapacityError || this.cfg.gpuTypes.join(", ")})`);
  }

  async terminate(providerId: string): Promise<void> {
    const r = await this.call("DELETE", `/v2/pods/${encodeURIComponent(providerId)}`);
    if (r.status !== 204 && r.status !== 200 && r.status !== 404) throw new Error(`runpod: deleting pod ${providerId} failed (${r.status})`);
  }

  async list(): Promise<ProviderPod[]> {
    const out: ProviderPod[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const r = await this.call("GET", `/v2/pods?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (r.status !== 200) throw new Error(`runpod: listing pods failed (${r.status})`);
      for (const p of r.json?.pods ?? [])
        if (typeof p.name === "string" && p.name.startsWith(POD_PREFIX))
          out.push({
            providerId: String(p.id),
            name: p.name,
            status: p.status === "RUNNING" ? "running" : p.status === "EXITED" || p.status === "TERMINATED" || p.status === "ERROR" ? "stopped" : "starting",
          });
      cursor = r.json?.pagination?.hasNextPage ? r.json.pagination.nextCursor : null;
      if (!cursor) break;
    }
    return out;
  }
}
