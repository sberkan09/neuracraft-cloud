import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError, type User } from "./api";
import { LANGUAGES, setLanguage, type Language } from "./i18n";
import { Admin } from "./pages/Admin";
import { Auth } from "./pages/Auth";
import { Home } from "./pages/Home";
import { Tokens } from "./pages/Tokens";
import type { Workflow } from "./studio/graph";
import { loadDraft, Studio } from "./studio/Studio";

type Page = "home" | "studio" | "tokens" | "admin";
const pageFromHash = (): Page =>
  location.hash === "#studio" ? "studio" : location.hash === "#tokens" ? "tokens" : location.hash === "#admin" ? "admin" : "home";

export function App() {
  const { t, i18n } = useTranslation();
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [operator, setOperator] = useState(false);
  const [page, setPage] = useState<Page>(pageFromHash);
  const [workflow, setWorkflow] = useState<Workflow>(loadDraft);

  useEffect(() => {
    api
      .me()
      .then((r) => {
        setUser(r.user);
        setOperator(r.operator === true);
        if (LANGUAGES.includes(r.user.locale as Language)) setLanguage(r.user.locale as Language);
      })
      .catch((e) => setUser(e instanceof ApiError && e.code === "auth.required" ? null : null));
  }, []);
  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const go = (p: Page) => {
    location.hash = p === "home" ? "" : p;
    setPage(p);
  };
  const openStudio = (wf: unknown) => {
    const w = wf as Workflow | null;
    if (w && Array.isArray(w.steps)) setWorkflow({ ...w, steps: w.steps.map((s) => ({ ...s })) });
    go("studio");
  };

  const changeLanguage = (l: Language) => {
    setLanguage(l);
    if (user) void api.setLocale(l).catch(() => {});
  };

  return (
    <div className={`app ${user && (page === "studio" || page === "admin") ? "wide" : ""}`}>
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden>◆</span> {t("app.name")}
        </div>
        {user && (
          <nav className="segmented" aria-label={t("nav.label")}>
            <button type="button" aria-pressed={page === "home"} onClick={() => go("home")}>{t("nav.tasks")}</button>
            <button type="button" aria-pressed={page === "studio"} onClick={() => go("studio")}>{t("nav.studio")}</button>
            <button type="button" aria-pressed={page === "tokens"} onClick={() => go("tokens")}>{t("nav.tokens")}</button>
            {operator && (
              <button type="button" aria-pressed={page === "admin"} onClick={() => go("admin")}>{t("nav.admin")}</button>
            )}
          </nav>
        )}
        <div className="top-actions">
          <label className="lang">
            <span className="sr-only">{t("language.label")}</span>
            <select value={i18n.language} onChange={(e) => changeLanguage(e.target.value as Language)} aria-label={t("language.label")}>
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {t(`language.${l}`)}
                </option>
              ))}
            </select>
          </label>
          {user && (
            <button className="ghost" onClick={() => api.logout().then(() => (setUser(null), setOperator(false)))}>
              {t("auth.logout")}
            </button>
          )}
        </div>
      </header>
      <main>
        {user === undefined ? null : !user ? (
          <Auth onIn={(u) => (setUser(u), void api.me().then((r) => setOperator(r.operator === true)).catch(() => {}))} />
        ) : page === "studio" ? (
          <Studio workflow={workflow} onWorkflow={setWorkflow} />
        ) : page === "tokens" ? (
          <Tokens />
        ) : page === "admin" && operator ? (
          <Admin />
        ) : (
          <Home openStudio={openStudio} />
        )}
      </main>
    </div>
  );
}
