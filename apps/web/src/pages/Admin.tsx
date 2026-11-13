// The operator console (#admin): the state of the whole service, across accounts. A partner such as
// GM Cebi is one account with its own end users. Metadata of every account; pictures and texts only of
// accounts that granted support access, or under an open report (the API decides, and logs each view).
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type AdminAccount, type AdminAccountRow, type AdminAuditEntry, type AdminJob, type AdminOverview, type AdminReport } from "../api";
import { useErrorText } from "../useError";

type Tab = "overview" | "accounts" | "jobs" | "reports" | "audit";
const TABS: Tab[] = ["overview", "accounts", "jobs", "reports", "audit"];

export function Admin() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("overview");
  const [account, setAccount] = useState<string | null>(null);
  const [jobFilter, setJobFilter] = useState<Record<string, string>>({});
  const openJobs = (f: Record<string, string>) => {
    setJobFilter(f);
    setTab("jobs");
  };
  const openAccount = (id: string) => {
    setAccount(id);
    setTab("accounts");
  };
  return (
    <div className="admin">
      <nav className="segmented admin-tabs" aria-label={t("admin.title")}>
        {TABS.map((x) => (
          <button key={x} type="button" aria-pressed={tab === x} onClick={() => (setTab(x), x === "accounts" && setAccount(null))}>
            {t(`admin.tabs.${x}`)}
          </button>
        ))}
      </nav>
      {tab === "overview" && <Overview openAccount={openAccount} openReports={() => setTab("reports")} />}
      {tab === "accounts" && (account ? <AccountView id={account} back={() => setAccount(null)} openJobs={openJobs} /> : <Accounts open={setAccount} />)}
      {tab === "jobs" && <Jobs filter={jobFilter} setFilter={setJobFilter} />}
      {tab === "reports" && <Reports />}
      {tab === "audit" && <Audit />}
    </div>
  );
}

// ---- helpers ----

