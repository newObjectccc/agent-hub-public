/**
 * 通知聚合（docs/API_CONTRACT.md §5）：
 * 从会话事件（agent_settled / error / steering / done）与历史会话扫描聚合出
 * 最近 50 条通知；read 标记用简单 JSON 文件持久化（无 DB）。
 *
 * 纯函数优先（merge / read 标记 / 近重复折叠均可单测），文件 IO 收敛在
 * loadReadMarks / saveReadMarks 两个薄封装。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { NotificationItem, NotificationKind } from "./types.js";
import type { SessionInsight } from "./sessions/scan.js";
import { truncateText } from "./sessions/scan.js";

export const NOTIFICATION_TEXT_LIMIT = 120;
export const DEFAULT_MAX_NOTIFICATIONS = 50;
/** 同会话同类型、时间相差在此窗口内的条目视为同一次事件（重启回填去重） */
export const NEAR_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

/** 确定性 id：重启后历史回填的同一条通知 id 不变（read 标记才持久有效） */
export function notificationId(sessionId: string, kind: NotificationKind, timestamp: string): string {
  return `${sessionId}:${kind}:${timestamp}`;
}

export interface NotificationDraft {
  sessionId: string;
  sessionName?: string | null;
  kind: NotificationKind;
  text: string;
  timestamp: string;
}

export function makeNotification(draft: NotificationDraft): NotificationItem {
  return {
    id: notificationId(draft.sessionId, draft.kind, draft.timestamp),
    sessionId: draft.sessionId,
    sessionName: draft.sessionName ?? null,
    kind: draft.kind,
    text: truncateText(draft.text === "" ? "（无内容）" : draft.text, NOTIFICATION_TEXT_LIMIT),
    timestamp: draft.timestamp,
    read: false,
  };
}

/**
 * 合并多路通知：按 id 去重（后者覆盖前者）、近重复折叠（同会话同类型、时间接近
 * 只保留文本更丰富的一条）、按时间倒序、截断 maxItems。
 */
export function mergeNotifications(
  lists: NotificationItem[][],
  maxItems = DEFAULT_MAX_NOTIFICATIONS,
  windowMs = NEAR_DUPLICATE_WINDOW_MS,
): NotificationItem[] {
  const byId = new Map<string, NotificationItem>();
  for (const list of lists) {
    for (const item of list) byId.set(item.id, item);
  }
  const sorted = [...byId.values()].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  const kept: NotificationItem[] = [];
  for (const item of sorted) {
    const dupIdx = kept.findIndex(
      (k) =>
        k.sessionId === item.sessionId &&
        k.kind === item.kind &&
        Math.abs(Date.parse(k.timestamp) - Date.parse(item.timestamp)) <= windowMs,
    );
    if (dupIdx >= 0) {
      // 近重复：保留文本更丰富（更长）的一条，read 状态取“已读优先”（不重新变未读）
      const existing = kept[dupIdx];
      const read = item.read || existing.read;
      kept[dupIdx] = item.text.length > existing.text.length ? { ...item, read } : { ...existing, read };
      continue;
    }
    kept.push(item);
    if (kept.length >= maxItems) break;
  }
  return kept;
}

/** 叠加 read 标记（纯函数） */
export function applyReadMarks(items: NotificationItem[], readIds: ReadonlySet<string>): NotificationItem[] {
  return items.map((item) => (readIds.has(item.id) ? { ...item, read: true } : { ...item, read: false }));
}

export function unreadCountOf(items: NotificationItem[]): number {
  return items.reduce((n, item) => (item.read ? n : n + 1), 0);
}

/** 会话历史扫描 → 回填通知（等你处理/出错的会话浮出，含最后输出摘要） */
export function seedNotificationsFromInsights(insights: SessionInsight[]): NotificationItem[] {
  const items: NotificationItem[] = [];
  for (const insight of insights) {
    const { summary, lastMessageRole } = insight;
    const timestamp = summary.updatedAt;
    if (summary.status === "error") {
      items.push(
        makeNotification({
          sessionId: summary.id,
          sessionName: summary.name,
          kind: "error",
          text: summary.lastAssistantMessage ?? summary.lastUserMessage ?? "会话运行出错",
          timestamp,
        }),
      );
    } else if (summary.status !== "running" && lastMessageRole === "assistant") {
      items.push(
        makeNotification({
          sessionId: summary.id,
          sessionName: summary.name,
          kind: "settled",
          text: summary.lastAssistantMessage ?? "agent 已完成本轮工作，等你确认",
          timestamp,
        }),
      );
    }
  }
  return items;
}

/** read 标记文件解析（损坏/缺失回退空列表） */
export function parseReadMarks(raw: string | null): string[] {
  if (raw === null || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw) as { readIds?: unknown };
    if (Array.isArray(parsed.readIds)) {
      return parsed.readIds.filter((id): id is string => typeof id === "string");
    }
    return [];
  } catch {
    return [];
  }
}

export function serializeReadMarks(readIds: string[]): string {
  return `${JSON.stringify({ readIds }, null, 2)}\n`;
}

/** read 标记文件加载（无文件/读失败 → 空集合） */
export async function loadReadMarks(file: string): Promise<Set<string>> {
  try {
    const raw = await readFile(file, "utf8");
    return new Set(parseReadMarks(raw));
  } catch {
    return new Set();
  }
}

/** read 标记文件写入（写失败不抛：内存态已生效，下次启动重新对齐） */
export async function saveReadMarks(file: string, readIds: ReadonlySet<string>): Promise<void> {
  // 只保留最近 1000 条，防止文件无限增长
  const ids = [...readIds].slice(-1000);
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, serializeReadMarks(ids), "utf8");
  } catch {
    // 持久化失败不影响本次会话内状态
  }
}
