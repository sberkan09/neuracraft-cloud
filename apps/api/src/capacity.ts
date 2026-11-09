// On-demand GPU workers: sessions say when interactive work may come, the capacity manager rents GPU
// pods for them and gives them back when nobody needs them (docs/ARCHITECTURE.md, "Sessions and
// on-demand GPUs").
//
// Every tick (one API replica at a time):
// 1. sessions without a heartbeat, or past their longest, are closed;
// 2. how many warm workers are wanted: none without demand, else one per CAPACITY_SESSIONS_PER_WORKER
//    sessions asking for capacity (at least one), one more when interactive jobs wait, at most
//    CAPACITY_MAX_PODS; after the last demand the pods stay CAPACITY_GRACE_MINUTES;
// 3. missing pods are rented (GPU types in order; nothing past CAPACITY_DAILY_BUDGET_USD), extra
//    ones drained: their worker takes no more jobs, the pod is stopped once it is idle;
// 4. pods whose worker never came, died, or outlived CAPACITY_MAX_POD_HOURS are replaced, and pods
//    the provider has that this service does not know of are terminated.
import type { CapacityConfig } from "./config.js";
import type { Db } from "./db.js";

export interface PodSpec {
  id: string; // our gpu_pods.id: the pod's worker registers with WORKER_POD_ID = id
  name: string;
}
export interface RentedPod {
  providerId: string;
  gpuType: string;
  region: string | null;
  pricePerHour: number;
}
export interface ProviderPod {
  providerId: string;
  name: string;
  status: "starting" | "running" | "stopped";
}
export interface GpuProvider {
  readonly name: string;
  // Throws CapacityUnavailable when no GPU of any allowed kind can be had right now.
  rent(spec: PodSpec): Promise<RentedPod>;
  terminate(providerId: string): Promise<void>;
  list(): Promise<ProviderPod[]>; // the pods this service rented (name prefix POD_PREFIX)
}
export class CapacityUnavailable extends Error {}
export const POD_PREFIX = "nc-gpu-";

export type CapacityState = { state: "ready" } | { state: "warming"; etaSeconds: number } | { state: "unavailable"; reason: string };

const LIVE = "('requested', 'starting', 'running', 'draining')";
const WORKER_GRACE_SECONDS = 180; // a running pod's worker unseen this long is dead

// What a session (or a submission) can expect right now, for interactive jobs in `regions`.
export async function capacityState(db: Db, cfg: CapacityConfig, regions: string[], graceSeconds: number, manager?: CapacityManager): Promise<CapacityState> {
  const ready = await db.query(
    `SELECT 1 FROM workers WHERE class = 'gpu' AND NOT draining AND NOT warming AND last_seen_at > now() - make_interval(secs => $2)
       AND (cardinality($1::text[]) = 0 OR capabilities ->> 'region' = ANY($1::text[])) LIMIT 1`,
    [regions, graceSeconds],
  );
  if (ready.rowCount) return { state: "ready" };
  const starting = await db.query<{ waited: number }>(
    `SELECT extract(epoch FROM now() - requested_at)::float8 AS waited FROM gpu_pods
      WHERE state IN ('requested', 'starting', 'running') ORDER BY requested_at LIMIT 1`,
  );
  if (starting.rows[0]) return { state: "warming", etaSeconds: Math.max(5, Math.round(cfg.expectedStartSeconds - starting.rows[0].waited)) };
  if (!cfg.provider) return { state: "unavailable", reason: "no GPU worker" };
  if (manager?.blocked) return { state: "unavailable", reason: manager.blocked };
  return { state: "warming", etaSeconds: cfg.expectedStartSeconds }; // the next tick rents one
}

export interface TickReport {
  closed: number;
  demand: number;
  wanted: number;
  live: number;
  rented: string[];
  drained: string[];
  stopped: string[];
  failed: string[];
}

