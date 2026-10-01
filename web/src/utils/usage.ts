/**
 * Token 用量前端工具（契约 §14）：紧凑数字格式化（12.3k / 1.2M）、会话用量索引。
 * 纯函数，组件按需消费；无数据/失败场景由组件安静降级（占位或隐藏）。
 */
import type { SessionUsage, UsageTotals } from "../api/types";

function trimZeros(s: string): string {
  return s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

/** tokens → 紧凑显示：<1k 原样；k/M 各保留 1-2 位小数并去尾零（非法值回 0） */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${trimZeros((n / 1_000).toFixed(1))}k`;
  return `${trimZeros((n / 1_000_000).toFixed(2))}M`;
}

/** GET /api/usage 的 sessions[] → sessionId 用量索引（会话卡片零额外请求） */
export function usageBySession(sessions: SessionUsage[]): Map<string, UsageTotals> {
  return new Map(sessions.map((s) => [s.sessionId, s.usage]));
}
