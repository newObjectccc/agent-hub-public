import type { SendMode } from "../api/prompt";

export interface SendModeOption {
  key: SendMode;
  label: string;
  hint: string;
}

/** 发送模式选项：默认「自动」保留 409 降级；手动模式直接带对应 mode 提交 */
export const SEND_MODE_OPTIONS: readonly SendModeOption[] = [
  { key: "auto", label: "⚡ 自动", hint: "默认：会话正忙时自动排队（followUp）" },
  { key: "prompt", label: "💬 新消息", hint: "直接以 mode=prompt 发送（正忙时会 409）" },
  { key: "steer", label: "✋ 插话(steer)", hint: "插入当前运行之后，让 agent 立即转向" },
  { key: "followUp", label: "⏭ 排队(followUp)", hint: "排队到当前这轮结束后发送" },
];

export function SendModeSwitch({ value, onChange }: { value: SendMode; onChange: (mode: SendMode) => void }) {
  return (
    <div className="mode-switch" role="radiogroup" aria-label="发送模式">
      {SEND_MODE_OPTIONS.map((opt) => (
        <button
          key={opt.key}
          type="button"
          role="radio"
          aria-checked={value === opt.key}
          className={`mode-chip${value === opt.key ? " active" : ""}`}
          title={opt.hint}
          onClick={() => onChange(opt.key)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
