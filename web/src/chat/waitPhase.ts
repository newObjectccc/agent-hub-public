/**
 * 阶段化等待反馈（发消息 → 回复完成之间的可见反馈）：
 * 发送中 → 🧠 思考中 → 🔧 工具执行中 → ✍️ 回复中 → 完成。
 * 纯状态推导（WS 事件 → 阶段），UI 层只负责展示与计时。
 */

export type WaitPhase = "sending" | "thinking" | "tool" | "replying";

export const WAIT_PHASE_META: Record<WaitPhase, { icon: string; label: string }> = {
  sending: { icon: "📤", label: "发送中" },
  thinking: { icon: "🧠", label: "思考中" },
  tool: { icon: "🔧", label: "工具执行中" },
  replying: { icon: "✍️", label: "回复中" },
};

/**
 * 事件 → 阶段推进：
 * - message_start / thinking_delta → 思考中（新一轮 / 思维链产出）
 * - tool_start → 工具执行中；tool_end → 回到思考（等下一步；连续工具会再切回）
 * - text_delta → 回复中
 * - message_end 等其余事件保持不变（pi 的工具执行常发生在 message_end 之后）
 */
export function waitPhaseAfterEvent(phase: WaitPhase, eventType: string): WaitPhase {
  switch (eventType) {
    case "message_start":
    case "thinking_delta":
      return "thinking";
    case "tool_start":
      return "tool";
    case "tool_end":
      return "thinking";
    case "text_delta":
      return "replying";
    default:
      return phase;
  }
}

/** 已等待时长文案：`45s` / `2m 5s`（秒级跳动，分钟封顶 99m+） */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}
