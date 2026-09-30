/**
 * 双模式切换徽章（E3）：chat 顶栏一个紧凑触发器（🖥 接管 ▾ / 📱 平行 ▾），
 * 点击弹出小菜单二选一（每项一句话说明）——零额外常驻占位。
 * 接管不可用（终端离线/扩展未装）时接管项灰显 + 原因。
 */
import { useRef, useState } from "react";
import type { TerminalAttachInfo } from "../api/types";
import { attachAvailability, type AttachMode } from "../api/attach";
import { useDismissable } from "../hooks/useDismissable";

export interface AttachModeMenuProps {
  mode: AttachMode;
  terminal: TerminalAttachInfo | null | undefined;
  onChange: (mode: AttachMode) => void;
  busy?: boolean;
}

const MODE_HINTS: Record<AttachMode, string> = {
  parallel: "手机消息由 server 里的 pi 实例继续处理（现状，双方互不干扰）",
  attach: "手机消息发往电脑终端 pi 进程，终端实时显示并执行",
};

export function AttachModeMenu({ mode, terminal, onChange, busy }: AttachModeMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const { attachEnabled, attachDisabledReason } = attachAvailability(terminal);

  useDismissable({ open, onDismiss: () => setOpen(false), rootRef: wrapRef, anchorRefs: [btnRef] });

  const triggerLabel = mode === "attach" ? "🖥 接管" : "📱 平行";

  return (
    <div className="attach-menu-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="attach-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`会话驱动模式：${triggerLabel}（点击切换）`}
        title={`会话驱动模式：${triggerLabel}——${MODE_HINTS[mode]}`}
        disabled={busy === true}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="attach-trigger-label">{triggerLabel}</span>
        <span className="attach-trigger-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="attach-menu" role="menu" aria-label="会话驱动模式选择">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={mode === "parallel"}
            className={`attach-menu-item${mode === "parallel" ? " active" : ""}`}
            onClick={() => {
              onChange("parallel");
              setOpen(false);
              btnRef.current?.focus();
            }}
          >
            <span className="attach-menu-label">📱 平行继续</span>
            <span className="attach-menu-hint">{MODE_HINTS.parallel}</span>
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={mode === "attach"}
            className={`attach-menu-item${mode === "attach" ? " active" : ""}${attachEnabled ? "" : " disabled"}`}
            aria-disabled={!attachEnabled}
            title={attachEnabled ? MODE_HINTS.attach : (attachDisabledReason ?? "")}
            onClick={() => {
              if (!attachEnabled) return;
              onChange("attach");
              setOpen(false);
              btnRef.current?.focus();
            }}
          >
            <span className="attach-menu-label">🖥 接管终端</span>
            <span className="attach-menu-hint">{attachEnabled ? MODE_HINTS.attach : attachDisabledReason}</span>
          </button>
        </div>
      )}
    </div>
  );
}
