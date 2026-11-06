// What the editor can tell before a workflow is sent: missing fields, broken connections, files that
// are not the user's assets. The API checks again on submit, and the worker runs the engine's checks.
import { type Ops, type Step, type Workflow, clipFields, outName } from "./graph";

export interface Problem {
  step: number; // 0-based; -1 for the whole workflow
  code: "required" | "clip" | "file" | "folder" | "saveName" | "noSave" | "unknownOp";
  field?: string;
  clip?: string;
}

export const ASSET = /^asset:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LORA = /^asset:[0-9a-f-]{36}(:[0-9]*\.?[0-9]+)?$/;
// The API's rule for save names (apps/api/src/workflow.ts OUTPUT_NAME).
export const OUTPUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(png|jpe?g|gif|mov)$/;

const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

export function checkWorkflow(wf: Workflow, ops: Ops): Problem[] {
  const problems: Problem[] = [];
  const made = new Set<string>();
  wf.steps.forEach((s: Step, i) => {
    const op = ops.get(s.op);
    if (!op) {
      problems.push({ step: i, code: "unknownOp" });
      return;
    }
    for (const f of op.fields) {
      const v = s[f.name];
      if (f.name === "out") continue;
      if (f.required && empty(v)) {
        problems.push({ step: i, code: "required", field: f.name });
        continue;
      }
      if (empty(v)) continue;
      if (f.type === "clip" || f.type === "clips")
        for (const c of Array.isArray(v) ? v.map(String) : [String(v)]) if (!made.has(c)) problems.push({ step: i, code: "clip", field: f.name, clip: c });
      if (op.name === "save" && f.name === "path") {
        if (!OUTPUT_NAME.test(String(v))) problems.push({ step: i, code: "saveName", field: f.name });
      } else if (f.type === "dir") problems.push({ step: i, code: "folder", field: f.name });
      else if (f.type === "file" || f.type === "model") {
        if (!ASSET.test(String(v))) problems.push({ step: i, code: "file", field: f.name });
      } else if (f.type === "loras") {
        if (!Array.isArray(v) || v.some((x) => !LORA.test(String(x)))) problems.push({ step: i, code: "file", field: f.name });
      }
    }
    if (op.name === "load" && empty(s.path) && empty(s.dir)) problems.push({ step: i, code: "required", field: "path" });
    if (op.output) made.add(outName(s));
  });
  if (wf.steps.length && !wf.steps.some((s) => s.op === "save")) problems.push({ step: -1, code: "noSave" });
  return problems;
}

// Clips made before step i (what its clip fields can read).
export const clipsBefore = (steps: Step[], ops: Ops, i: number) => steps.slice(0, i).filter((s) => ops.get(s.op)?.output).map(outName);

// A save file name for a clip: safe characters, .gif for clips of several frames.
export function saveFileFor(clip: string, video: boolean): string {
  const base = clip.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[^A-Za-z0-9]+/, "").slice(0, 56) || "result";
  return `${base}.${video ? "gif" : "png"}`;
}

export { clipFields };
