/**
 * 会话筛选纯逻辑：来源（pi / claude / codex）多选过滤。
 *
 * 设计口径（用户习惯）：tab 管「状态」（高频主切分，1 击可达），来源管「agent」（次切分，
 * 收进筛选面板）——两维正交叠加：tabSessions = filterBySource(filterByTab(...))。
 * 空集合 = 不筛选；多个来源 = 并集。纯函数，供测试。
 */
import type { SessionSummary } from "../api/types";

export type SourceOption = "pi" | "claude" | "codex";

/** 来源选项（顺序即展示顺序；codex 与服务端适配层同步上线） */
export const SOURCE_OPTIONS: ReadonlyArray<{ value: SourceOption; label: string }> = [
  { value: "pi", label: "pi" },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
];

/** 来源过滤：active 空 = 全部；否则保留 source 命中者（字符串比较，对 source 联合类型演进零耦合） */
export function filterSessionsBySource<T extends { source?: string | null }>(
  sessions: T[],
  active: ReadonlySet<string>,
): T[] {
  if (active.size === 0) return sessions;
  return sessions.filter((s) => active.has(String(s.source ?? "")));
}

/** 各来源计数（筛选面板 chips 决策依据：pi 60 / Claude 40 / Codex 90） */
export function sourceCounts(sessions: ReadonlyArray<{ source?: string | null }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sessions) {
    const key = String(s.source ?? "");
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
