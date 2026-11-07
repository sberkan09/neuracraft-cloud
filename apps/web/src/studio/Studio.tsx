// The workflow editor: every operation and field of the engine's schema, as a node graph, a list or
// JSON. Steps run top to bottom; any step can read a clip made above it. Runs are ordinary jobs.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { engineSchema, type EngineField, type Job } from "@neuracraft/shared";
import { api, type Asset } from "../api";
import { JobCard } from "../pages/JobCard";
import { useErrorText } from "../useError";
import { checkWorkflow, clipsBefore, saveFileFor, type Problem } from "./check";
import { FieldInput, modelsFor, useFieldLabel } from "./FieldInput";
import { GraphCanvas } from "./GraphCanvas";
import { freeSpot, nodeRuns, outName, stepId, topoSort, upstream, withLayout, type Ops, type Step, type Workflow } from "./graph";

const GROUPS = ["input", "image", "video", "3d", "edit", "analysis", "enhance"];
const DRAFT = "nc.studio.draft";
const VIDEO_OPS = new Set(["t2v", "morph", "zoom", "outpaint", "parallax", "interpolate"]);
// What a step makes, for naming its save: a 3D model, a clip of several frames, or a picture.
function kindOf(s: Step | undefined, ops: Ops): "picture" | "video" | "model" {
  if (!s) return "picture";
  if (ops.get(s.op)?.makes === "mesh") return "model";
  if (VIDEO_OPS.has(s.op) || (s.op === "render" && Number(s.frames ?? 1) > 1)) return "video";
  return "picture";
}

export function loadDraft(): Workflow {
  try {
    const wf = JSON.parse(localStorage.getItem(DRAFT) ?? "") as Workflow;
    if (Array.isArray(wf.steps)) return wf;
  } catch {
    /* no draft, or storage unavailable */
  }
  return { steps: [] };
}
function saveDraft(wf: Workflow) {
  try {
    localStorage.setItem(DRAFT, JSON.stringify(wf));
  } catch {
    /* storage may be unavailable */
  }
}

