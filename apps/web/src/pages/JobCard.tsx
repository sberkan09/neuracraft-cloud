import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { finishedStates, type Job } from "@neuracraft/shared";
import { api } from "../api";
import { ModelView } from "../ModelView";

export function JobCard({ job, onChange, onFinished, onOpen }: { job: Job; onChange: (j: Job) => void; onFinished: () => void; onOpen?: (workflow: unknown) => void }) {
  const { t, i18n } = useTranslation();
  const finished = finishedStates.includes(job.state);

  useEffect(() => {
    if (finished) return;
    let current = job;
    const stop = api.watch(job.id, (e) => {
      if (e.type === "job") current = e.job;
      else if (e.type === "state") current = { ...current, state: e.state };
      else if (e.type === "progress") current = { ...current, progress: e.progress };
      else if (e.type === "output") current = { ...current, outputs: [...current.outputs, e.output] };
      else if (e.type === "error") current = { ...current, error: e.error };
      onChange(current);
      if (finishedStates.includes(current.state)) {
        stop();
        onFinished();
      }
    });
    return stop;
  }, [job.id, finished]); // eslint-disable-line react-hooks/exhaustive-deps

  const p = job.progress;
  const fraction = job.state === "succeeded" ? 1 : p && p.steps ? (p.step - 1 + Math.max(0, p.fraction)) / p.steps : 0;
  const fmt = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
  const ops = workflowOps(job.workflow);
  const stepState = (i: number): string => {
    if (job.state === "succeeded") return "done";
    if (!p) return job.state === "failed" && i === ops.length - 1 ? "failed" : "pending";
    const current = p.step - 1;
    if (i < current) return "done";
    if (i === current) return job.state === "failed" ? "failed" : finished ? "pending" : "active";
    return "pending";
  };
  let figure = 0;
  return (
    <article className={`job ${job.state}`}>
      <div className="job-head">
        <span className="id">
          {job.id.slice(0, 8)} ·{" "}
          <time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" })}</time>
        </span>
        {job.gpu?.type && <span className="id">{job.gpu.type}{job.gpu.region ? ` · ${job.gpu.region}` : ""}</span>}
      </div>
      <h3 className="job-title">{t(`job.state.${job.state}`)}</h3>
      {ops.length > 0 && ops.length <= 12 && (
        <ol className="pipeline" aria-label={t("job.pipeline")}>
          {ops.map((op, i) => (
            <li key={i} className={stepState(i)} aria-current={stepState(i) === "active" ? "step" : undefined}>
              <span className="node-dot">{stepState(i) === "done" ? "✓" : stepState(i) === "failed" ? "✕" : String(i + 1).padStart(2, "0")}</span>
              <strong>{op}</strong>
            </li>
          ))}
        </ol>
      )}
      {!finished && (
        <>
          <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
            <div style={{ width: `${Math.round(fraction * 100)}%` }} />
          </div>
          {p && <small className="muted mono">{t("job.step", { step: p.step, steps: p.steps, op: p.op })}</small>}
        </>
      )}
      {job.error && <p className="error">{t(`errors.${job.error.code}`, { reason: job.error.detail ?? "", defaultValue: job.error.detail ?? job.error.code })}</p>}
      {job.outputs.length > 0 && (
        <div className="outputs">
          {job.outputs.map((o) => {
            figure += 1;
            const caption = `FIG. ${figure} — ${o.name}`;
            return o.kind === "model" ? (
              <figure key={o.assetId} className="output">
                <ModelView src={api.content(o.assetId)} label={o.name} />
                <figcaption className="fig">
                  <span>{caption}</span>
                  <a href={api.content(o.assetId)} download={o.name}>{t("home.download")}</a>
                </figcaption>
              </figure>
            ) : (
              <figure key={o.assetId} className="output">
                <a href={api.content(o.assetId)} target="_blank" rel="noreferrer">
                  {o.kind === "image" ? <img src={api.content(o.assetId)} alt={o.name} /> : <span>{o.name}</span>}
                </a>
                <figcaption className="fig">
                  <span>{caption}</span>
                  <a href={api.content(o.assetId)} download={o.name}>{t("home.download")}</a>
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}
      <div className="job-meta">
        {job.workerSeconds != null && <span>{t("job.seconds", { value: fmt.format(job.workerSeconds) })}</span>}
        {!finished && (
          <button className="link" onClick={() => api.cancel(job.id).catch(() => {})}>
            {t("home.cancel")}
          </button>
        )}
        {onOpen && job.workflow ? (
          <button className="link" onClick={() => onOpen(job.workflow)}>
            {t("studio.openInStudio")}
          </button>
        ) : null}
      </div>
    </article>
  );
}

// The op of each step, for the pipeline row (an unknown shape shows none).
function workflowOps(workflow: unknown): string[] {
  const steps = (workflow as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return [];
  return steps.map((s) => (s && typeof s === "object" && typeof (s as { op?: unknown }).op === "string" ? (s as { op: string }).op : "?"));
}
