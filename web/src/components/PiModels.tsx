import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { PiModelCatalog, PiModelRef, SessionStatus } from "../api/types";
import { useT } from "../i18n/provider";
import { Sheet } from "./Sheet";
import { Button } from "./ui/button";
import "./pi-models.css";

export function modelValue(model: PiModelRef | null | undefined): string {
  return model ? JSON.stringify({ provider: model.provider, id: model.id }) : "";
}

function selectedModel(value: string): PiModelRef | undefined {
  return value ? JSON.parse(value) as PiModelRef : undefined;
}

function modelLabel(model: PiModelRef): string { return `${model.provider} / ${model.id}`; }

export function PiModelOptions({ catalog, value, onChange, disabled, allowDefault = true }: {
  catalog: PiModelCatalog | null;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  allowDefault?: boolean;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const visible = (catalog?.models ?? []).filter((model) => modelValue(model) === value
    || `${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(query));
  const groups = [...new Set(visible.map((model) => model.provider))];
  const missing = value !== "" && !visible.some((model) => modelValue(model) === value);
  return <div className="pi-model-options">
    <input type="search" className="pi-model-search" aria-label={t("models.search")} placeholder={t("models.search")}
      value={search} onChange={(event) => setSearch(event.target.value)} disabled={disabled} autoCapitalize="none" spellCheck={false} />
    <select className="pi-model-select" aria-label={t("models.select")} value={value} disabled={disabled || !catalog}
      onChange={(event) => onChange(event.target.value)}>
      <option value="" disabled={!allowDefault}>{allowDefault
        ? `${t("models.default")}${catalog?.defaultModel ? ` · ${modelLabel(catalog.defaultModel)}` : ""}` : t("models.select")}</option>
      {missing && <option value={value} disabled>{modelLabel(selectedModel(value)!)}</option>}
      {groups.map((provider) => <optgroup label={provider} key={provider}>
        {visible.filter((model) => model.provider === provider).map((model) => <option key={modelValue(model)} value={modelValue(model)}>
          {model.name} · {model.id}
        </option>)}
      </optgroup>)}
    </select>
    {catalog && visible.length === 0 && <p className="hint-text">{t("models.none")}</p>}
    {catalog?.warning && <p className="pi-model-warning" role="status">{catalog.warning}</p>}
  </div>;
}

/** The catalog is loaded only for a usable cwd, and stale responses cannot change a later choice. */
export function PiNewModelField({ cwd, value, onChange }: {
  cwd: string; value: PiModelRef | undefined; onChange: (model: PiModelRef | undefined) => void;
}) {
  const t = useT();
  const [catalog, setCatalog] = useState<PiModelCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => { onChange(undefined); }, [cwd, onChange]);
  useEffect(() => {
    let active = true;
    setCatalog(null); setError(null);
    if (!(cwd.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cwd))) { setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      void api.getPiModels(cwd.trim()).then((next) => { if (active) setCatalog(next); },
        (err: unknown) => { if (active) setError(err instanceof Error ? err.message : t("models.failed")); })
        .finally(() => { if (active) setLoading(false); });
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [cwd, revision, t]);
  return <div className="field pi-new-model-field">
    <div className="field-label">{t("models.title")}</div>
    <PiModelOptions catalog={catalog} value={modelValue(value)} onChange={(next) => onChange(selectedModel(next))} disabled={loading} />
    {loading && <p className="hint-text" role="status">{t("models.loading")}</p>}
    {!catalog && !loading && !error && <p className="hint-text">{t("models.cwd")}</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
    <button type="button" className="pi-model-refresh" onClick={() => setRevision((n) => n + 1)} disabled={loading}>
      {t("models.refresh")}
    </button>
    <p className="hint-text">{t("models.savedHint")}</p>
  </div>;
}

export function PiModelControl({ sessionId, status, attached = false }: {
  sessionId: string; status: SessionStatus; attached?: boolean;
}) {
  const t = useT();
  const [catalog, setCatalog] = useState<PiModelCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const disabled = status === "running" || attached || saving;
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(null);
    void api.getSessionModels(sessionId).then((next) => {
      if (!active) return;
      setCatalog(next);
    }, (err: unknown) => { if (active) setError(err instanceof Error ? err.message : t("models.failed")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sessionId, status, revision, t]);
  const current = catalog?.currentModel, fallback = catalog?.defaultModel;
  const selectedAvailable = catalog?.models.some((model) => modelValue(model) === value) === true;
  const label = current ? modelLabel(current) : fallback ? `${t("models.default")} · ${modelLabel(fallback)}` : t("models.automatic");
  const save = async () => {
    const model = selectedModel(value);
    if (!model || disabled) return;
    setSaving(true); setError(null);
    try {
      const changed = await api.setPiModel(sessionId, model);
      setCatalog((previous) => previous ? { ...previous, currentModel: changed.model } : previous);
      setOpen(false); refresh();
    } catch (err) { setError(err instanceof Error ? err.message : t("models.failed")); }
    finally { setSaving(false); }
  };
  return <>
    <div className="pi-model-strip">
      <span className="pi-model-current" title={label}>
        <span className="hint-text">{current ? t("models.current") : t("models.title")}: </span>
        {loading && !catalog ? t("models.loading") : error && !catalog ? t("models.failed") : label}
      </span>
      <button type="button" className="pi-model-change" disabled={disabled} title={disabled ? t("models.busy") : t("models.change")}
        onClick={() => { setValue(modelValue(current ?? fallback)); setOpen(true); refresh(); }}>
        {t("models.change")}
      </button>
    </div>
    {open && <Sheet title={t("models.change")} subtitle={current ? modelLabel(current) : t("models.title")}
      onClose={() => { if (!saving) setOpen(false); }} footer={<div className="form-row">
        <Button type="button" onClick={() => void save()} disabled={disabled || loading || !selectedAvailable}>{saving ? t("models.saving") : t("models.save")}</Button>
        <Button type="button" variant="secondary" disabled={saving} onClick={() => setOpen(false)}>{t("models.cancel")}</Button>
      </div>}>
      <PiModelOptions catalog={catalog} value={value} onChange={setValue} disabled={loading || saving} allowDefault={false} />
      {error && <p className="error-text" role="alert">{error}</p>}
      <button type="button" className="pi-model-refresh" onClick={refresh} disabled={loading || saving}>{t("models.refresh")}</button>
      <p className="hint-text">{t("models.scope")}</p>
      <p className="hint-text">{t("models.auth")}</p>
      {disabled && !saving && <p className="pi-model-warning">{t("models.busy")}</p>}
    </Sheet>}
  </>;
}
