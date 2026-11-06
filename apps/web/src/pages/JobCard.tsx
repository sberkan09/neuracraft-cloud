import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { finishedStates, type Job } from "@neuracraft/shared";
import { api } from "../api";

export function JobCard({ job, onChange, onFinished }: { job: Job; onChange: (j: Job) => void; onFinished: () => void }) {
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
  return (
    <article className={`job ${job.state}`}>
      <div className="row spread">
        <strong>{t(`job.state.${job.state}`)}</strong>
        <time className="muted" dateTime={job.createdAt}>
          {new Date(job.createdAt).toLocaleString(i18n.language)}
        </time>
      </div>
      {!finished && (
        <>
          <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
            <div style={{ width: `${Math.round(fraction * 100)}%` }} />
          </div>
          {p && <small className="muted">{t("job.step", { step: p.step, steps: p.steps, op: p.op })}</small>}
          <button className="ghost" onClick={() => api.cancel(job.id).catch(() => {})}>
            {t("home.cancel")}
          </button>
        </>
      )}
      {job.error && <p className="error">{t(`errors.${job.error.code}`, { reason: job.error.detail ?? "", defaultValue: job.error.detail ?? job.error.code })}</p>}
      {job.outputs.length > 0 && (
        <div className="outputs">
          {job.outputs.map((o) => (
            <a key={o.assetId} href={api.content(o.assetId)} target="_blank" rel="noreferrer" className="output">
              {o.kind === "image" ? <img src={api.content(o.assetId)} alt={o.name} /> : <span>{o.name}</span>}
              <small>{t("home.download")}</small>
            </a>
          ))}
        </div>
      )}
      {job.workerSeconds != null && <small className="muted">{t("job.seconds", { value: fmt.format(job.workerSeconds) })}</small>}
    </article>
  );
}
