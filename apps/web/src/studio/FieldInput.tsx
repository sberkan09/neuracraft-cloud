// One field of a step, by its schema type. Files and models are the user's assets ("asset:<id>").
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { EngineField } from "@neuracraft/shared";
import { api, isModelFile, type Asset } from "../api";
import { useErrorText } from "../useError";

export function useFieldLabel() {
  const { t } = useTranslation();
  return (name: string) => t(`studio.fields.${name}`, { defaultValue: name });
}

const assetRef = (id: string) => `asset:${id}`;
const assetId = (v: unknown) => (typeof v === "string" && v.startsWith("asset:") ? v.slice(6) : "");

export function modelsFor(field: EngineField, models: Asset[]) {
  const kinds = new Set([field.model ?? ""]);
  if (field.model === "sd") ["sd-inpaint", "sdxl"].forEach((k) => kinds.add(k));  // the engine says which steps cannot use them
  return models.filter((m) => kinds.has(m.modelKind ?? ""));
}

export function FieldInput(props: {
  id: string;
  op: string; // the step's op
  field: EngineField;
  value: unknown;
  onChange(v: unknown): void;
  clips: string[]; // clips made by earlier steps
  models: Asset[];
  pictures: Asset[];
  onPicture(a: Asset): void; // a picture was uploaded
}) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const label = useFieldLabel();
  const { field: f, value, onChange, id } = props;
  const unset = value === undefined || value === null || value === "";
  const placeholder = f.default !== undefined ? t("studio.defaultValue", { value: JSON.stringify(f.default) }) : "";
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState("");
  const [uploading, setUploading] = useState(false);
  const head = (
    <span className="field-label" title={f.doc}>
      {label(f.name)}
      {f.required ? <small className="muted"> · {t("studio.required")}</small> : null}
    </span>
  );

  switch (f.type) {
    case "bool":
      return (
        <label className="check" title={f.doc}>
          <input type="checkbox" checked={unset ? Boolean(f.default) : Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          {label(f.name)}
        </label>
      );
    case "int":
    case "float":
      return (
        <label htmlFor={id}>
          {head}
          <input id={id} type="number" step={f.type === "int" ? 1 : "any"} min={f.min} max={f.max} placeholder={placeholder}
            value={unset ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />
        </label>
      );
    case "enum":
      return (
        <label htmlFor={id}>
          {head}
          <select id={id} value={unset ? "" : String(value)} onChange={(e) => onChange(e.target.value || undefined)}>
            <option value="">{placeholder || "—"}</option>
            {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
      );
    case "text":
      return (
        <label htmlFor={id}>
          {head}
          <textarea id={id} className="prose" rows={3} value={unset ? "" : String(value)} onChange={(e) => onChange(e.target.value || undefined)} />
        </label>
      );
    case "model": {
      const options = modelsFor(f, props.models);
      const known = options.some((m) => assetRef(m.id) === value);
      return (
        <label htmlFor={id}>
          {head}
          <select id={id} value={unset ? "" : String(value)} onChange={(e) => onChange(e.target.value || undefined)}>
            <option value="">{f.required ? t("studio.choose") : t("studio.none")}</option>
            {options.map((m) => <option key={m.id} value={assetRef(m.id)}>{m.name}{m.catalog ? "" : ` · ${t("studio.yours")}`}</option>)}
            {!unset && !known ? <option value={String(value)}>{t("studio.unknownAsset")}</option> : null}
          </select>
          {!options.length && f.required ? <small className="muted">{t("studio.noModelKind", { kind: f.model })}</small> : null}
        </label>
      );
    }
    case "file": {
      // load also reads 3D models (.glb); other file fields take pictures.
      const models3d = props.op === "load";
      const choices = props.pictures.filter((p) => models3d || !isModelFile(p));
      const picked = choices.find((p) => p.id === assetId(value));
      const upload = async (file?: File) => {
        if (!file) return;
        setUploading(true);
        setUploadError("");
        try {
          const a = /\.glb$/i.test(file.name) ? await api.uploadModelFile(file) : await api.uploadPicture(file);
          props.onPicture(a);
          onChange(assetRef(a.id));
        } catch (e) {
          setUploadError(errorText(e));
        } finally {
          setUploading(false);
        }
      };
      return (
        <div className="field">
          {head}
          <div className="picture-field">
            {picked && !isModelFile(picked) ? <img src={api.content(picked.id)} alt="" /> : null}
            <select id={id} aria-label={label(f.name)} value={unset ? "" : String(value)} onChange={(e) => onChange(e.target.value || undefined)}>
              <option value="">{t(models3d ? "studio.choosePictureOrModel" : "studio.choosePicture")}</option>
              {choices.map((p) => <option key={p.id} value={assetRef(p.id)}>{p.name}</option>)}
              {!unset && !picked ? <option value={String(value)}>{t("studio.unknownAsset")}</option> : null}
            </select>
          </div>
          <input ref={fileInput} type="file" accept={models3d ? "image/png,image/jpeg,image/webp,.glb,model/gltf-binary" : "image/png,image/jpeg,image/webp"} hidden
            onChange={(e) => void upload(e.target.files?.[0])} />
          <button type="button" className="ghost small" disabled={uploading} onClick={() => fileInput.current?.click()}>
            {uploading ? t("home.uploading") : t("home.upload")}
          </button>
          {uploadError ? <small className="error">{uploadError}</small> : null}
        </div>
      );
    }
    case "dir":
      return (
        <div className="field">
          {head}
          <small className="muted">{t("studio.noFolders")}</small>
        </div>
      );
    case "clip":
    case "mesh":
      return (
        <label htmlFor={id}>
          {head}
          <select id={id} value={unset ? "" : String(value)} onChange={(e) => onChange(e.target.value || undefined)}>
            <option value="">{f.required ? t("studio.choose") : t("studio.none")}</option>
            {props.clips.map((c) => <option key={c} value={c}>{c}</option>)}
            {!unset && !props.clips.includes(String(value)) ? <option value={String(value)}>{t("studio.missingClip", { clip: String(value) })}</option> : null}
          </select>
        </label>
      );
    case "clips":
    case "strings":
    case "ints": {
      const list = Array.isArray(value) ? value : unset ? [] : [value];
      return (
        <label htmlFor={id}>
          {head}
          <textarea id={id} className="prose" rows={Math.max(2, list.length)} placeholder={t(`studio.onePerLine.${f.type}`)} value={list.join("\n")}
            onChange={(e) => {
              const lines = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
              onChange(lines.length ? (f.type === "ints" ? lines.map(Number) : lines) : undefined);
            }} />
        </label>
      );
    }
    case "loras": {
      const loras = props.models.filter((m) => m.modelKind === "lora");
      const items = ((Array.isArray(value) ? value : []) as string[]).map((s) => {
        const m = /^(asset:[0-9a-f-]{36})(?::([0-9]*\.?[0-9]+))?$/.exec(s);
        return m ? { file: m[1]!, scale: m[2] ? Number(m[2]) : 1 } : { file: s, scale: 1 };
      });
      const set = (next: { file: string; scale: number }[]) => onChange(next.length ? next.map((l) => (l.scale === 1 ? l.file : `${l.file}:${l.scale}`)) : undefined);
      return (
        <div className="field">
          {head}
          {items.map((l, i) => (
            <div key={i} className="row">
              <select aria-label={t("studio.loraFile")} value={l.file} onChange={(e) => set(items.map((x, j) => (j === i ? { ...x, file: e.target.value } : x)))}>
                {loras.map((m) => <option key={m.id} value={assetRef(m.id)}>{m.name}</option>)}
                {!loras.some((m) => assetRef(m.id) === l.file) ? <option value={l.file}>{t("studio.unknownAsset")}</option> : null}
              </select>
              <input type="number" step={0.05} className="narrow" aria-label={t("studio.loraScale")} value={l.scale}
                onChange={(e) => set(items.map((x, j) => (j === i ? { ...x, scale: Number(e.target.value) } : x)))} />
              <button type="button" className="ghost small" aria-label={t("studio.remove")} onClick={() => set(items.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <button type="button" className="ghost small" disabled={!loras.length} onClick={() => set([...items, { file: assetRef(loras[0]!.id), scale: 1 }])}>
            {t("studio.addLora")}
          </button>
        </div>
      );
    }
    case "keyframes": {
      const list = (Array.isArray(value) ? value : []) as [number, string][];
      const set = (next: [number, string][]) => onChange(next.length ? next : undefined);
      return (
        <div className="field">
          {head}
          {list.map(([frame, text], i) => (
            <div key={i} className="row">
              <input type="number" min={0} className="narrow" aria-label={t("studio.keyframeFrame")} value={frame}
                onChange={(e) => set(list.map((x, j) => (j === i ? [Number(e.target.value), x[1]] : x)))} />
              <input aria-label={t("studio.keyframePrompt")} value={text} onChange={(e) => set(list.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
              <button type="button" className="ghost small" aria-label={t("studio.remove")} onClick={() => set(list.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <button type="button" className="ghost small" onClick={() => set([...list, [list.length ? list[list.length - 1]![0] + 16 : 0, ""]])}>
            {t("studio.addKeyframe")}
          </button>
        </div>
      );
    }
    default: // string (and a save's file name)
      return (
        <label htmlFor={id}>
          {head}
          <input id={id} placeholder={placeholder} value={unset ? "" : String(value)} onChange={(e) => onChange(e.target.value || undefined)} />
        </label>
      );
  }
}