export class CapacityManager {
  blocked: string | null = null; // why no pod can be rented right now (budget, no GPUs)
  private blockedUntil = 0;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly cfg: CapacityConfig,
    private readonly sessionsCfg: { expireSeconds: number; idleMinutes: number },
    private readonly provider: GpuProvider | null,
    private readonly log: (msg: string, extra?: Record<string, unknown>) => void = () => {},
  ) {}

  private pending: Promise<unknown> = Promise.resolve();

  // Run a tick soon (a session opened); ticks never overlap within a process.
  kick(): void {
    this.pending = this.tick().catch((e) => this.log("capacity tick failed", { error: String(e) }));
  }

  // Wait for a kicked tick to finish (shutdown, tests).
  async settle(): Promise<void> {
    await this.pending;
  }

  async tick(now = new Date()): Promise<TickReport | null> {
    if (this.running) return null;
    this.running = true;
    const lock = await this.db.connect();
    try {
      if (!(await lock.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(727005) AS ok")).rows[0]?.ok) return null;
      try {
        return await this.step(now);
      } finally {
        await lock.query("SELECT pg_advisory_unlock(727005)");
      }
    } finally {
      lock.release();
      this.running = false;
    }
  }

  private async step(now: Date): Promise<TickReport> {
    const db = this.db;
    const r: TickReport = { closed: 0, demand: 0, wanted: 0, live: 0, rented: [], drained: [], stopped: [], failed: [] };
    // 1. Sessions that went quiet or ran too long.
    const closed = await db.query(
      `UPDATE app_sessions SET closed_at = $1, close_reason = CASE WHEN ends_at <= $1::timestamptz THEN 'limit' ELSE 'expired' END
        WHERE closed_at IS NULL AND (ends_at <= $1::timestamptz OR last_seen_at < $1::timestamptz - make_interval(secs => $2))`,
      [now, this.sessionsCfg.expireSeconds],
    );
    r.closed = closed.rowCount ?? 0;
    if (!this.provider) return r;

    // 2. Demand.
    const d = await db.query<{ demand: string; last_end: Date | null; waiting: string }>(
      `SELECT
         (SELECT count(*) FROM app_sessions WHERE closed_at IS NULL AND coalesce(last_job_at, started_at) > $1::timestamptz - make_interval(mins => $2)) AS demand,
         (SELECT max(coalesce(closed_at, least($1::timestamptz, coalesce(last_job_at, started_at) + make_interval(mins => $2))))
            FROM app_sessions WHERE started_at > $1::timestamptz - interval '2 days') AS last_end,
         (SELECT count(*) FROM jobs WHERE state = 'queued' AND latency = 'interactive' AND created_at < $1::timestamptz - interval '15 seconds') AS waiting`,
      [now, this.sessionsCfg.idleMinutes],
    );
    const demand = Number(d.rows[0]!.demand);
    const waiting = Number(d.rows[0]!.waiting);
    r.demand = demand;
    const pods = await db.query<{ id: string; provider_id: string | null; state: string; worker_id: string | null; requested_at: Date; ready_at: Date | null; drain_at: Date | null; seen: Date | null; busy: boolean }>(
      `SELECT p.id, p.provider_id, p.state, p.worker_id, p.requested_at, p.ready_at, p.drain_at, w.last_seen_at AS seen,
              EXISTS (SELECT 1 FROM jobs j WHERE j.worker_id = p.worker_id AND j.state IN ('leased', 'running')) AS busy
         FROM gpu_pods p LEFT JOIN workers w ON w.id = p.worker_id WHERE p.state IN ${LIVE} ORDER BY p.requested_at`,
    );
    const serving = pods.rows.filter((p) => p.state !== "draining");
    let wanted = demand === 0 ? 0 : Math.max(1, Math.ceil(demand / this.cfg.sessionsPerWorker));
    if (waiting > 0) wanted = Math.max(wanted, serving.filter((p) => p.state === "running" && !p.busy).length ? serving.length : serving.length + 1);
    const lastEnd = d.rows[0]!.last_end;
    const inGrace = lastEnd !== null && now.getTime() - lastEnd.getTime() < this.cfg.graceMinutes * 60_000;
    // In the grace after the last demand, pods are kept (not drained) but not replaced either.
    wanted = Math.min(wanted, this.cfg.maxPods);
    r.wanted = wanted;

    // 4a. Pods to give up: never registered, dead worker, too old.
    for (const p of serving) {
      const age = (now.getTime() - p.requested_at.getTime()) / 1000;
      if ((p.state === "requested" || p.state === "starting") && age > this.cfg.startTimeoutSeconds) {
        await this.stop(p.id, p.provider_id, "failed", "the worker did not register in time");
        r.failed.push(p.id);
      } else if (p.state === "running" && p.seen && (now.getTime() - p.seen.getTime()) / 1000 > WORKER_GRACE_SECONDS) {
        await this.stop(p.id, p.provider_id, "failed", "the worker stopped answering");
        r.failed.push(p.id);
      } else if (p.state === "running" && p.ready_at && (now.getTime() - p.ready_at.getTime()) / 3600_000 > this.cfg.maxPodHours) {
        await this.drain(p.id, p.worker_id, now);
        r.drained.push(p.id);
      }
    }
    const live = (await db.query<{ n: string }>(`SELECT count(*) AS n FROM gpu_pods WHERE state IN ('requested', 'starting', 'running')`)).rows[0]!.n;
    let count = Number(live);
    r.live = count;

    // 3. Rent or drain.
    if (count < wanted && Date.now() >= this.blockedUntil) {
      const spent = await this.spentToday(now);
      if (spent >= this.cfg.dailyBudgetUsd) {
        this.block(`daily GPU budget reached (${spent.toFixed(2)} of ${this.cfg.dailyBudgetUsd} USD)`, 5 * 60_000);
      } else {
        while (count < wanted) {
          const id = await this.rent();
          if (!id) break;
          r.rented.push(id);
          count++;
        }
      }
    } else if (count > wanted && !inGrace) {
      // Starting pods first (newest), then idle running ones.
      const extra = count - wanted;
      const candidates = [
        ...serving.filter((p) => p.state !== "running").reverse(),
        ...serving.filter((p) => p.state === "running" && !p.busy),
      ].slice(0, extra);
      for (const p of candidates) {
        if (p.state !== "running") {
          await this.stop(p.id, p.provider_id, "stopped");
          r.stopped.push(p.id);
        } else {
          await this.drain(p.id, p.worker_id, now);
          r.drained.push(p.id);
        }
      }
    }

    // Drained pods whose worker is idle (or that drained for 10 minutes) are stopped.
    const draining = await db.query<{ id: string; provider_id: string | null; busy: boolean; drain_at: Date }>(
      `SELECT p.id, p.provider_id, p.drain_at, EXISTS (SELECT 1 FROM jobs j WHERE j.worker_id = p.worker_id AND j.state IN ('leased', 'running')) AS busy
         FROM gpu_pods p WHERE p.state = 'draining'`,
    );
    for (const p of draining.rows)
      if (!p.busy || now.getTime() - p.drain_at.getTime() > 10 * 60_000) {
        await this.stop(p.id, p.provider_id, "stopped");
        r.stopped.push(p.id);
      }

    // 4b. The provider's view: orphans go, pods it no longer has are marked stopped.
    try {
      const theirs = await this.provider.list();
      const ours = await db.query<{ id: string; provider_id: string; requested_at: Date }>(
        `SELECT id, provider_id, requested_at FROM gpu_pods WHERE state IN ${LIVE} AND provider_id IS NOT NULL`,
      );
      const known = new Map(ours.rows.map((p) => [p.provider_id, p]));
      for (const t of theirs) {
        const mine = known.get(t.providerId);
        // Ours but not live here (a crash between renting and recording, a lost delete): it goes.
        if (!mine) {
          await this.provider.terminate(t.providerId);
          this.log("terminated an unknown pod", { providerId: t.providerId, name: t.name });
        } else if (t.status === "stopped") {
          // Exited or broken at the provider: give it up (the next tick rents another if needed).
          await this.stop(mine.id, t.providerId, "failed", "the pod exited at the provider");
          r.failed.push(mine.id);
        }
      }
      const present = new Set(theirs.map((t) => t.providerId));
      for (const p of ours.rows)
        if (!present.has(p.provider_id) && now.getTime() - p.requested_at.getTime() > 120_000) {
          await db.query(`UPDATE gpu_pods SET state = 'stopped', stopped_at = $2, error = coalesce(error, 'gone at the provider') WHERE id = $1 AND state IN ${LIVE}`, [p.id, now]);
          r.stopped.push(p.id);
        }
    } catch (e) {
      this.log("capacity: listing the provider's pods failed", { error: String(e) });
    }
    if (r.rented.length || r.drained.length || r.stopped.length || r.failed.length || r.closed) this.log("capacity", { ...r });
    return r;
  }

  private block(reason: string, ms: number) {
    this.blocked = reason;
    this.blockedUntil = Date.now() + ms;
    this.log("capacity blocked", { reason });
  }

  private async rent(): Promise<string | null> {
    const row = await this.db.query<{ id: string }>(`INSERT INTO gpu_pods (provider, state) VALUES ($1, 'requested') RETURNING id`, [this.provider!.name]);
    const id = row.rows[0]!.id;
    try {
      const pod = await this.provider!.rent({ id, name: POD_PREFIX + id.slice(0, 8) });
      await this.db.query("UPDATE gpu_pods SET provider_id = $2, gpu_type = $3, region = $4, price_per_hour = $5, state = 'starting' WHERE id = $1", [
        id,
        pod.providerId,
        pod.gpuType,
        pod.region,
        pod.pricePerHour,
      ]);
      this.blocked = null;
      return id;
    } catch (e) {
      await this.db.query("UPDATE gpu_pods SET state = 'failed', stopped_at = now(), error = $2 WHERE id = $1", [id, String((e as Error).message).slice(0, 500)]);
      if (e instanceof CapacityUnavailable) this.block("no GPU available at the provider", 60_000);
      else this.block(`renting a GPU failed: ${(e as Error).message.slice(0, 200)}`, 60_000);
      return null;
    }
  }

  private async drain(id: string, workerId: string | null, now: Date) {
    await this.db.query("UPDATE gpu_pods SET state = 'draining', drain_at = $2 WHERE id = $1", [id, now]);
    if (workerId) await this.db.query("UPDATE workers SET draining = true WHERE id = $1", [workerId]);
  }

  private async stop(id: string, providerId: string | null, state: "stopped" | "failed", error?: string) {
    if (providerId) {
      try {
        await this.provider!.terminate(providerId);
      } catch (e) {
        this.log("capacity: terminating a pod failed (the next tick retries)", { providerId, error: String(e) });
        return;
      }
    }
    await this.db.query("UPDATE gpu_pods SET state = $2, stopped_at = now(), error = coalesce($3, error) WHERE id = $1", [id, state, error ?? null]);
    await this.db.query("UPDATE workers SET draining = true WHERE id = (SELECT worker_id FROM gpu_pods WHERE id = $1)", [id]);
  }

  // What pods rented since midnight (UTC) cost so far.
  async spentToday(now = new Date()): Promise<number> {
    const r = await this.db.query<{ usd: string | null }>(
      `SELECT sum(price_per_hour * extract(epoch FROM coalesce(stopped_at, $1) - greatest(requested_at, date_trunc('day', $1::timestamptz))) / 3600) AS usd
         FROM gpu_pods WHERE price_per_hour IS NOT NULL AND coalesce(stopped_at, $1) > date_trunc('day', $1::timestamptz)`,
      [now],
    );
    return Number(r.rows[0]?.usd ?? 0);
  }
}

// A pod's worker registered: the pod is running.
export async function podWorkerRegistered(db: Db, podId: unknown, workerId: string): Promise<void> {
  if (typeof podId !== "string" || !/^[0-9a-f-]{36}$/.test(podId)) return;
  await db.query("UPDATE gpu_pods SET worker_id = $2, state = 'running', ready_at = coalesce(ready_at, now()) WHERE id = $1 AND state IN ('requested', 'starting', 'running')", [
    podId,
    workerId,
  ]);
}
