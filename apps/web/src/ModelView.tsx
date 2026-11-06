// A 3D model (glTF binary) the viewer can turn and zoom: Google's <model-viewer> web component, loaded
// the first time a model is shown (it brings three.js, so the rest of the app does not wait for it).
import { createElement, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

let loading: Promise<unknown> | null = null;

export function ModelView({ src, label }: { src: string; label: string }) {
  const { t } = useTranslation();
  const [ready, setReady] = useState(typeof customElements !== "undefined" && !!customElements.get("model-viewer"));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (ready) return;
    loading ??= import("@google/model-viewer");
    let live = true;
    loading.then(() => live && setReady(true)).catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [ready]);
  if (failed) return <small className="muted">{t("model.unavailable")}</small>;
  if (!ready) return <div className="model-view loading muted">{t("model.loading")}</div>;
  return createElement("model-viewer", {
    class: "model-view",
    src,
    alt: label,
    "camera-controls": "",
    "auto-rotate": "",
    "rotation-per-second": "20deg",
    "shadow-intensity": "0.6",
    "interaction-prompt": "none",
    "touch-action": "pan-y",
  });
}
