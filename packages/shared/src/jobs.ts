export const JobStates = ["queued", "leased", "running", "succeeded", "failed", "cancelled"] as const;
export type JobState = (typeof JobStates)[number];
export const finishedStates: readonly JobState[] = ["succeeded", "failed", "cancelled"];

// What a plan allows one job (mirrors the engine's WorkflowLimits; files are always sandboxed).
export interface JobLimits {
  maxSteps: number;
  maxPixels: number;
  maxFrames: number;
  maxDenoiseSteps: number;
  maxSeconds: number;
}

export interface JobOutput {
  name: string; // the clip or file name the workflow gave it
  assetId: string;
  kind: "image" | "video" | "file";
  bytes: number;
}

export interface Job {
  id: string;
  state: JobState;
  workflow: unknown;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: JobProgress | null;
  outputs: JobOutput[];
  error: { code: string; detail?: string } | null;
  workerSeconds: number | null;
}

// The engine's WorkflowEvents::progress, as the worker reports it.
export interface JobProgress {
  step: number;
  steps: number;
  op: string;
  stage: string;
  fraction: number; // -1 when unknown
}

// Server-sent events on GET /v1/jobs/:id/events.
export type JobEvent =
  | { type: "state"; state: JobState }
  | { type: "progress"; progress: JobProgress }
  | { type: "output"; output: JobOutput }
  | { type: "error"; error: { code: string; detail?: string } };
