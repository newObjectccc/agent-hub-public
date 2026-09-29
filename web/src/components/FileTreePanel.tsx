import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { FsEntry } from "../api/types";

export interface FileTreePanelProps {
  open: boolean;
  /** 会话 cwd（= 文件树根，server 只读列目录） */
  cwd: string;
  /** 确认插入：选中的相对路径（面板关闭） */
  onInsert: (paths: string[]) => void;
  onClose: () => void;
}

/** rel 路径拼接（统一 / 分隔，根下就是 name） */
export function joinRel(path: string, name: string): string {
  return path === "" ? name : `${path}/${name}`;
}

/**
 * @ 文件树多选面板：面包屑导航 + 搜索过滤 + 多选 + 插入 `@rel/path` 引用。
 * 只读（GET /api/fs/tree），.git/node_modules 默认隐藏可展开；野兽派风格，320-1024 响应式。
 */
export function FileTreePanel({ open, cwd, onInsert, onClose }: FileTreePanelProps) {
  const [path, setPath] = useState("");
  const [q, setQ] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 多选：rel 路径集合（跨目录保留，插入时按选中顺序） */
  const [selected, setSelected] = useState<string[]>([]);
  const seqRef = useRef(0);

  // 打开时重置到根（保留上次多选清空）
  useEffect(() => {
    if (!open) return;
    setPath("");
    setQ("");
    setShowHidden(false);
    setSelected([]);
    setError(null);
  }, [open]);

  const load = useCallback(async () => {
    if (!open) return;
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const tree = await api.getFsTree(cwd, { path, q: q.trim() === "" ? undefined : q.trim(), hidden: showHidden });
      if (seq !== seqRef.current) return; // 过期响应丢弃
      setEntries(tree.entries);
      setTruncated(tree.truncated);
      setError(null);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(e instanceof Error ? e.message : "目录加载失败");
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [cwd, open, path, q, showHidden]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!open) return null;

  const toggleSelect = (rel: string) => {
    setSelected((prev) => (prev.includes(rel) ? prev.filter((p) => p !== rel) : [...prev, rel]));
  };

  const crumbs: Array<{ label: string; path: string }> = [{ label: "根", path: "" }];
  if (path !== "") {
    const parts = path.split("/");
    parts.forEach((part, i) => {
      crumbs.push({ label: part, path: parts.slice(0, i + 1).join("/") });
    });
  }

  return (
    <div className="ft-panel" role="dialog" aria-label="引用文件">
      <div className="ft-head">
        <span className="ft-title">@ 引用文件</span>
        <span className="ft-cwd" title={cwd}>
          {cwd}
        </span>
        <button type="button" className="ft-close" onClick={onClose} aria-label="关闭文件面板">
          ✕
        </button>
      </div>

      <div className="ft-crumbs" aria-label="目录导航">
        {crumbs.map((c, i) => (
          <span key={c.path}>
            {i > 0 && <span className="ft-sep">/</span>}
            <button
              type="button"
              className={`ft-crumb${i === crumbs.length - 1 ? " active" : ""}`}
              onClick={() => setPath(c.path)}
            >
              {c.label}
            </button>
          </span>
        ))}
      </div>

      <input
        className="ft-search"
        value={q}
        placeholder="按文件名过滤…"
        aria-label="按文件名过滤"
        onChange={(e) => setQ(e.target.value)}
      />

      <div className="ft-list">
        {loading && <div className="ft-hint">加载中…</div>}
        {error && <div className="ft-hint error">{error}</div>}
        {!loading && !error && entries.length === 0 && <div className="ft-hint">（空目录）</div>}
        {entries.map((entry) => {
          const rel = joinRel(path, entry.name);
          const isDir = entry.type === "dir";
          const checked = selected.includes(rel);
          return (
            <div key={rel} className={`ft-row${entry.hidden ? " hidden" : ""}`}>
              {isDir ? (
                <button type="button" className="ft-dir" onClick={() => setPath(rel)}>
                  <span className="ft-icon">▸</span>
                  <span className="ft-name">{entry.name}</span>
                  <span className="ft-tag">目录</span>
                </button>
              ) : (
                <button
                  type="button"
                  className={`ft-file${checked ? " checked" : ""}`}
                  aria-pressed={checked}
                  onClick={() => toggleSelect(rel)}
                >
                  <span className="ft-check">{checked ? "☑" : "☐"}</span>
                  <span className="ft-name">{entry.name}</span>
                  {entry.hidden && <span className="ft-tag">隐藏</span>}
                </button>
              )}
            </div>
          );
        })}
        {truncated && <div className="ft-hint">条目过多，仅显示前 {entries.length} 项</div>}
      </div>

      <div className="ft-foot">
        <button
          type="button"
          className={`ft-toggle${showHidden ? " active" : ""}`}
          onClick={() => setShowHidden((v) => !v)}
          aria-pressed={showHidden}
        >
          {showHidden ? "隐藏 .git/node_modules" : "显示隐藏项"}
        </button>
        <span className="ft-selected">已选 {selected.length}</span>
        {selected.length > 0 && (
          <button type="button" className="ft-clear" onClick={() => setSelected([])}>
            清除
          </button>
        )}
        <button
          type="button"
          className="ft-insert"
          disabled={selected.length === 0}
          onClick={() => {
            onInsert(selected);
            onClose();
          }}
        >
          插入引用
        </button>
      </div>
    </div>
  );
}
