// The worker protocol (docs/ARCHITECTURE.md): workers dial out to the API with a worker token.
import type { JobLimits, JobProgress } from "./jobs.js";

export interface WorkerCapabilities {
  class: "cpu" | "gpu";
  cores: number;
  memoryBytes: number;
  gpu?: string;
  vramBytes?: number;
  engineVersion: string;
  // Extra abilities: "3d" = a 3D service is attached (the engine's image_to_3d step works).
  features?: string[];
}

export interface WorkerRegisterResponse {
  workerId: string;
}

export interface WorkerClaimRequest {
  workerId: string;
  loadedModels: string[]; // asset ids of models in memory
  waitSeconds?: number; // long poll, at most 25
}

export interface ClaimedFile {
  assetId: string; // the workflow names it "asset:<id>"
  name: string; // the file name (its extension tells the engine what it is)
  sha256: string;
  bytes: number;
  url: string; // signed GET
  kind: "model" | "input";
  // A model folder (diffusers layout) is an archive of files: each with its path inside the folder.
  files?: { path: string; sha256: string; bytes: number; url: string }[];
  entry?: string; // the bundle file the workflow gets (else the folder)
}

export interface ClaimedJob {
  jobId: string;
  workflow: unknown; // engine workflow JSON, files named "asset:<id>"
  limits: JobLimits;
  files: ClaimedFile[];
  leaseSeconds: number;
}

export interface WorkerClaimResponse {
  job: ClaimedJob | null;
}

export interface HeartbeatRequest {
  workerId: string;
  progress?: JobProgress;
}
export interface HeartbeatResponse {
  cancel: boolean;
}

export interface UploadRequest {
  workerId: string;
  outputs: { name: string; bytes: number; contentType: string }[];
}
export interface UploadResponse {
  uploads: { name: string; key: string; url: string }[];
}

export interface CompleteRequest {
  workerId: string;
  outputs: { name: string; key: string; bytes: number; sha256: string; contentType: string }[];
  workerSeconds: number;
}

export interface FailRequest {
  workerId: string;
  code: string;
  detail?: string;
  workerSeconds: number;
}
