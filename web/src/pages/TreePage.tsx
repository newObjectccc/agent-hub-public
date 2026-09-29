/**
 * 会话分支树页（/s/:id/tree）：
 * 缩进连线 + role 图标 + 摘要，活跃分支高亮，点击节点预览该节点消息。
 * 折叠/展开按子树隐藏；v0 只读，“从此处继续”按钮占位标注“开发中”。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type React from "react";
import { api } from "../api/client";
import type { SessionTree, TreeNode } from "../api/types";
import { BackIcon, ChevronIcon, CloseIcon, RoleIcon } from "../components/icons";
import { Button } from "../components/ui/button";
import { roleLabel } from "../utils/search";
import { relativeTime } from "../utils/relativeTime";
import { chatPath, navigate } from "../utils/router";
import { treeRows } from "../utils/tree";

export function TreePage({ sessionId }: { sessionId: string }) {
  const [tree, setTree] = useState<SessionTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<TreeNode | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getSessionTree(sessionId);
      setTree(data);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "分支树加载失败");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => (tree ? treeRows(tree.entries, tree.activePath, collapsed) : []), [tree, collapsed]);

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const collapseAll = () => {
    if (!tree) return;
    setCollapsed(new Set(tree.entries.filter((e) => e.hasChildren).map((e) => e.id)));
  };
  const expandAll = () => setCollapsed(new Set());

  return (
    <div className="tree-page">
      <header className="chat-header">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="back"
          onClick={() => navigate(chatPath(sessionId))}
          aria-label="返回会话"
        >
          <BackIcon />
        </Button>
        <div className="chat-title">
          <div className="name">会话分支树</div>
          <div className="cwd">{sessionId.slice(0, 12)}</div>
        </div>
        <div className="tree-toolbar">
          <Button type="button" variant="secondary" size="xs" onClick={collapseAll}>
            折叠
          </Button>
          <Button type="button" variant="secondary" size="xs" onClick={expandAll}>
            展开
          </Button>
        </div>
      </header>

      <div className="tree-scroll" role="tree" aria-label="会话分支树">
        {loading && <div className="empty">加载中…</div>}
        {loadError && (
          <div className="error-banner">
            <span>{loadError}</span>
            <Button type="button" variant="secondary" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </div>
        )}
        {!loading && !loadError && rows.length === 0 && <div className="empty">这个会话还没有消息</div>}
        {rows.map((row) => (
          <div
            key={row.node.id}
            className={`tree-row-slot${row.depth === 0 ? " root" : ""}${row.onActivePath ? " active" : ""}`}
            style={{ "--depth": row.depth } as React.CSSProperties}
            role="treeitem"
            aria-selected={selected?.id === row.node.id}
            aria-expanded={row.expandable ? !collapsed.has(row.node.id) : undefined}
          >
            {row.expandable ? (
              <button
                type="button"
                className="tree-toggle"
                onClick={() => toggle(row.node.id)}
                aria-label={collapsed.has(row.node.id) ? "展开子树" : "折叠子树"}
              >
                <ChevronIcon open={!collapsed.has(row.node.id)} />
              </button>
            ) : (
              <span className="tree-toggle placeholder" aria-hidden />
            )}
            <button type="button" className="tree-node" onClick={() => setSelected(row.node)}>
              <span className="tree-role" aria-hidden>
                <RoleIcon role={row.node.role} />
              </span>
              <span className="tree-text">{row.node.text || `（${roleLabel(row.node.role)}消息）`}</span>
              {row.onActivePath && <span className="tree-active-tag">活跃</span>}
            </button>
          </div>
        ))}
      </div>

      {selected && (
        <div className="tree-preview" role="dialog" aria-label="节点预览">
          <header className="tree-preview-head">
            <span className="tree-preview-role">
              <RoleIcon role={selected.role} />
              {roleLabel(selected.role)}
            </span>
            <span className="hint-text">{relativeTime(selected.timestamp)}</span>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              onClick={() => setSelected(null)}
              aria-label="关闭预览"
            >
              <CloseIcon />
            </Button>
          </header>
          <div className="tree-preview-text">{selected.text || "（无文本内容）"}</div>
          <div className="tree-preview-actions">
            <Button type="button" disabled title="开发中">
              从此处继续
            </Button>
            <span className="hint-text tag-wip">开发中（v0 只读）</span>
          </div>
        </div>
      )}
    </div>
  );
}
