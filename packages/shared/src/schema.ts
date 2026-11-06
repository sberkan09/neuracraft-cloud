// The engine's workflow schema (NeuraCraft `ops`), exported from the pinned engine version by
// scripts/update-engine-schema.sh.
import schema from "./engine-schema.json" with { type: "json" };

export interface EngineField {
  name: string;
  type: string; // int, float, bool, string, text, enum, clip, clips, model, loras, file, dir, strings, ints, keyframes
  doc: string;
  required: boolean;
  default?: unknown;
  model?: string;
  options?: string[];
  min?: number;
  max?: number;
}
export interface EngineOp {
  name: string;
  title: string;
  group: string;
  doc: string;
  output: boolean;
  fields: EngineField[];
}
export interface EngineSchema {
  version: number;
  ops: EngineOp[];
}

export const engineSchema = schema as EngineSchema;
export const fileFieldTypes = new Set(["model", "file", "dir", "loras"]);

export function findOp(name: string): EngineOp | undefined {
  return engineSchema.ops.find((o) => o.name === name);
}
