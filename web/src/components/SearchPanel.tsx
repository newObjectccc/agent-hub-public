/**
 * 全局搜索面板（首页 🔍 入口打开）：
 * 键盘输入即时触发（debounce 300ms），结果=会话名+高亮摘要+相对时间，
 * 点击直达 chat 页并带 ?q=&m= 定位参数。
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { SearchResult } from "../api/types";
import { CloseIcon, RoleIcon } from "./icons";
import { Button } from "./ui/button";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { snippetSegments, roleLabel } from "../utils/search";
import { relativeTime } from "../utils/relativeTime";
import { chatPath, navigate } from "../utils/router";

export const SEARCH_DEBOUNCE_MS = 300;

export function SearchPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  // 焦点管理（UX 审查 AC6）：Tab 面板内循环、Esc 关闭、关闭归还焦点到 🔍 按钮
  useFocusTrap({ active: open, onClose, rootRef: overlayRef });

  // 打开时聚焦输入框（移动键盘立即弹出）
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // 键盘即时触发 + debounce + 过期响应丢弃
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    const seq = ++seqRef.current;
    if (q === "") {
      setResults(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .search(q, 50)
        .then((res) => {
          if (seq !== seqRef.current) return; // 过期响应
          setResults(res.results ?? []);
          setError(null);
        })
        .catch((e: unknown) => {
          if (seq !== seqRef.current) return;
          setError(e instanceof Error ? e.message : "搜索失败");
          setResults(null);
        })
        .finally(() => {
          if (seq === seqRef.current) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, open]);

  if (!open) return null;

  const go = (r: SearchResult) => {
    navigate(chatPath(r.sessionId, { q: query.trim(), messageId: r.messageId }));
    onClose();
  };

  return (
    <div className="search-overlay" role="dialog" aria-label="全局搜索" ref={overlayRef}>
      <header className="search-bar">
        <Button type="button" variant="outline" size="icon" className="min-h-[44px] min-w-[44px]" onClick={onClose} aria-label="关闭搜索">
          <CloseIcon />
        </Button>
        <input
          ref={inputRef}
          className="search-input"
          type="search"
          value={query}
          placeholder="搜索所有会话的消息…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
          aria-label="搜索关键词"
        />
      </header>

      <div className="search-results" role="list">
        {error && (
          <div className="error-banner">
            <span>{error}</span>
          </div>
        )}
        {!error && query.trim() !== "" && loading && results === null && <div className="empty">搜索中…</div>}
        {!error && results !== null && results.length === 0 && !loading && (
          <div className="empty">没有匹配「{query.trim()}」的消息</div>
        )}
        {results?.map((r) => (
          <button key={`${r.sessionId}-${r.messageId}`} type="button" className="search-result" onClick={() => go(r)} role="listitem">
            <div className="search-result-head">
              <span className="search-result-name">{r.sessionName ?? r.sessionId.slice(0, 8)}</span>
              <span className="search-result-meta">
                <RoleIcon role={r.role} />
                <span className="hint-text">{roleLabel(r.role)}</span>
                <span className="hint-text">{relativeTime(r.timestamp)}</span>
              </span>
            </div>
            <div className="search-result-snippet">
              {snippetSegments(r.snippet).map((seg, i) =>
                seg.hit ? (
                  <mark key={i}>{seg.text}</mark>
                ) : (
                  <span key={i}>{seg.text}</span>
                ),
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
