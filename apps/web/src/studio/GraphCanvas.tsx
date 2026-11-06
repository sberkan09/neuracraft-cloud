// The node graph (React Flow): a node per step, an edge per clip reference. Dragging a step's output
// onto another step's input sets that field; deleting an edge clears it.
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { EngineOp } from "@neuracraft/shared";
import { api } from "../api";
import { clipFields, outName, references, stepId, topoSort, uniqueName, type NodeRun, type Ops, type Step, type StepUi } from "./graph";
import { useFieldLabel } from "./FieldInput";

interface StepData extends Record<string, unknown> {
  step: Step;
  op?: EngineOp;
  title: string;
  run?: NodeRun;
  invalid: boolean;
}

function useSummary() {
  const label = useFieldLabel();
  return (s: Step): string => {
    const parts: string[] = [];
    if (typeof s.prompt === "string" && s.prompt) parts.push(`“${s.prompt.length > 42 ? s.prompt.slice(0, 40) + "…" : s.prompt}”`);
    for (const k of ["frames", "steps", "width", "passes"]) if (s[k] !== undefined) parts.push(`${label(k).toLowerCase()} ${String(s[k])}`);
    if (s.op === "save" && typeof s.path === "string") parts.push(s.path);
    return parts.slice(0, 3).join(" · ");
  };
}

const StepNode = memo(function StepNode({ data, selected }: NodeProps<Node<StepData>>) {
  const { t } = useTranslation();
  const label = useFieldLabel();
  const summary = useSummary();
  const { step, op, run, invalid, title } = data;
  const inputs = clipFields(op);
  const cls = ["node", selected ? "selected" : "", invalid ? "invalid" : "", run?.status === "running" ? "running" : ""].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <div className="node-head">
        <strong>{title}</strong>
        <small className="muted">{step.op}</small>
      </div>
      {inputs.map((f, k) => (
        <div key={f.name} className="node-port in" style={{ top: 46 + k * 22 }}>
          <Handle type="target" position={Position.Left} id={f.name} />
          <span>{label(f.name)}{f.type === "clips" ? " …" : ""}{f.required ? "" : "?"}</span>
        </div>
      ))}
      <div className="node-body" style={{ paddingTop: inputs.length ? inputs.length * 22 + 16 : 8 }}>
        <small className="muted">{summary(step)}</small>
        {run?.output?.kind === "image" ? (
          <img className="node-thumb" src={api.content(run.output.assetId)} alt="" loading="lazy" />
        ) : step.op === "load" && typeof step.path === "string" && step.path.startsWith("asset:") ? (
          <img className="node-thumb" src={api.content(step.path.slice(6))} alt="" loading="lazy" />
        ) : null}
        {run?.status ? <span className={`state ${run.status}`}>{run.status === "running" && run.stage ? run.stage : t(`studio.nodeState.${run.status}`)}</span> : null}
      </div>
      {op?.output ? (
        <div className="node-port out">
          <span>{outName(step)}</span>
          <Handle type="source" position={Position.Right} id="out" />
        </div>
      ) : null}
    </div>
  );
});

const nodeTypes = { step: StepNode };

