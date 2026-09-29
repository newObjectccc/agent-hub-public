import { useState } from "react";
import {
  addCustomCommand,
  allCommands,
  loadCustomCommands,
  removeCustomCommand,
  safeStorage,
  saveCustomCommands,
} from "../utils/quickCommands";

export interface QuickCommandPanelProps {
  open: boolean;
  /** 点击模板：插入输入框（可编辑后发送） */
  onInsert: (text: string) => void;
  onClose: () => void;
}

/**
 * 快捷指令面板：内置常用 prompt 模板 + 用户自定义（localStorage 持久化）。
 * 点击条目插入输入框，自定义条目可删除。
 */
export function QuickCommandPanel({ open, onInsert, onClose }: QuickCommandPanelProps) {
  // storage 不可用（getter 抛 SecurityError/禁 cookie）→ 降级仅内存，不崩不抛
  const [custom, setCustom] = useState<string[]>(() => {
    const storage = safeStorage();
    return storage ? loadCustomCommands(storage) : [];
  });
  const [draft, setDraft] = useState("");

  if (!open) return null;

  const persist = (next: string[]) => {
    setCustom(next);
    const storage = safeStorage();
    if (storage) saveCustomCommands(storage, next);
  };

  const commands = allCommands(custom);

  return (
    <div className="quick-panel" role="dialog" aria-label="快捷指令">
      <div className="quick-head">
        <span className="quick-title">⚡ 快捷指令</span>
        <button type="button" className="quick-close" onClick={onClose} aria-label="关闭快捷指令">
          ✕
        </button>
      </div>
      <div className="quick-list">
        {commands.map((cmd) => (
          <div key={cmd.id} className="quick-item">
            <button
              type="button"
              className="quick-insert"
              onClick={() => {
                onInsert(cmd.text);
                onClose();
              }}
            >
              {cmd.text}
            </button>
            {!cmd.builtin && (
              <button
                type="button"
                className="quick-delete"
                aria-label={`删除快捷指令 ${cmd.text}`}
                onClick={() => persist(removeCustomCommand(custom, cmd.text))}
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="quick-add">
        <input
          className="quick-input"
          value={draft}
          placeholder="自定义指令…"
          aria-label="自定义快捷指令"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const next = addCustomCommand(custom, draft);
              persist(next);
              setDraft("");
            }
          }}
        />
        <button
          type="button"
          className="quick-add-btn"
          onClick={() => {
            persist(addCustomCommand(custom, draft));
            setDraft("");
          }}
        >
          添加
        </button>
      </div>
    </div>
  );
}
