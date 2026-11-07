// Personal access tokens for scripts and apps (issue #16): make one with its scopes (the secret is
// shown once), see when each was last used, revoke it.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ApiToken } from "../api";
import { useErrorText } from "../useError";

const SCOPES = ["jobs:submit", "jobs:read", "assets:write", "assets:read"] as const;

export function Tokens() {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([...SCOPES]);
  const [days, setDays] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const refresh = useCallback(() => api.tokens().then((r) => setTokens(r.tokens)).catch((e) => setError(errorText(e))), [errorText]);
  useEffect(() => void refresh(), [refresh]);
  const date = (s: string | null) => (s ? new Date(s).toLocaleString(i18n.language) : t("tokens.never"));

  const create = async () => {
    setError("");
    try {
      const r = await api.createToken(name.trim(), scopes, days ? Number(days) : undefined);
      setSecret(r.secret);
      setName("");
      await refresh();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="home">
      <section className="card">
        <h2>{t("tokens.title")}</h2>
        <p className="muted">{t("tokens.intro")}</p>
        <label>
          {t("tokens.name")}
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        </label>
        <fieldset className="field">
          <legend>{t("tokens.scopes")}</legend>
          {SCOPES.map((s) => (
            <label key={s} className="check">
              <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes((x) => (e.target.checked ? [...x, s] : x.filter((y) => y !== s)))} />
              {t(`tokens.scope.${s}`)} <code>{s}</code>
            </label>
          ))}
        </fieldset>
        <label>
          {t("tokens.expires")}
          <input type="number" min={1} max={3650} placeholder={t("tokens.noExpiry")} value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
        <button onClick={() => void create()} disabled={!name.trim() || !scopes.length}>{t("tokens.create")}</button>
        {secret && (
          <div className="notice">
            <p>{t("tokens.secretOnce")}</p>
            <code className="secret">{secret}</code>
            <button className="ghost small" onClick={() => void navigator.clipboard?.writeText(secret)}>{t("tokens.copy")}</button>
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </section>
      <section className="card">
        <h2>{t("tokens.list")}</h2>
        {tokens.length === 0 && <p className="muted">{t("tokens.none")}</p>}
        <ul className="tokens">
          {tokens.map((k) => (
            <li key={k.id} className={k.revokedAt ? "muted" : ""}>
              <strong>{k.name}</strong> <code>{k.prefix}…</code> · {k.scopes.join(", ")}
              <br />
              <small>
                {t("tokens.created", { at: date(k.createdAt) })} · {t("tokens.lastUsed", { at: date(k.lastUsedAt) })}
                {k.expiresAt ? ` · ${t("tokens.expiresAt", { at: date(k.expiresAt) })}` : ""}
                {k.revokedAt ? ` · ${t("tokens.revoked")}` : ""}
              </small>
              {!k.revokedAt && (
                <button className="ghost small" onClick={() => void api.revokeToken(k.id).then(refresh).catch((e) => setError(errorText(e)))}>
                  {t("tokens.revoke")}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