export function GraphCanvas(props: {
  steps: Step[];
  ops: Ops;
  runs: Map<string, NodeRun>;
  invalid: Set<number>;
  selected: number;
  title(op: string): string;
  onSelect(i: number): void;
  onChange(steps: Step[]): void;
  onMessage(text: string): void;
}) {
  const { t } = useTranslation();
  const label = useFieldLabel();
  const { steps, ops, runs } = props;
  const dark = typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;

  const derived = useMemo<Node<StepData>[]>(
    () =>
      steps.map((s, i) => {
        const ui = s.ui as StepUi;
        return {
          id: ui.id,
          type: "step",
          position: { x: ui.x, y: ui.y },
          selected: i === props.selected,
          data: { step: s, op: ops.get(s.op), title: props.title(s.op), run: runs.get(ui.id), invalid: props.invalid.has(i) },
        };
      }),
    [steps, ops, runs, props.selected, props.invalid, props.title],
  );
  // A local copy keeps dragging smooth; positions go back to the workflow when a drag ends.
  const [nodes, setNodes] = useState(derived);
  useEffect(() => setNodes(derived), [derived]);
  // Steps added or removed: the view follows, so every node stays in sight.
  const flow = useRef<ReactFlowInstance<Node<StepData>, Edge> | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => void flow.current?.fitView({ padding: 0.2, maxZoom: 1, duration: 200 }), 50);
    return () => clearTimeout(timer);
  }, [steps.length]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void flow.current?.fitView({ padding: 0.2, maxZoom: 1 }), 150);
    };
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
  const edges = useMemo<Edge[]>(() => {
    const out: Edge[] = [];
    steps.forEach((s, i) => {
      for (const r of references(steps, ops, i)) {
        const src = stepId(steps[r.from]!);
        const id = `${src}->${stepId(s)}:${r.field}:${r.slot}`;
        out.push({
          id,
          source: src,
          sourceHandle: "out",
          target: stepId(s),
          targetHandle: r.field,
          label: r.field === "in" ? undefined : label(r.field),
          animated: runs.get(stepId(s))?.status === "running",
          selected: selectedEdges.has(id),
          className: selectedEdges.has(id) ? "edge selected" : "edge",
        });
      }
    });
    return out;
  }, [steps, ops, runs, selectedEdges, label]);

  const indexOf = (id: string) => steps.findIndex((s) => stepId(s) === id);

  function onEdgesChange(changes: EdgeChange<Edge>[]) {
    setSelectedEdges((cur) => {
      const next = new Set(cur);
      for (const c of changes) {
        if (c.type === "select") {
          if (c.selected) next.add(c.id);
          else next.delete(c.id);
        } else if (c.type === "remove") next.delete(c.id);
      }
      return next;
    });
  }

  function onNodesChange(changes: NodeChange<Node<StepData>>[]) {
    setNodes((ns) => applyNodeChanges(changes, ns));
    const removed = changes.filter((c) => c.type === "remove").map((c) => c.id);
    if (removed.length) props.onChange(steps.filter((s) => !removed.includes(stepId(s))));
    for (const c of changes) if (c.type === "select" && c.selected) props.onSelect(indexOf(c.id));
  }

  function onNodeDragStop(_: unknown, node: Node) {
    props.onChange(steps.map((s) => (stepId(s) === node.id ? { ...s, ui: { ...(s.ui as StepUi), x: Math.round(node.position.x), y: Math.round(node.position.y) } } : s)));
  }

  function onConnect(c: Connection) {
    const from = indexOf(c.source), to = indexOf(c.target);
    if (from < 0 || to < 0 || from === to || !c.targetHandle) return;
    const next = steps.map((s) => ({ ...s }));
    if (next[from]!.out === undefined) next[from]!.out = uniqueName(next, next[from]!.op);
    const name = outName(next[from]!);
    const field = clipFields(ops.get(next[to]!.op)).find((f) => f.name === c.targetHandle);
    if (!field) return;
    if (field.type === "clips") {
      const cur = next[to]![field.name];
      const list = Array.isArray(cur) ? (cur as string[]) : typeof cur === "string" ? [cur] : [];
      next[to]![field.name] = [...list, name];
    } else next[to]![field.name] = name;
    const sorted = topoSort(next, ops);
    if (!sorted) return props.onMessage(t("studio.cycle"));
    props.onChange(sorted);
  }

  function onEdgesDelete(deleted: Edge[]) {
    const next = steps.map((s) => ({ ...s }));
    for (const e of deleted) {
      const to = next.findIndex((s) => stepId(s) === e.target);
      const from = next.findIndex((s) => stepId(s) === e.source);
      if (to < 0 || from < 0 || !e.targetHandle) continue;
      const name = outName(next[from]!);
      const v = next[to]![e.targetHandle];
      if (Array.isArray(v)) {
        const list = (v as string[]).filter((x) => x !== name);
        if (list.length) next[to]![e.targetHandle] = list;
        else delete next[to]![e.targetHandle];
      } else if (v === name) delete next[to]![e.targetHandle];
    }
    props.onChange(topoSort(next, ops) ?? next);
  }

  return (
    <div className="flow" aria-label={t("studio.views.graph")}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onEdgesChange={onEdgesChange}
        onEdgesDelete={onEdgesDelete}
        onInit={(instance) => (flow.current = instance)}
        colorMode={dark ? "dark" : "light"}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.2}
        deleteKeyCode={["Backspace", "Delete"]}
      >
        <Background gap={24} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
