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
  kind: "image" | "video" | "model" | "file";
  bytes: number;
}

// What an output is, from its content type: pictures and clips, 3D models (glTF binary), other files.
export function outputKind(contentType: string): JobOutput["kind"] {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType === "model/gltf-binary") return "model";
  return "file";
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
  // The rented GPU the job ran on, when it ran on one (the capacity manager's pods).
  gpu?: { type: string | null; region: string | null };
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
