/**
 * 会话列表 tab 过滤（纯函数）：[全部] [🔥工作中] [⚠️等你处理] [✅今日完成]。
 * 过滤保持输入顺序（排序统一走 sortSessions 的 updatedAt 倒序，稳定不重排）。
 */
import type { SessionSummary } from "../api/types";

export type SessionTab = "all" | "working" | "attention" | "done";

export const SESSION_TABS: ReadonlyArray<{ value: SessionTab; label: string }> = [
  { value: "all", label: "全部" },
  { value: "working", label: "🔥工作中" },
  { value: "attention", label: "⚠️等你处理" },
  { value: "done", label: "✅今日完成" },
];

export interface SessionTabIds {
  /** 等你处理会话 id（来自 dashboard stats 的 attentionSessions） */
  attentionIds: ReadonlySet<string>;
  /** 今日完成会话 id（来自 dashboard stats 的 todayDoneSessions） */
  doneIds: ReadonlySet<string>;
}

export function filterSessionsByTab(
  sessions: SessionSummary[],
  tab: SessionTab,
  ids: SessionTabIds,
): SessionSummary[] {
  switch (tab) {
    case "working":
      return sessions.filter((s) => s.status === "running");
    case "attention":
      return sessions.filter((s) => ids.attentionIds.has(s.id));
    case "done":
      return sessions.filter((s) => ids.doneIds.has(s.id));
    default:
      return sessions;
  }
}
