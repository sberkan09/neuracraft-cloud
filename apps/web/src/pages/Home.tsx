import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Job } from "@neuracraft/shared";
import { api, isModelFile, type Asset } from "../api";
import { tasks } from "../tasks";
import { useErrorText } from "../useError";
import { JobCard } from "./JobCard";

export function Home({ openStudio }: { openStudio: (workflow: unknown) => void }) {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const [credits, setCredits] = useState(0);
  const [pictures, setPictures] = useState<Asset[]>([]);
  const [models, setModels] = useState<Asset[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [picture, setPicture] = useState("");
  const [taskId, setTaskId] = useState(tasks[0]!.id);
  const [model, setModel] = useState("");
  const [custom, setCustom] = useState("");
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const [me, inputs, cat, js] = await Promise.all([api.me(), api.assets("input"), api.catalog(), api.jobs()]);
    const pics = { assets: inputs.assets.filter((a) => !isModelFile(a)) };
    setCredits(me.credits);
    setPictures(pics.assets);
    setModels(cat.models);
    setJobs(js.jobs);
    setPicture((p) => p || pics.assets[0]?.id || "");
  }, []);
  useEffect(() => {
    refresh().catch((e) => setError(errorText(e)));
  }, [refresh]);

  const task = tasks.find((x) => x.id === taskId)!;
  const usable = useMemo(() => models.filter((m) => !task.modelKind || m.modelKind === task.modelKind), [models, task]);
  useEffect(() => {
    if (task.modelKind && !usable.some((m) => m.id === model)) setModel(usable[0]?.id ?? "");
  }, [task, usable, model]);
  useEffect(() => {
    if (taskId === "custom") setCustom(JSON.stringify(task.workflow(picture || "<picture id>"), null, 2));
  }, [taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = async (f: File) => {
    setUploading(true);
    setError("");
    try {
      const a = await api.uploadPicture(f);
      setPictures((p) => [a, ...p]);
      setPicture(a.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setUploading(false);
    }
  };

  const run = async () => {
    setError("");
    try {
      const wf = taskId === "custom" ? JSON.parse(custom) : task.workflow(picture, model);
      const r = await api.submit(wf);
      setJobs((j) => [r.job, ...j]);
      setCredits((await api.me()).credits);
    } catch (e) {
      setError(e instanceof SyntaxError ? t("errors.workflow.invalid", { reason: e.message }) : errorText(e));
    }
  };

  const fmt = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 });
  const canRun = taskId === "custom" ? custom.trim().length > 0 : !!picture && (!task.modelKind || !!model);

  const picked = pictures.find((x) => x.id === picture);
  const license = usable.find((m) => m.id === model)?.license;
  const openInStudio = () => {
    try {
      openStudio(taskId === "custom" ? JSON.parse(custom) : task.workflow(picture || "", model));
    } catch (e) {
      setError(t("errors.workflow.invalid", { reason: (e as Error).message }));
    }
  };

  return (
    <div className="home-page">
      <div className="page-head">
        <h1>{t("home.jobs")}</h1>
      </div>
      <div className="home">
        <div className="home-main">
          {taskId === "custom" && (
            <div className="custom-json">
              <label>
                {t("home.workflowJson")}
                <textarea rows={12} spellCheck={false} value={custom} onChange={(e) => setCustom(e.target.value)} />
              </label>
            </div>
          )}
          <section className="jobs" aria-label={t("home.jobs")}>
            {jobs.length === 0 && <p className="muted card">{t("home.noJobs")}</p>}
            {jobs.map((j) => (
              <JobCard key={j.id} job={j} onChange={(nj) => setJobs((all) => all.map((x) => (x.id === nj.id ? nj : x)))} onFinished={() => api.me().then((m) => setCredits(m.credits))} onOpen={openStudio} />
            ))}
          </section>
        </div>

        <aside className="home-aside">
          <section className="card stat-pair">
            <div>
              <div className="label">{t("home.credits")}</div>
              <div className="big">{fmt.format(credits / 1000)}</div>
            </div>
            <div>
              <div className="label">{t("home.jobs")}</div>
              <div className="big">{jobs.length}</div>
            </div>
          </section>
          <section className="card">
            <h2>{t("home.pictures")}</h2>
            <div className="pictures">
              {pictures.map((p) => (
                <button key={p.id} className={`thumb ${p.id === picture ? "selected" : ""}`} aria-pressed={p.id === picture} onClick={() => setPicture(p.id)} title={p.name}>
                  <img src={api.content(p.id)} alt={p.name} loading="lazy" />
                </button>
              ))}
            </div>
            {pictures.length === 0 && <p className="muted">{t("home.noPictures")}</p>}
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            <button className="ghost" onClick={() => fileInput.current?.click()} disabled={uploading}>
              {uploading ? t("home.uploading") : t("home.upload")}
            </button>
          </section>
        </aside>
      </div>

      <form className="runbar-float glass" aria-label={t("home.run")} onSubmit={(e) => (e.preventDefault(), void run())}>
        {(error || license) && (
          <div className="runbar-row">
            {error ? <p className="error" role="alert">{error}</p> : <small className="muted">{t("home.license", { license })}</small>}
          </div>
        )}
        <div className="runbar-row">
          {picked && (
            <span className="picked">
              <img src={api.content(picked.id)} alt="" />
              <span>{picked.name}</span>
            </span>
          )}
          {picked && <span className="sep" aria-hidden="true" />}
          <label>
            {t("home.task")}
            <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              {tasks.map((x) => (
                <option key={x.id} value={x.id}>
                  {t(`tasks.${x.id}`)}
                </option>
              ))}
            </select>
          </label>
          {task.modelKind && (
            <label>
              {t("home.model")}
              {usable.length ? (
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  {usable.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="muted">{t("home.noModels")}</span>
              )}
            </label>
          )}
          <span className="grow" />
          <span className="actions row">
            <button type="button" className="ghost" onClick={openInStudio}>
              {t("studio.editInStudio")}
            </button>
            <button type="submit" disabled={!canRun}>
              {t("home.run")}
            </button>
          </span>
        </div>
      </form>
    </div>
  );
}
