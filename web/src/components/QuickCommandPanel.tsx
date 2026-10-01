import { useDismissable } from "../hooks/useDismissable";
import { useRef, useState } from "react";
import { handlePanelKeyNav } from "../utils/panelNav";
import {
  addCustomQuickCommand,
  emptyQuickCommandState,
  loadQuickCommandState,
  mergeQuickCommands,
  removeQuickCommand,
  restoreBuiltinQuickCommands,
  saveQuickCommandState,
  updateQuickCommand,
  type QuickCommand,
  type QuickCommandState,
  type StorageLike,
} from "../utils/quickCommands";
import { safeStorage } from "../utils/recentRefs";

export interface QuickCommandPanelProps {
  /** 触发按钮锚点（面板外的 ⚡）：其上点击不误关面板 */
  anchorRef?: { current: HTMLElement | null } | null;
  open: boolean;
  /** 发送中禁用插入（与 composer 按钮的禁用行为一致） */
  disabled?: boolean;
  /** 点击模板：插入输入框光标处（可编辑后发送） */
  onInsert: (text: string) => void;
  onClose: () => void;
}

/** 条目标签：内置 / 自定义 */
function itemTag(cmd: QuickCommand): string {
  return cmd.builtin ? "内置" : "自定义";
}

/**
 * 快捷指令面板（浮层贴输入框上方，形态参照 SlashCommandPanel）：
 * - 普通模式：点条目插入模板到输入框光标处
 * - 管理模式：点条目编辑、✕ 删除（两步确认防误触）、恢复内置默认（两步确认）
 * - 自定义模板 localStorage 持久化（键 agent-hub.quickCommands.v1），刷新不丢
 * - 列表可滚动（模板多不撑破视口），Esc / 点外部关闭
 */
export function QuickCommandPanel({ anchorRef, open, disabled = false, onInsert, onClose }: QuickCommandPanelProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<QuickCommandState>(() => {
    const storage: StorageLike | null = typeof window === "undefined" ? null : safeStorage();
    return storage ? loadQuickCommandState(storage) : emptyQuickCommandState();
  });
  const [manage, setManage] = useState(false);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  /** 两步确认：删除/恢复默认第一击进入待确认态，第二击才生效（防误触） */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);

  // 点外部/Esc 关闭 + 与其他弹层互斥
  useDismissable({
    open,
    onDismiss: onClose,
    rootRef,
    anchorRefs: anchorRef ? [anchorRef as { current: HTMLElement | null }] : [],
  });

  if (!open) return null;

  /** 状态变更 + 持久化（存储不可用时降级为仅内存） */
  const persist = (next: QuickCommandState) => {
    setState(next);
    const storage: StorageLike | null = typeof window === "undefined" ? null : safeStorage();
    if (storage) saveQuickCommandState(storage, next);
  };

  const items = mergeQuickCommands(state);

  const startEdit = (cmd: QuickCommand) => {
    setEditingId(cmd.id);
    setEditDraft(cmd.text);
    setConfirmDeleteId(null);
  };

  const saveEdit = () => {
    if (editingId === null) return;
    const trimmed = editDraft.trim();
    if (trimmed === "") return; // 空文本不保存（删除走删除按钮）
    persist(updateQuickCommand(state, editingId, trimmed));
    setEditingId(null);
    setEditDraft("");
  };

  const addDraft = () => {
    const next = addCustomQuickCommand(state, draft);
    if (next.custom.length !== state.custom.length) {
      persist(next);
      setDraft("");
    }
  };

  return (
    <div
      className="quick-panel"
      role="dialog"
      aria-label="快捷指令"
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
      <div className="quick-head">
        <span className="quick-title">⚡ 快捷指令</span>
        <span className="quick-hint-inline">
          {manage ? "管理模式：点条目编辑 · ✕ 删除" : "点选插入到输入框 · Esc 关闭"}
        </span>
        <button
          type="button"
          className="quick-manage"
          aria-pressed={manage}
          onClick={() => {
            setManage((v) => !v);
            setEditingId(null);
            setConfirmDeleteId(null);
            setConfirmRestore(false);
          }}
        >
          {manage ? "完成" : "管理"}
        </button>
        <button type="button" className="quick-close" onClick={onClose} aria-label="关闭快捷指令">
          ✕
        </button>
      </div>
      {items.length === 0 && (
        <div className="quick-empty">暂无模板：在下方添加自定义，或进「管理」恢复内置默认</div>
      )}
      <div className="quick-list">
        {items.map((cmd) =>
          editingId === cmd.id ? (
            <div className="quick-item" key={cmd.id}>
              <input
                className="quick-input"
                value={editDraft}
                aria-label={`编辑模板 ${cmd.text}`}
                onChange={(e) => setEditDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveEdit();
                  }
                }}
              />
              <button type="button" className="quick-save" onClick={saveEdit}>
                保存
              </button>
              <button
                type="button"
                className="quick-cancel"
                onClick={() => {
                  setEditingId(null);
                  setEditDraft("");
                }}
              >
                取消
              </button>
            </div>
          ) : (
            <div className="quick-item" key={cmd.id}>
              <button
                type="button"
                data-nav="1"
                className="quick-insert"
                disabled={manage ? false : disabled}
                aria-label={manage ? `编辑模板 ${cmd.text}` : `插入模板 ${cmd.text}`}
                onClick={() => {
                  if (manage) {
                    startEdit(cmd);
                    return;
                  }
                  onInsert(cmd.text);
                  onClose();
                }}
              >
                <span className={`quick-tag${cmd.builtin ? "" : " custom"}`}>{itemTag(cmd)}</span>
                <span className="quick-text">{cmd.text}</span>
              </button>
              {manage && (
                <button
                  type="button"
                  className={`quick-delete${confirmDeleteId === cmd.id ? " confirming" : ""}`}
                  aria-label={
                    confirmDeleteId === cmd.id ? `确认删除模板 ${cmd.text}` : `删除模板 ${cmd.text}（需二次确认）`
                  }
                  onClick={() => {
                    if (confirmDeleteId === cmd.id) {
                      persist(removeQuickCommand(state, cmd.id));
                      setConfirmDeleteId(null);
                      if (editingId === cmd.id) setEditingId(null);
                    } else {
                      setConfirmDeleteId(cmd.id);
                    }
                  }}
                >
                  {confirmDeleteId === cmd.id ? "确认" : "✕"}
                </button>
              )}
            </div>
          ),
        )}
      </div>
      <div className="quick-add">
        <input
          className="quick-input"
          value={draft}
          placeholder="自定义模板…"
          aria-label="自定义快捷指令模板"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addDraft();
            }
          }}
        />
        <button type="button" className="quick-add-btn" onClick={addDraft}>
          添加
        </button>
      </div>
      {manage && (
        <button
          type="button"
          className={`quick-restore${confirmRestore ? " confirming" : ""}`}
          onClick={() => {
            if (confirmRestore) {
              persist(restoreBuiltinQuickCommands(state));
              setConfirmRestore(false);
            } else {
              setConfirmRestore(true);
            }
          }}
        >
          {confirmRestore ? "确认恢复内置默认？" : "恢复内置默认"}
        </button>
      )}
    </div>
  );
}
