import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type User } from "../api";
import { useErrorText } from "../useError";

export function Auth({ onIn }: { onIn: (u: User) => void }) {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = mode === "login" ? await api.login(email, password) : await api.signup(email, password, i18n.language);
      onIn(r.user);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="auth card">
      <h1>{t(mode === "login" ? "auth.login" : "auth.signup")}</h1>
      <p className="muted">{t("app.tagline")}</p>
      <form onSubmit={submit}>
        <label>
          {t("auth.email")}
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          {t("auth.password")}
          <input
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            minLength={mode === "signup" ? 10 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {mode === "signup" && <small className="muted">{t("auth.passwordHint")}</small>}
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? t("auth.working") : t(mode === "login" ? "auth.login" : "auth.signup")}
        </button>
      </form>
      <p className="muted switch">
        {t(mode === "login" ? "auth.noAccount" : "auth.haveAccount")}{" "}
        <button className="link" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
          {t(mode === "login" ? "auth.signup" : "auth.login")}
        </button>
      </p>
    </section>
  );
}
