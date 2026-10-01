/**
 * 发送模式回合语义（UX 审查 AC4「发送模式静默重置」修复）：
 * - 粘性模式（auto/prompt）：用户显式选择保留，回合结束绝不静默改回 auto
 * - 一次性模式（steer/followUp）：语义只对当前运行轮次有效（"插入当前运行之后"/
 *   "排队到当前这轮结束后发送"），回合结束自动复位为 auto——复位时给一行轻提示（不静默）
 * 纯函数可测。
 */
import type { SendMode } from "../api/prompt";

/** 一次性发送模式（绑定当前轮次，轮次结束即失效） */
export const ONE_SHOT_SEND_MODES: readonly SendMode[] = ["steer", "followUp"];

const MODE_SHORT_LABEL: Record<string, string> = {
  auto: "⚡ 自动",
  prompt: "💬 新消息",
  steer: "✋ 插话",
  followUp: "⏭ 排队",
};

export function isOneShotSendMode(mode: SendMode): boolean {
  return (ONE_SHOT_SEND_MODES as readonly string[]).includes(mode);
}

export interface RoundEndModeResult {
  /** 回合结束后的发送模式 */
  mode: SendMode;
  /** 非 null = 发生了自动复位，调用方给一行轻提示（替代旧的静默重置） */
  notice: string | null;
}

/** 回合结束时的发送模式复位（粘性选择保留；一次性模式复位 + 轻提示） */
export function resolveRoundEndMode(current: SendMode): RoundEndModeResult {
  if (!isOneShotSendMode(current)) return { mode: current, notice: null };
  const label = MODE_SHORT_LABEL[current] ?? current;
  return { mode: "auto", notice: `发送模式已恢复 ⚡ 自动（${label} 仅对本轮生效）` };
}
