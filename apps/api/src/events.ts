// Job events between API copies and to browsers: NOTIFY on change, one LISTEN connection per process.
import pg from "pg";
import type { JobEvent } from "@neuracraft/shared";
import type { Db } from "./db.js";

type Q = Db | pg.PoolClient;
type Listener = (e: JobEvent) => void;

export async function publish(q: Q, jobId: string, event: JobEvent): Promise<void> {
  await q.query("SELECT pg_notify('job_events', $1)", [JSON.stringify({ jobId, event })]);
}

export class JobEvents {
  private client: pg.Client | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly url: string) {}

  async start(): Promise<void> {
    this.client = new pg.Client({ connectionString: this.url });
    await this.client.connect();
    this.client.on("notification", (n) => {
      if (n.channel !== "job_events" || !n.payload) return;
      try {
        const { jobId, event } = JSON.parse(n.payload) as { jobId: string; event: JobEvent };
        for (const l of this.listeners.get(jobId) ?? []) l(event);
      } catch {
        /* a malformed payload is ignored */
      }
    });
    await this.client.query("LISTEN job_events");
  }

  subscribe(jobId: string, l: Listener): () => void {
    let set = this.listeners.get(jobId);
    if (!set) this.listeners.set(jobId, (set = new Set()));
    set.add(l);
    return () => {
      set!.delete(l);
      if (!set!.size) this.listeners.delete(jobId);
    };
  }

  async stop(): Promise<void> {
    await this.client?.end();
    this.client = null;
  }
}
