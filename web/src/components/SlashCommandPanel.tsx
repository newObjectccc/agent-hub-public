import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import type { CommandItem, SessionSource } from "../api/types";
import type { PanelKeyHandle } from "../utils/panelNav";
import { handlePanelKeyNav } from "../utils/panelNav";
import { groupSlashCommands, type SlashGroup } from "../utils/slashInput";

export interface SlashCommandPanelProps {
  open: boolean;
  /** 会话来源（标题分发提示） */
  source: SessionSource;
  /** 命令清单（ChatPage 按 source 拉取 /api/commands） */
  commands: CommandItem[];
  loading: boolean;
  error: string | null;
  /** 当前过滤词（输入框 `/` 后继续输入） */
  query: string;
  /** 选中命令：插入输入框（替换 /token 为 `/cmd `，尾随空格便于连续输入） */
  onSelect: (name: string) => void;
  onClose: () => void;
}

/** 组内条目图标：内置 ⚙ / 自定义 🧩 */
function itemIcon(cmd: CommandItem): string {
  return cmd.builtin ? "⚙" : "🧩";
}

/**
 * slash 命令面板（浮层贴输入框上方）：分组（可直接执行 / 仅终端可用）+ 图标、
 * 过滤、点击或键盘（方向键 + Enter，Tab 在条目间移动）插入 `/cmd `。
 */
export const SlashCommandPanel = forwardRef<PanelKeyHandle, SlashCommandPanelProps>(
  function SlashCommandPanel({ open, source, commands, loading, error, query, onSelect, onClose }, ref) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const groups: SlashGroup[] = useMemo(() => groupSlashCommands(commands, query), [commands, query]);

    useImperativeHandle(
      ref,
      () => ({
        focusFirst: () => {
          rootRef.current?.querySelector<HTMLElement>('[data-nav="1"]')?.focus();
        },
        focusLast: () => {
          const items = rootRef.current?.querySelectorAll<HTMLElement>('[data-nav="1"]');
          items?.[items.length - 1]?.focus();
        },
      }),
      [],
    );

    if (!open) return null;

    let index = 0;
    return (
      <div
        className="slash-panel"
        role="dialog"
        aria-label="斜杠命令"
        ref={rootRef}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
            return;
          }
          handlePanelKeyNav(e, rootRef.current);
        }}
      >
        <div className="slash-head">
          <span className="slash-title">/ 命令 · {source === "pi" ? "pi" : "claude"}</span>
          <span className="slash-hint-inline">↑↓ 选择 · Enter 插入 · Esc 关闭</span>
          <button type="button" className="slash-close" onClick={onClose} aria-label="关闭命令面板">
            ✕
          </button>
        </div>
        {loading && <div className="slash-hint">命令加载中…</div>}
        {error && <div className="slash-hint error">{error}</div>}
        {!loading && !error && groups.length === 0 && <div className="slash-hint">无匹配命令</div>}
        <div className="slash-list">
          {groups.map((group) => (
            <div className="slash-group" key={group.key}>
              <div className="slash-group-head" role="presentation">
                <span className="slash-group-icon" aria-hidden="true">
                  {group.icon}
                </span>
                {group.label}
              </div>
              {group.items.map((cmd) => {
                const isFirst = index === 0;
                index += 1;
                return (
                  <button
                    key={group.key + cmd.name}
                    type="button"
                    data-nav="1"
                    className={`slash-item${isFirst ? " first" : ""}`}
                    onClick={() => {
                      onSelect(cmd.name);
                      onClose();
                    }}
                  >
                    <span className="slash-item-icon" aria-hidden="true">
                      {itemIcon(cmd)}
                    </span>
                    <span className="slash-name">{cmd.name}</span>
                    {cmd.terminalOnly && <span className="slash-tag warn">仅终端可用</span>}
                    <span className="slash-desc">{cmd.description}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    );
  },
);