function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const errorText = useErrorText();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => {
    setError("");
    return load().then(setData, (e) => setError(errorText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => void reload(), [reload]);
  return { data, error, reload, setError };
}

function useFormat() {
  const { i18n } = useTranslation();
  return {
    date: (s: string | null | undefined) => (s ? new Date(s).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" }) : "—"),
    usd: (n: number | null | undefined) => (n === null || n === undefined ? "—" : `$${n.toFixed(n < 1 ? 3 : 2)}`),
    num: (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? "—" : n.toFixed(digits)),
  };
}

function Budget({ label, spent, limit }: { label: string; spent: number; limit: number | null }) {
  const f = useFormat();
  const pct = limit ? Math.min(100, (spent / limit) * 100) : 0;
  return (
    <div className="budget">
      <div className="row spread">
        <span>{label}</span>
        <strong>
          {f.usd(spent)} <span className="muted">/ {limit === null ? "∞" : f.usd(limit)}</span>
        </strong>
      </div>
      {limit !== null && (
        <div className={`bar ${pct >= 90 ? "warn" : ""}`}>
          <div style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

// ---- Overview ----

function Overview({ openAccount, openReports }: { openAccount: (id: string) => void; openReports: () => void }) {
  const { t } = useTranslation();
  const f = useFormat();
  const { data, error, reload } = useLoad<AdminOverview>(() => api.admin.overview(), []);
  useEffect(() => {
    const timer = setInterval(() => void reload(), 30_000);
    return () => clearInterval(timer);
  }, [reload]);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">{t("admin.loading")}</p>;
  const c = data.capacity;
  return (
    <div className="admin-grid">
      <section className="card">
        <h2>{t("admin.overview.gpus")}</h2>
        {!c.provider && c.pods.length === 0 && <p className="muted">{t("admin.overview.noProvider")}</p>}
        {c.provider && c.pods.length === 0 && <p className="muted">{t("admin.overview.noPods", { max: c.maxPods })}</p>}
        <ul className="plain">
          {c.pods.map((p) => (
            <li key={p.id}>
              <strong>{p.gpu_type ?? t("admin.overview.renting")}</strong> {p.region && <span className="muted">· {p.region}</span>}{" "}
              <span className={`state ${p.state === "running" ? "running" : ""}`}>{t(`admin.podState.${p.state}`, { defaultValue: p.state })}</span>
              <br />
              <small className="muted">
                {t("admin.overview.since", { at: f.date(p.requested_at) })}
                {p.price_per_hour !== null && ` · ${f.usd(p.price_per_hour)}/${t("admin.hour")}`}
                {p.error && ` · ${p.error}`}
              </small>
            </li>
          ))}
        </ul>
      </section>
      <section className="card">
        <h2>{t("admin.overview.spend")}</h2>
        <Budget label={t("admin.overview.today")} spent={c.spend.todayUsd} limit={c.spend.dailyBudgetUsd} />
        <Budget label={t("admin.overview.month")} spent={c.spend.monthUsd} limit={c.spend.monthlyBudgetUsd} />
        <p className="muted small-print">{t("admin.overview.spendNote")}</p>
      </section>
      <section className="card">
        <h2>{t("admin.overview.sessions")}</h2>
        {data.sessions.length === 0 && <p className="muted">{t("admin.overview.noSessions")}</p>}
        <ul className="plain">
          {data.sessions.map((s) => (
            <li key={s.user_id}>
              <button className="link" onClick={() => openAccount(s.user_id)}>{s.email}</button> · {t("admin.overview.openCount", { count: s.open })}
              <br />
              <small className="muted">{t("admin.overview.lastSeen", { at: f.date(s.last_seen) })}</small>
            </li>
          ))}
        </ul>
      </section>
      <section className="card wide-card">
        <h2>{t("admin.overview.jobs24h")}</h2>
        {data.jobs24h.length === 0 && <p className="muted">{t("admin.overview.noJobs")}</p>}
        {data.jobs24h.length > 0 && (
          <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t("admin.accountLabel")}</th>
                <th>{t("admin.overview.total")}</th>
                <th>{t("admin.overview.ok")}</th>
                <th>{t("admin.overview.failed")}</th>
                <th>{t("admin.overview.active")}</th>
              </tr>
            </thead>
            <tbody>
              {data.jobs24h.map((r) => (
                <tr key={r.user_id}>
                  <td><button className="link" onClick={() => openAccount(r.user_id)}>{r.email}</button></td>
                  <td>{r.total}</td>
                  <td>{r.succeeded}</td>
                  <td className={r.failed ? "error" : ""}>{r.failed}</td>
                  <td>{r.active}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        {data.openReports > 0 && (
          <p className="notice">
            <button className="link" onClick={openReports}>{t("admin.overview.openReports", { count: data.openReports })}</button>
          </p>
        )}
      </section>
      <section className="card wide-card">
        <h2>{t("admin.overview.events")}</h2>
        {data.events.length === 0 && <p className="muted">{t("admin.overview.noEvents")}</p>}
        <ul className="events">
          {data.events.map((e, i) => (
            <li key={i}>
              <span className="muted">{f.date(e.at)}</span> <code>{e.kind}</code> <small className="muted">{eventDetail(e.detail)}</small>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

const eventDetail = (d: Record<string, unknown>) =>
  Object.entries(d)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" · ")
    .slice(0, 200);

// ---- Accounts ----

function Accounts({ open }: { open: (id: string) => void }) {
  const { t } = useTranslation();
  const f = useFormat();
  const [q, setQ] = useState("");
  const { data, error } = useLoad(() => api.admin.accounts(), []);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">{t("admin.loading")}</p>;
  const rows = data.accounts.filter((a) => a.email.includes(q.trim().toLowerCase()));
  return (
    <section className="card">
      <div className="row spread">
        <h2>{t("admin.accounts.title", { count: data.accounts.length })}</h2>
        <input placeholder={t("admin.accounts.search")} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t("admin.accountLabel")}</th>
              <th>{t("admin.accounts.credits")}</th>
              <th>{t("admin.accounts.endUsers")}</th>
              <th>{t("admin.accounts.jobs7d")}</th>
              <th>{t("admin.accounts.lastJob")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td>
                  <button className="link" onClick={() => open(a.id)}>{a.email}</button> <Badges a={a} />
                </td>
                <td>{f.num(a.credits, 0)}</td>
                <td>{a.partner ? a.signed_in_end_users : "—"}</td>
                <td>{a.jobs_7d}</td>
                <td>{f.date(a.last_job_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Badges({ a }: { a: AdminAccountRow }) {
  const { t } = useTranslation();
  const support = a.support_access_until && new Date(a.support_access_until) > new Date();
  return (
    <>
      {a.partner && <span className="pill">{t("admin.badges.partner")}</span>}
      {a.operator && <span className="pill">{t("admin.badges.operator")}</span>}
      {support && <span className="pill ok">{t("admin.badges.support")}</span>}
      {a.flagged_at && <span className="pill bad">{t("admin.badges.flagged")}</span>}
    </>
  );
}

function AccountView({ id, back, openJobs }: { id: string; back: () => void; openJobs: (f: Record<string, string>) => void }) {
  const { t } = useTranslation();
  const f = useFormat();
  const errorText = useErrorText();
  const { data, error, reload, setError } = useLoad<AdminAccount>(() => api.admin.account(id), [id]);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">{t("admin.loading")}</p>;
  const a = data.account;
  const support = a.support_access_until && new Date(a.support_access_until) > new Date();
  const act = (p: Promise<unknown>) => void p.then(() => reload()).catch((e) => setError(errorText(e)));
  const max = Math.max(1, ...data.daily.map((d) => d.jobs));
  return (
    <div className="admin-grid">
      <section className="card wide-card">
        <div className="row spread">
          <h2>
            {a.email} <Badges a={a} />
          </h2>
          <div className="row">
            <button className="ghost small" onClick={() => openJobs({ account: id })}>{t("admin.account.jobs")}</button>
            <button className="ghost small" onClick={back}>{t("admin.back")}</button>
          </div>
        </div>
        <p className="muted">
          {t("admin.account.summary", { created: f.date(a.created_at), credits: f.num(a.credits, 0), plan: a.plan })}
          {a.flag_note && ` · ${a.flag_note}`}
        </p>
        <div className="notice">
          {support ? (
            <>
              {t("admin.account.supportOn", { until: f.date(a.support_access_until) })} {a.support_access_note && <em>({a.support_access_note})</em>}{" "}
              <button className="ghost small" onClick={() => act(api.admin.endSupportAccess(id))}>{t("admin.account.endSupport")}</button>
            </>
          ) : (
            t("admin.account.supportOff")
          )}
        </div>
      </section>
      {data.partner && (
        <section className="card">
          <h2>{t("admin.account.partner")}</h2>
          <dl className="facts">
            {Object.entries(data.partner).map(([k, v]) => (
              <div key={k}>
                <dt>{t(`admin.partnerKeys.${k}`, { defaultValue: k })}</dt>
                <dd>{v === null ? "—" : String(v)}</dd>
              </div>
            ))}
          </dl>
          {data.clients.length > 0 && (
            <>
              <h3>{t("admin.account.clients")}</h3>
              <ul className="plain">
                {data.clients.map((c) => (
                  <li key={c.id}>
                    <code>{c.id}</code> {c.name} {!c.enabled && <span className="pill bad">{t("admin.account.disabled")}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      <section className="card">
        <h2>{t("admin.account.daily")}</h2>
        {data.daily.length === 0 && <p className="muted">{t("admin.overview.noJobs")}</p>}
        <ul className="daily">
          {data.daily.map((d) => (
            <li key={d.day}>
              <span className="muted">{new Date(d.day).toLocaleDateString()}</span>
              <div className="bar">
                <div style={{ width: `${(d.jobs / max) * 100}%` }} />
              </div>
              <span>
                {d.jobs}
                {d.failed > 0 && <span className="error"> ({d.failed})</span>}
              </span>
            </li>
          ))}
        </ul>
      </section>
      {data.endUsers.length > 0 && (
        <section className="card wide-card">
          <h2>{t("admin.account.endUsers", { count: data.endUsers.length })}</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("admin.endUser")}</th>
                  <th>{t("admin.account.signedUp")}</th>
                  <th>{t("admin.account.lastSeen")}</th>
                  <th>{t("admin.account.jobs24h")}</th>
                  <th>{t("admin.account.jobsTotal")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.endUsers.map((e) => (
                  <tr key={e.end_user} className={e.blocked_at ? "muted" : ""}>
                    <td>
                      <button className="link" onClick={() => openJobs({ account: id, endUser: e.end_user })}><code>{e.end_user}</code></button>
                    </td>
                    <td>{f.date(e.created_at)}</td>
                    <td>{f.date(e.last_seen_at)}</td>
                    <td>{e.jobs_24h}</td>
                    <td>{e.jobs_total}</td>
                    <td>
                      <button className="ghost small" onClick={() => act(api.admin.block(id, e.end_user, !e.blocked_at))}>
                        {e.blocked_at ? t("admin.account.unblock") : t("admin.account.block")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <section className="card">
        <h2>{t("admin.account.tokens")}</h2>
        {data.tokens.length === 0 && <p className="muted">{t("admin.account.noTokens")}</p>}
        <ul className="plain">
          {data.tokens.map((k) => (
            <li key={k.id} className={k.revoked_at ? "muted" : ""}>
              <strong>{k.name}</strong> <code>{k.prefix}…</code> <span className="pill">{k.kind}</span>
              <br />
              <small className="muted">
                {t("admin.account.lastUsed", { at: f.date(k.last_used_at) })}
                {k.revoked_at && ` · ${t("tokens.revoked")}`}
              </small>
            </li>
          ))}
        </ul>
      </section>
      <section className="card">
        <h2>{t("admin.account.ledger")}</h2>
        <ul className="plain">
          {data.ledger.map((l, i) => (
            <li key={i}>
              <code>{l.kind}</code> {f.num(l.credits, 1)} <small className="muted">· {f.date(l.created_at)}{l.reference ? ` · ${l.reference}` : ""}</small>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ---- Jobs ----

function Jobs({ filter, setFilter }: { filter: Record<string, string>; setFilter: (f: Record<string, string>) => void }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const accounts = useLoad(() => api.admin.accounts(), []);
  const [jobs, setJobs] = useState<AdminJob[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(
    (before?: string) =>
      api.admin
        .jobs({ ...filter, limit: "24", ...(before ? { before } : {}) })
        .then((r) => {
          setJobs((old) => (before && old ? [...old, ...r.jobs] : r.jobs));
          setMore(r.jobs.length === 24);
        })
        .catch((e) => setError(errorText(e))),
    [filter, errorText],
  );
  useEffect(() => {
    setJobs(null);
    void load();
  }, [load]);
  const set = (k: string, v: string) => {
    const next = { ...filter };
    if (v) next[k] = v;
    else delete next[k];
    setFilter(next);
  };
  return (
    <section className="card">
      <div className="filters">
        <label>
          {t("admin.accountLabel")}
          <select value={filter.account ?? ""} onChange={(e) => set("account", e.target.value)}>
            <option value="">{t("admin.jobs.all")}</option>
            {accounts.data?.accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.email}</option>
            ))}
          </select>
        </label>
        <label>
          {t("admin.endUser")}
          <input value={filter.endUser ?? ""} onChange={(e) => set("endUser", e.target.value.trim())} placeholder="eu_… / install id" />
        </label>
        <label>
          {t("admin.jobs.state")}
          <select value={filter.state ?? ""} onChange={(e) => set("state", e.target.value)}>
            <option value="">{t("admin.jobs.all")}</option>
            {["queued", "running", "succeeded", "failed", "cancelled"].map((s) => (
              <option key={s} value={s}>{t(`admin.jobState.${s}`)}</option>
            ))}
          </select>
        </label>
        <label>
          {t("admin.jobs.regions")}
          <select value={filter.regions ?? ""} onChange={(e) => set("regions", e.target.value)}>
            <option value="">{t("admin.jobs.all")}</option>
            <option value="true">{t("admin.jobs.withRegions")}</option>
            <option value="false">{t("admin.jobs.withoutRegions")}</option>
          </select>
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      {!jobs && !error && <p className="muted">{t("admin.loading")}</p>}
      {jobs?.length === 0 && <p className="muted">{t("admin.jobs.none")}</p>}
      <div className="job-grid">
        {jobs?.map((j) => (
          <JobItem key={j.id} j={j} />
        ))}
      </div>
      {more && jobs && (
        <button className="ghost" onClick={() => void load(jobs[jobs.length - 1]!.createdAt)}>{t("admin.jobs.more")}</button>
      )}
    </section>
  );
}

function JobItem({ j }: { j: AdminJob }) {
  const { t } = useTranslation();
  const f = useFormat();
  const pics = j.pictures ?? {};
  return (
    <article className={`job-item ${j.state}`}>
      <header className="row spread">
        <strong>{f.date(j.createdAt)}</strong>
        <span className={`state ${j.state === "succeeded" ? "done" : j.state === "failed" ? "failed" : ""}`}>{t(`admin.jobState.${j.state}`, { defaultValue: j.state })}</span>
      </header>
      <div className="muted small-print">
        {j.account.email}
        {j.endUser && <> · <code>{j.endUser}</code></>}
        {j.mode && ` · ${j.mode}`}
        {j.regions && <span className="pill ok">{t("admin.jobs.regionsBadge")}</span>}
      </div>
      {j.content ? (
        <>
          <div className="pics">
            {(["sketch", "hint", "result"] as const).map((k) =>
              pics[k] ? (
                <a key={k} href={pics[k]} target="_blank" rel="noreferrer">
                  <img src={pics[k]} alt={t(`admin.jobs.pic.${k}`)} loading="lazy" />
                  <span>{t(`admin.jobs.pic.${k}`)}</span>
                </a>
              ) : null,
            )}
          </div>
          {j.narrative && <p className="quote">“{j.narrative}”</p>}
          {j.prompt && <p className="muted small-print">{j.prompt}</p>}
        </>
      ) : (
        <p className="muted small-print">{t("admin.jobs.hidden")}</p>
      )}
      <div className="muted small-print">
        {j.gpu ? `${j.gpu.type}${j.gpu.region ? ` (${j.gpu.region})` : ""}` : "—"} · {t("admin.jobs.timing", { queue: f.num(j.queueSeconds), run: f.num(j.runSeconds) })}
        {j.generation && ` · ${j.generation.op} ${j.generation.steps}×${j.generation.strength ? ` s${j.generation.strength}` : ""}`}
        {j.charged !== null && ` · ${f.num(j.charged, 1)} ${t("admin.credits")}`}
        {j.error && <span className="error"> · {j.error}</span>}
      </div>
    </article>
  );
}

// ---- Reports ----

function Reports() {
  const { t } = useTranslation();
  const f = useFormat();
  const errorText = useErrorText();
  const [all, setAll] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const { data, error, reload, setError } = useLoad<{ reports: AdminReport[] }>(() => api.admin.reports(all), [all]);
  const act = (id: string, a: "dismiss" | "remove" | "flag-account") =>
    void api.admin.act(id, a, notes[id] ?? "").then(() => reload()).catch((e) => setError(errorText(e)));
  return (
    <section className="card">
      <div className="row spread">
        <h2>{t("admin.reports.title")}</h2>
        <label className="check">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> {t("admin.reports.showAll")}
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      {data?.reports.length === 0 && <p className="muted">{t("admin.reports.none")}</p>}
      {data?.reports.map((r) => (
        <article key={r.id} className="report">
          <div className="row spread">
            <strong>{t(`admin.reports.reason.${r.reason}`, { defaultValue: r.reason })}</strong>
            <span className="muted">{f.date(r.createdAt)} · {r.source}</span>
          </div>
          <div className="muted small-print">
            {r.account?.email ?? "—"} {r.account?.flagged && <span className="pill bad">{t("admin.badges.flagged")}</span>}
            {r.note && <> · “{r.note}”</>}
          </div>
          <div className="pics">
            {r.output && (
              <a href={r.output} target="_blank" rel="noreferrer">
                <img src={r.output} alt={t("admin.jobs.pic.result")} />
                <span>{t("admin.jobs.pic.result")}</span>
              </a>
            )}
            {r.inputs.filter((i) => i.url).map((i) => (
              <a key={i.url!} href={i.url!} target="_blank" rel="noreferrer">
                <img src={i.url!} alt={i.name} />
                <span>{i.name}</span>
              </a>
            ))}
          </div>
          {r.status === "open" ? (
            <div className="row wrap">
              <input className="grow" placeholder={t("admin.reports.note")} value={notes[r.id] ?? ""} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} />
              <button className="ghost small" onClick={() => act(r.id, "dismiss")}>{t("admin.reports.dismiss")}</button>
              <button className="small" onClick={() => act(r.id, "remove")}>{t("admin.reports.remove")}</button>
              <button className="ghost small" onClick={() => act(r.id, "flag-account")}>{t("admin.reports.flag")}</button>
            </div>
          ) : (
            <p className="muted small-print">{t("admin.reports.resolved", { status: r.status, by: r.resolvedBy ?? "—", at: f.date(r.resolvedAt) })}</p>
          )}
        </article>
      ))}
    </section>
  );
}

// ---- Audit ----

function Audit() {
  const { t } = useTranslation();
  const f = useFormat();
  const { data, error } = useLoad<{ entries: AdminAuditEntry[] }>(() => api.admin.audit(), []);
  const [from, setFrom] = useState(() => new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date(Date.now() + 86400_000).toISOString().slice(0, 10));
  const errorText = useErrorText();
  const [usageError, setUsageError] = useState("");
  const download = () =>
    void api.admin
      .usage(from, to)
      .then((r) => {
        for (const [name, csv] of Object.entries(r.files)) {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
          a.download = `${from}_${to}_${name}`;
          a.click();
          URL.revokeObjectURL(a.href);
        }
      })
      .catch((e) => setUsageError(errorText(e)));
  return (
    <div className="admin-grid">
      <section className="card">
        <h2>{t("admin.audit.usage")}</h2>
        <p className="muted">{t("admin.audit.usageIntro")}</p>
        <div className="row wrap">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <button onClick={download}>{t("admin.audit.download")}</button>
        </div>
        {usageError && <p className="error">{usageError}</p>}
      </section>
      <section className="card wide-card">
        <h2>{t("admin.audit.title")}</h2>
        <p className="muted">{t("admin.audit.intro")}</p>
        {error && <p className="error">{error}</p>}
        <ul className="events">
          {data?.entries.map((e, i) => (
            <li key={i}>
              <span className="muted">{f.date(e.at)}</span> <code>{e.action}</code> {e.operator}
              {e.email && <> → {e.email}</>}
              {e.note && <small className="muted"> · {e.note}</small>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
