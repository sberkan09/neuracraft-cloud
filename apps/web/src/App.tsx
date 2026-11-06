import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError, type User } from "./api";
import { LANGUAGES, setLanguage, type Language } from "./i18n";
import { Auth } from "./pages/Auth";
import { Home } from "./pages/Home";

export function App() {
  const { t, i18n } = useTranslation();
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api
      .me()
      .then((r) => {
        setUser(r.user);
        if (LANGUAGES.includes(r.user.locale as Language)) setLanguage(r.user.locale as Language);
      })
      .catch((e) => setUser(e instanceof ApiError && e.code === "auth.required" ? null : null));
  }, []);

  const changeLanguage = (l: Language) => {
    setLanguage(l);
    if (user) void api.setLocale(l).catch(() => {});
  };

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden>◆</span> {t("app.name")}
        </div>
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
            <button className="ghost" onClick={() => api.logout().then(() => setUser(null))}>
              {t("auth.logout")}
            </button>
          )}
        </div>
      </header>
      <main>{user === undefined ? null : user ? <Home /> : <Auth onIn={setUser} />}</main>
    </div>
  );
}
