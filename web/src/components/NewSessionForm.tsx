/**
 * 新建会话（移动端 bottom sheet / 大屏居中弹窗，容器样式由 Sheet + CSS 断点决定）：
 * - source 分段按钮：pi / claude（野兽派单选）
 * - cwd：手动输入（绝对路径校验）+ 最近使用目录下拉（点选填入）
 * - name 可选
 * 成功后由 onCreated 回调跳进新会话 chat 页。
 */
import { useMemo, useState } from "react";
import { api } from "../api/client";
import type { SessionSource, SessionSummary } from "../api/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Sheet } from "./Sheet";

export interface NewSessionFormProps {
  open: boolean;
  onClose: () => void;
  onCreated: (session: SessionSummary) => void;
  /** 最近使用的工作目录（去重、按最近使用倒序，来自 GET /api/sessions） */
  recentCwds?: string[];
}

const SOURCES: Array<{ value: SessionSource; label: string; hint: string }> = [
  { value: "pi", label: "pi", hint: "Pi agent 会话" },
  { value: "claude", label: "claude", hint: "Claude Code 会话" },
];

/** 绝对路径校验（POSIX / Windows 盘符），与 server requireAbsoluteCwd 同口径 */
export function isAbsoluteCwd(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

export function NewSessionForm({ open, onClose, onCreated, recentCwds = [] }: NewSessionFormProps) {
  const [source, setSource] = useState<SessionSource>("pi");
  const [cwd, setCwd] = useState("");
  const [name, setName] = useState("");
  const [recentOpen, setRecentOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cwds = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const dir of recentCwds) {
      const trimmed = dir.trim();
      if (trimmed === "" || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
    return out;
  }, [recentCwds]);

  const close = (): void => {
    if (busy) return;
    setRecentOpen(false);
    setError(null);
    onClose();
  };

  const submit = async () => {
    const trimmed = cwd.trim();
    if (trimmed === "") {
      setError("请填写工作目录（cwd）绝对路径");
      return;
    }
    if (!isAbsoluteCwd(trimmed)) {
      setError("cwd 必须是绝对路径（如 /Users/me/Workspace/proj）");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { session } = await api.createSession(trimmed, name.trim() || undefined, source);
      setCwd("");
      setName("");
      setRecentOpen(false);
      onCreated(session);
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <Sheet
      title="新建会话"
      subtitle={source === "pi" ? "Pi agent 会话" : "Claude Code 会话"}
      onClose={close}
      footer={
        <div className="form-row">
          <Button type="button" onClick={() => void submit()} disabled={busy} className="flex-1">
            {busy ? "创建中…" : "创建并进入"}
          </Button>
          <Button type="button" variant="secondary" onClick={close} disabled={busy}>
            取消
          </Button>
        </div>
      }
    >
      <div className="field">
        <div className="field-label" id="new-session-source-label">
          Agent 类型
        </div>
        <div className="segment" role="radiogroup" aria-labelledby="new-session-source-label">
          {SOURCES.map((s) => (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={source === s.value}
              className={`segment-item${source === s.value ? " active" : ""}`}
              onClick={() => setSource(s.value)}
              title={s.hint}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <div className="field-label">工作目录 cwd</div>
        <div className="cwd-row">
          <Input
            placeholder="/Users/me/Workspace/proj"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            aria-label="工作目录"
            aria-invalid={cwd.trim() !== "" && !isAbsoluteCwd(cwd.trim())}
            inputMode="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          {cwds.length > 0 && (
            <Button
              type="button"
              variant="outline"
              aria-expanded={recentOpen}
              onClick={() => setRecentOpen((v) => !v)}
            >
              最近
            </Button>
          )}
        </div>
        {recentOpen && cwds.length > 0 && (
          <div className="cwd-recent" role="listbox" aria-label="最近使用的工作目录">
            {cwds.map((dir) => (
              <button
                key={dir}
                type="button"
                role="option"
                aria-selected={cwd === dir}
                className="cwd-recent-item"
                onClick={() => {
                  setCwd(dir);
                  setRecentOpen(false);
                  setError(null);
                }}
              >
                <span className="cwd-recent-path">{dir}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="field">
        <div className="field-label">会话名称（可选）</div>
        <Input placeholder="如：seksun KPI 周报" value={name} onChange={(e) => setName(e.target.value)} aria-label="会话名称" />
      </div>

      {error && <div className="error-text" role="alert">{error}</div>}
    </Sheet>
  );
}
