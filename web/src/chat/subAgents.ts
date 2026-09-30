/**
 * 子代理活动状态合并（纯函数，反馈轮 3 #4）：
 * GET /api/sessions/:id/agents 全量快照 + WS `subagent_activity` 增量事件共用同一活动模型。
 * 增量事件只带变化字段（tool/message/status 摘要），按 sessionId 合并进列表。
 */
import type { SubAgentActivity } from "../api/types";

/** WS subagent_activity 增量（server 只发变化字段） */
export interface SubAgentActivityUpdate {
  sessionId: string;
  name?: string;
  status?: SubAgentActivity["status"];
  currentTool?: string | null;
  toolRunning?: boolean;
  lastOutput?: string | null;
  startedAt?: number | null;
  updatedAt?: number;
  done?: boolean;
  resultSummary?: string | null;
}

export function isSubAgentActivityUpdate(value: unknown): value is SubAgentActivityUpdate {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { sessionId?: unknown }).sessionId === "string" &&
    (value as { sessionId: string }).sessionId !== ""
  );
}

/** 按 sessionId 合并增量；新子代理插入到列表尾部（保持稳定顺序） */
export function mergeSubAgentActivity(list: SubAgentActivity[], update: SubAgentActivityUpdate): SubAgentActivity[] {
  const idx = list.findIndex((a) => a.sessionId === update.sessionId);
  if (idx < 0) {
    const created: SubAgentActivity = {
      sessionId: update.sessionId,
      name: update.name ?? update.sessionId,
      status: update.status ?? "running",
      currentTool: update.currentTool ?? null,
      toolRunning: update.toolRunning ?? false,
      lastOutput: update.lastOutput ?? null,
      startedAt: update.startedAt ?? update.updatedAt ?? Date.now(),
      updatedAt: update.updatedAt ?? Date.now(),
      done: update.done ?? false,
      resultSummary: update.resultSummary ?? null,
    };
    return [...list, created];
  }
  const next = list.slice();
  const prev = list[idx];
  const merged: SubAgentActivity = {
    ...prev,
    ...Object.fromEntries(Object.entries(update).filter(([k, v]) => k !== "sessionId" && v !== undefined)),
  } as SubAgentActivity;
  // done 后回填结果摘要（完成后仍来的增量不清空已有摘要）
  if (merged.done && merged.resultSummary === null && merged.lastOutput !== null) {
    merged.resultSummary = merged.lastOutput;
  }
  next[idx] = merged;
  return next;
}

/** 全量快照替换（初始加载/重连对账） */
export function replaceSubAgents(_prev: SubAgentActivity[], fresh: SubAgentActivity[]): SubAgentActivity[] {
  return fresh;
}

/** 已运行时长标签（mm:ss / h:mm:ss） */
export function elapsedLabel(startedAt: number | null, nowMs: number): string {
  if (startedAt === null) return "0:00";
  const sec = Math.max(0, Math.floor((nowMs - startedAt) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