export function Studio(props: { workflow: Workflow; onWorkflow(wf: Workflow): void }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const label = useFieldLabel();
  const ops: Ops = useMemo(() => new Map(engineSchema.ops.map((o) => [o.name, o])), []);
  const title = useCallback((op: string) => t(`studio.ops.${op}`, { defaultValue: ops.get(op)?.title ?? op }), [t, ops]);
  const doc = (op: string) => t(`studio.docs.${op}`, { defaultValue: ops.get(op)?.doc ?? "" });
  const workflow = props.workflow;
  const steps = workflow.steps;
  const [selected, setSelected] = useState(0);
  const [view, setView] = useState<"graph" | "list" | "json">("graph");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [message, setMessage] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pictures, setPictures] = useState<Asset[]>([]);
  const [models, setModels] = useState<Asset[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [credits, setCredits] = useState<number>();
  const importInput = useRef<HTMLInputElement>(null);

  const setWorkflow = useCallback(
    (wf: Workflow) => {
      props.onWorkflow(wf);
      saveDraft(wf);
    },
    [props],
  );
  const setSteps = (next: Step[]) => setWorkflow({ ...workflow, steps: next });

  useEffect(() => {
    Promise.all([api.assets("input"), api.catalog(), api.assets("model"), api.jobs(), api.me()])
      .then(([pics, cat, own, js, me]) => {
        setPictures(pics.assets);
        setModels([...cat.models, ...own.assets.filter((a) => !cat.models.some((m) => m.id === a.id))]);
        setJobs(js.jobs);
        setCredits(me.credits);
      })
      .catch((e) => setSubmitError(errorText(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Every step needs a node id and a position.
  useEffect(() => {
    const laid = withLayout(workflow, ops);
    if (laid !== workflow) setWorkflow(laid);
  }, [workflow, ops, setWorkflow]);
  useEffect(() => {
    if (view !== "json") setJsonText(JSON.stringify(workflow, null, 2));
  }, [workflow, view]);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), 4000);
    return () => clearTimeout(timer);
  }, [message]);

  const laid = useMemo(() => withLayout(workflow, ops).steps, [workflow, ops]);
  const problems = useMemo(() => checkWorkflow(workflow, ops), [workflow, ops]);
  const invalid = useMemo(() => new Set(problems.map((p) => p.step).filter((s) => s >= 0)), [problems]);
  const runs = useMemo(() => nodeRuns(jobs), [jobs]);
  const problemText = (p: Problem) =>
    t(`studio.problem.${p.code}`, { step: p.step + 1, field: p.field ? label(p.field) : "", clip: p.clip ?? "" });

  const update = (i: number, field: string, value: unknown) =>
    setSteps(steps.map((s, j) => {
      if (j !== i) return s;
      const n: Step = { ...s };
      if (value === undefined) delete n[field];
      else n[field] = value;
      return n;
    }));

  function add(opName: string) {
    const op = ops.get(opName);
    if (!op) return;
    const s: Step = { op: opName };
    const used = new Set(steps.map(outName));
    if (op.output) {
      let name = opName, k = 2;
      while (used.has(name)) name = `${opName}${k++}`;
      s.out = name;
    }
    const before = steps.slice(0, Math.min(selected + 1, steps.length));
    const lastClip = [...before].reverse().find((x) => ops.get(x.op)?.output);
    for (const f of op.fields) {
      if (f.type === "model" && f.required) {
        const list = modelsFor(f, models).filter((m) => m.modelKind === f.model);
        const pick = list.find((m) => /turbo/i.test(m.name)) ?? list[0];
        if (pick) s[f.name] = `asset:${pick.id}`;
      }
      if (f.name === "in" && f.type === "clip" && lastClip) s.in = outName(lastClip);
      if (f.name === "in" && f.type === "clips" && lastClip) s.in = [outName(lastClip)];
    }
    if (opName === "load" && pictures[0]) s.path = `asset:${pictures[0].id}`;
    if (opName === "save") s.path = saveFileFor(String(s.in ?? "result"), kindOf(lastClip, ops));
    const at = before.length;
    const anchor = steps[Math.min(selected, steps.length - 1)]?.ui;
    s.ui = freeSpot(steps, anchor ? anchor.x + 300 : 40, anchor ? anchor.y : 40);
    const inserted = [...steps.slice(0, at), s, ...steps.slice(at)];
    const sorted = topoSort(inserted, ops) ?? inserted;
    setSteps(sorted);
    setSelected(sorted.indexOf(s));
  }
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setSteps(next);
    setSelected(j);
  };
  const remove = (i: number) => {
    setSteps(steps.filter((_, j) => j !== i));
    setSelected(Math.max(0, Math.min(i, steps.length - 2)));
  };

  // The whole workflow, or only what step `upTo` needs, with its result saved so it can be seen.
  async function run(upTo?: number) {
    setBusy(true);
    setSubmitError("");
    try {
      let wf: Workflow = workflow;
      if (upTo !== undefined) {
        const keep = upstream(steps, ops, upTo).filter((k) => k === upTo || steps[k]!.op !== "save").map((k) => steps[k]!);
        const target = steps[upTo]!;
        if (target.op !== "save" && ops.get(target.op)?.output) {
          const kind = kindOf(target, ops) === "model" ? "model" : keep.some((s) => kindOf(s, ops) === "video") ? "video" : "picture";
          keep.push({ op: "save", in: outName(target), path: saveFileFor(outName(target), kind) });
        }
        wf = { ...workflow, steps: keep };
      }
      const r = await api.submit(wf);
      setJobs((j) => [r.job, ...j]);
      setCredits((await api.me()).credits);
    } catch (e) {
      setSubmitError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(workflow, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "workflow.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }
  async function importJson(file?: File) {
    if (!file) return;
    try {
      const wf = JSON.parse(await file.text()) as Workflow;
      if (!Array.isArray(wf.steps)) throw new Error(t("studio.noSteps"));
      setWorkflow(wf);
      setSelected(0);
    } catch (e) {
      setMessage(t("studio.importFailed", { reason: (e as Error).message }));
    }
  }

  const sel = steps[selected];
  const selOp = sel ? ops.get(sel.op) : undefined;
  const fieldFor = (f: EngineField): EngineField => (sel?.op === "save" && f.name === "path" ? { ...f, type: "string" } : f);
  const blocking = problems.length > 0;
  const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

  return (
    <div className="studio">
      <nav className="palette card" aria-label={t("studio.addStep")}>
        <h2>{t("studio.addStep")}</h2>
        {GROUPS.map((g) => {
          const list = [...ops.values()].filter((o) => o.group === g);
          return list.length ? (
            <div key={g} className="palette-group">
              <small className="muted">{t(`studio.groups.${g}`, { defaultValue: g })}</small>
              <div className="palette-ops">
                {list.map((o) => (
                  <button key={o.name} type="button" className="ghost small" title={doc(o.name)} onClick={() => add(o.name)}>
                    {title(o.name)}
                  </button>
                ))}
              </div>
            </div>
          ) : null;
        })}
      </nav>

      <section className="canvas card" aria-label={t("studio.workflow")}>
        <div className="toolbar">
          <div className="segmented" role="group" aria-label={t("studio.view")}>
            {(["graph", "list", "json"] as const).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>
                {t(`studio.views.${v}`)}
              </button>
            ))}
          </div>
          <span className="muted">{t("studio.stepCount", { count: steps.length })}</span>
          <span className="grow" />
          <button type="button" className="ghost small" onClick={() => importInput.current?.click()}>{t("studio.import")}</button>
          <button type="button" className="ghost small" disabled={!steps.length} onClick={exportJson}>{t("studio.export")}</button>
          <button type="button" className="ghost small" disabled={!steps.length} onClick={() => { setWorkflow({ steps: [] }); setSelected(0); }}>
            {t("studio.clear")}
          </button>
          <input ref={importInput} type="file" accept="application/json,.json" hidden onChange={(e) => void importJson(e.target.files?.[0])} />
        </div>
        {message ? <p className="error" role="alert">{message}</p> : null}
        {view === "graph" ? (
          steps.length === 0 ? (
            <div className="empty muted">{t("studio.emptyGraph")}</div>
          ) : (
            <GraphCanvas steps={laid} ops={ops} runs={runs} invalid={invalid} selected={selected} title={title}
              onSelect={(i) => i >= 0 && setSelected(i)} onChange={setSteps} onMessage={setMessage} />
          )
        ) : view === "json" ? (
          <>
            <textarea className="json" aria-label={t("studio.views.json")} spellCheck={false} value={jsonText}
              onChange={(e) => {
                setJsonText(e.target.value);
                try {
                  const wf = JSON.parse(e.target.value) as Workflow;
                  if (!Array.isArray(wf.steps)) throw new Error(t("studio.noSteps"));
                  setJsonError("");
                  setWorkflow(wf);
                } catch (err) {
                  setJsonError((err as Error).message);
                }
              }} />
            {jsonError ? <p className="error">{jsonError}</p> : null}
          </>
        ) : (
          <ol className="step-list">
            {steps.length === 0 ? <li className="muted">{t("studio.emptyGraph")}</li> : null}
            {steps.map((s, i) => (
              <li key={stepId(s) || i} className={`${i === selected ? "selected" : ""} ${invalid.has(i) ? "invalid" : ""}`}>
                <button type="button" className="link" onClick={() => setSelected(i)}>
                  {i + 1}. {title(s.op)}{ops.get(s.op)?.output ? ` → ${outName(s)}` : ""}
                </button>
                <span className="row">
                  <button type="button" className="ghost small" aria-label={t("studio.moveUp")} onClick={() => move(i, -1)}>↑</button>
                  <button type="button" className="ghost small" aria-label={t("studio.moveDown")} onClick={() => move(i, 1)}>↓</button>
                  <button type="button" className="ghost small" aria-label={t("studio.remove")} onClick={() => remove(i)}>×</button>
                </span>
              </li>
            ))}
          </ol>
        )}
        <div className="runbar">
          {problems.length ? (
            <ul className="problems">{problems.slice(0, 5).map((p, k) => <li key={k}>{problemText(p)}</li>)}</ul>
          ) : null}
          {submitError ? <p className="error" role="alert">{submitError}</p> : null}
          <span className="grow" />
          {credits !== undefined ? <span className="pill">{t("home.creditsValue", { value: fmt.format(credits / 1000) })}</span> : null}
          <button type="button" disabled={busy || !steps.length || blocking} onClick={() => void run()}>{t("studio.runAll")}</button>
        </div>
      </section>

      <aside className="inspector card" aria-label={t("studio.selectedStep")}>
        {sel && selOp ? (
          <>
            <small className="muted">{t("studio.stepNumber", { n: selected + 1 })} · {sel.op}</small>
            <h2>{title(sel.op)}</h2>
            <p className="muted doc">{doc(sel.op)}</p>
            <button type="button" className="ghost small" disabled={busy || problems.some((p) => upstream(steps, ops, selected).includes(p.step))}
              title={t("studio.runToHereHint")} onClick={() => void run(selected)}>
              {t("studio.runToHere")}
            </button>
            {selOp.output ? (
              <label htmlFor="insp-out">
                <span className="field-label">{label("out")}</span>
                <input id="insp-out" value={sel.out ?? ""} placeholder={sel.op} onChange={(e) => update(selected, "out", e.target.value || undefined)} />
              </label>
            ) : null}
            {selOp.fields.filter((f) => f.name !== "out").map((f) => (
              <FieldInput key={`${selected}-${f.name}`} id={`insp-${f.name}`} op={sel.op} field={fieldFor(f)} value={sel[f.name]} clips={clipsBefore(steps, ops, selected)}
                models={models} pictures={pictures} onPicture={(a) => setPictures((p) => [a, ...p])} onChange={(v) => update(selected, f.name, v)} />
            ))}
          </>
        ) : (
          <p className="muted">{t("studio.pickStep")}</p>
        )}
      </aside>

      <section className="card studio-jobs">
        <h2>{t("home.jobs")}</h2>
        {jobs.length === 0 ? <p className="muted">{t("home.noJobs")}</p> : null}
        {jobs.slice(0, 8).map((j) => (
          <JobCard key={j.id} job={j}
            onChange={(nj) => setJobs((all) => all.map((x) => (x.id === nj.id ? nj : x)))}
            onFinished={() => api.me().then((m) => setCredits(m.credits)).catch(() => {})}
            onOpen={(wf) => { setWorkflow(wf as Workflow); setSelected(0); }} />
        ))}
      </section>
    </div>
  );
}
