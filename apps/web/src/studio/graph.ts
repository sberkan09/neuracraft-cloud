// Workflow <-> node graph (ported from the engine's Studio): steps are nodes, clip references are
// edges. The workflow stays the source of truth, its steps in an order where every clip is made
// before it is read; each step's `ui` holds its node id and position.
import type { EngineOp, Job } from "@neuracraft/shared";

export type Step = { op: string; out?: string; ui?: StepUi; [field: string]: unknown };
export interface Workflow {
  steps: Step[];
  [key: string]: unknown;
}
export interface StepUi {
  id: string;
  x: number;
  y: number;
}
export type Ops = Map<string, EngineOp>;

let counter = 0;
const newId = () => `n${Date.now().toString(36)}${(counter++).toString(36)}`;

// Fields that read what another step made: clips, and 3D models (they share the clips' names).
export const clipFields = (op?: EngineOp) => (op ? op.fields.filter((f) => f.type === "clip" || f.type === "clips" || f.type === "mesh") : []);
export const outName = (s: Step) => String(s.out ?? s.op);
export const stepId = (s: Step) => String(s.ui?.id ?? "");
const names = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);

// References of step i: the field, the clip name, the producing step and the slot in a list field.
export function references(steps: Step[], ops: Ops, i: number): { field: string; clip: string; from: number; slot: number }[] {
  const out: { field: string; clip: string; from: number; slot: number }[] = [];
  for (const f of clipFields(ops.get(steps[i]!.op)))
    names(steps[i]![f.name]).forEach((name, slot) => {
      for (let j = i - 1; j >= 0; --j)
        if (ops.get(steps[j]!.op)?.output && outName(steps[j]!) === name) {
          out.push({ field: f.name, clip: name, from: j, slot });
          break;
        }
    });
  return out;
}

// Every step gets an id and a position; missing positions are laid out by depth (columns) in order.
export function withLayout(wf: Workflow, ops: Ops): Workflow {
  const steps = wf.steps;
  if (steps.every((s) => typeof s.ui?.id === "string" && typeof s.ui.x === "number" && typeof s.ui.y === "number")) return wf;
  const depth: number[] = [];
  const rows = new Map<number, number>();
  return {
    ...wf,
    steps: steps.map((s, i) => {
      const refs = references(steps, ops, i);
      depth[i] = refs.length ? Math.max(...refs.map((r) => depth[r.from]! + 1)) : 0;
      const row = rows.get(depth[i]!) ?? 0;
      rows.set(depth[i]!, row + 1);
      return {
        ...s,
        ui: {
          id: typeof s.ui?.id === "string" ? s.ui.id : newId(),
          x: typeof s.ui?.x === "number" ? s.ui.x : 40 + depth[i]! * 300,
          y: typeof s.ui?.y === "number" ? s.ui.y : 40 + row * 170,
        },
      };
    }),
  };
}

// Steps reordered so producers come before readers (stable); null when the references form a cycle.
export function topoSort(steps: Step[], ops: Ops): Step[] | null {
  // References resolve by name against any producer (not only earlier ones), so new edges can point backwards.
  const producers = new Map<string, number[]>();
  steps.forEach((s, i) => {
    if (ops.get(s.op)?.output) producers.set(outName(s), [...(producers.get(outName(s)) ?? []), i]);
  });
  const deps = steps.map((s, i) => {
    const d = new Set<number>();
    for (const f of clipFields(ops.get(s.op)))
      for (const n of names(s[f.name])) {
        const ps = (producers.get(n) ?? []).filter((p) => p !== i);
        if (!ps.length) continue;
        const earlier = ps.filter((p) => p < i);  // the nearest earlier producer, else the first later one
        d.add(earlier.length ? earlier[earlier.length - 1]! : ps[0]!);
      }
    return d;
  });
  const done = new Array<boolean>(steps.length).fill(false);
  const order: number[] = [];
  while (order.length < steps.length) {
    const i = steps.findIndex((_, k) => !done[k] && [...deps[k]!].every((d) => done[d]));
    if (i < 0) return null;
    done[i] = true;
    order.push(i);
  }
  return order.map((i) => steps[i]!);
}

// A clip name not used by any step yet.
export function uniqueName(steps: Step[], base: string): string {
  const used = new Set(steps.map(outName));
  if (!used.has(base)) return base;
  let k = 2;
  while (used.has(`${base}${k}`)) ++k;
  return `${base}${k}`;
}

// A node position near (x, y) that does not cover an existing node (nodes are about 240 x 150).
export function freeSpot(steps: Step[], x: number, y: number): StepUi {
  const taken = (py: number) => steps.some((s) => s.ui && Math.abs(s.ui.x - x) < 250 && Math.abs(s.ui.y - py) < 150);
  while (taken(y)) y += 170;
  return { id: newId(), x, y };
}

// Steps needed to compute step i: it and everything it reads, directly or not (in workflow order).
export function upstream(steps: Step[], ops: Ops, i: number): number[] {
  const need = new Set<number>([i]);
  for (let k = i; k >= 0; --k) if (need.has(k)) for (const r of references(steps, ops, k)) need.add(r.from);
  return [...need].sort((a, b) => a - b);
}

// The output file a save step writes (what the job's outputs are named after).
export const saveName = (s: Step) => (s.op === "save" && typeof s.path === "string" ? s.path : undefined);

// What a node shows from the latest job that ran it: its state and, for saves (and the steps whose
// clip a save wrote), the picture.
export interface NodeRun {
  status: "" | "queued" | "running" | "done" | "failed";
  stage: string;
  output?: { assetId: string; kind: string };
}
export function nodeRuns(jobs: Job[]): Map<string, NodeRun> {
  const runs = new Map<string, NodeRun>();
  for (let k = jobs.length - 1; k >= 0; --k) {  // oldest first: newer jobs overwrite
    const job = jobs[k]!;
    const wf = job.workflow as Workflow | null;
    if (!wf || !Array.isArray(wf.steps)) continue;
    const at = job.progress?.step ?? 0;  // 1-based step being run
    wf.steps.forEach((s, i) => {
      const id = stepId(s);
      if (!id) return;
      let status: NodeRun["status"] = "";
      if (job.state === "succeeded") status = "done";
      else if (job.state === "queued" || job.state === "leased") status = "queued";
      else if (job.state === "running") status = at === i + 1 ? "running" : at > i + 1 ? "done" : "queued";
      else if (job.state === "failed") status = at > i + 1 ? "done" : at === i + 1 ? "failed" : "";
      const file = saveName(s);
      const out = file ? job.outputs.find((o) => o.name === file) : undefined;
      runs.set(id, { status, stage: at === i + 1 ? (job.progress?.stage ?? "") : "", output: out && { assetId: out.assetId, kind: out.kind } });
    });
    // A save's picture also shows on the step whose clip it wrote.
    wf.steps.forEach((s) => {
      const file = saveName(s);
      const out = file ? job.outputs.find((o) => o.name === file) : undefined;
      if (!out || typeof s.in !== "string") return;
      const src = wf.steps.find((p) => p.op !== "save" && outName(p) === s.in);
      const r = src && runs.get(stepId(src));
      if (r && !r.output) r.output = { assetId: out.assetId, kind: out.kind };
    });
  }
  return runs;
}
