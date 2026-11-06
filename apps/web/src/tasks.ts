// Ready-made tasks: each turns the chosen picture (and model) into a workflow.
export interface Task {
  id: string;
  modelKind?: string; // needs a catalog model of this kind
  workflow(picture: string, model?: string): unknown;
}

export const tasks: Task[] = [
  {
    id: "removeBackground",
    modelKind: "onnx",
    workflow: (p, m) => ({
      steps: [
        { op: "load", path: `asset:${p}`, out: "picture" },
        { op: "onnx", model: `asset:${m}`, in: "picture", apply: true, out: "cutout" },
        { op: "save", in: "cutout", path: "cutout.png" },
      ],
    }),
  },
  {
    id: "edges",
    workflow: (p) => ({
      steps: [
        { op: "load", path: `asset:${p}`, out: "picture" },
        { op: "canny", in: "picture", out: "edges" },
        { op: "save", in: "edges", path: "edges.png" },
      ],
    }),
  },
  {
    id: "resize",
    workflow: (p) => ({
      steps: [
        { op: "load", path: `asset:${p}`, out: "picture" },
        { op: "resize", in: "picture", width: 512, height: 512, out: "resized" },
        { op: "save", in: "resized", path: "resized.png" },
      ],
    }),
  },
  { id: "custom", workflow: (p) => ({ steps: [{ op: "load", path: `asset:${p}`, out: "picture" }] }) },
];
