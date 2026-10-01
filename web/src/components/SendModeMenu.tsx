/**
 * 发送模式收纳（反馈轮 3 #3）：原「自动/新消息/插话/排队」一排 chips 收成一个小图标按钮
 * （显示当前模式），点开弹出模式选择面板——每项带一句话说明（解决"无解释"）。
 * 功能语义不变：auto / prompt / steer / followUp 四模式全保留可用；
 * 中止不在此组件（running 时由 ChatPage 独立显示红色小按钮）。
 */
import { useRef, useState } from "react";
import type { SendMode } from "../api/prompt";
import { useDismissable } from "../hooks/useDismissable";

export interface SendModeOption {
  key: SendMode;
  /** 菜单项完整标签 */
  label: string;
  /** 触发按钮上的紧凑显示（icon + 短名） */
  short: string;
  /** 一句话说明（菜单项描述文案） */
  hint: string;
}

/** 发送模式选项：默认「自动」保留 409 降级；手动模式直接带对应 mode 提交 */
export const SEND_MODE_OPTIONS: readonly SendModeOption[] = [
  { key: "auto", label: "⚡ 自动", short: "⚡ 自动", hint: "默认：会话正忙时自动排队（followUp）" },
  { key: "prompt", label: "💬 新消息", short: "💬 新消息", hint: "直接以 mode=prompt 发送（正忙时会 409）" },
  { key: "steer", label: "✋ 插话(steer)", short: "✋ 插话", hint: "插入当前运行之后，让 agent 立即转向（仅本轮生效）" },
  { key: "followUp", label: "⏭ 排队(followUp)", short: "⏭ 排队", hint: "排队到当前这轮结束后发送（仅本轮生效）" },
];

export function SendModeMenu({ value, onChange }: { value: SendMode; onChange: (mode: SendMode) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useDismissable({ open, onDismiss: () => setOpen(false), rootRef: wrapRef, anchorRefs: [btnRef] });

  const current = SEND_MODE_OPTIONS.find((o) => o.key === value) ?? SEND_MODE_OPTIONS[0];

  return (
    <div className="mode-menu-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="mode-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`发送模式：${current.label}（点击切换）`}
        title={`发送模式：${current.label}——${current.hint}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="mode-trigger-label">{current.short}</span>
        <span className="mode-trigger-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="mode-menu" role="menu" aria-label="发送模式选择">
          {SEND_MODE_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              role="menuitemradio"
              aria-checked={value === opt.key}
              className={`mode-menu-item${value === opt.key ? " active" : ""}`}
              onClick={() => {
                onChange(opt.key);
                setOpen(false);
                btnRef.current?.focus();
              }}
            >
              <span className="mode-menu-label">{opt.label}</span>
              <span className="mode-menu-hint">{opt.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
