import { useMemo } from "react";
import type { CommandItem, SessionSource } from "../api/types";
import { filterSlashCommands } from "../utils/slashInput";

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
  /** 选中命令：插入输入框（替换 /token 为 `/cmd `） */
  onSelect: (name: string) => void;
  onClose: () => void;
}

/**
 * slash 命令面板（浮层在输入框上方）：按 source 分发清单、继续输入过滤、
 * 点击插入输入框；claude 内置命令标注"仅终端可用"（print 模式实测不可用）。
 */
export function SlashCommandPanel({ open, source, commands, loading, error, query, onSelect, onClose }: SlashCommandPanelProps) {
  const filtered = useMemo(() => filterSlashCommands(commands, query), [commands, query]);

  if (!open) return null;

  return (
    <div className="slash-panel" role="dialog" aria-label="斜杠命令">
      <div className="slash-head">
        <span className="slash-title">/ 命令 · {source === "pi" ? "pi" : "claude"}</span>
        <button type="button" className="slash-close" onClick={onClose} aria-label="关闭命令面板">
          ✕
        </button>
      </div>
      {loading && <div className="slash-hint">命令加载中…</div>}
      {error && <div className="slash-hint error">{error}</div>}
      {!loading && !error && filtered.length === 0 && <div className="slash-hint">无匹配命令</div>}
      <div className="slash-list">
        {filtered.map((cmd, i) => (
          <button
            key={cmd.name}
            type="button"
            className={`slash-item${i === 0 ? " first" : ""}`}
            onClick={() => {
              onSelect(cmd.name);
              onClose();
            }}
          >
            <span className="slash-name">{cmd.name}</span>
            {cmd.terminalOnly && <span className="slash-tag warn">仅终端可用</span>}
            {!cmd.builtin && !cmd.terminalOnly && <span className="slash-tag">自定义</span>}
            <span className="slash-desc">{cmd.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
