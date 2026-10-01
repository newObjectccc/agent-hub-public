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
/** 语义化摘要（「已完成：<任务>」等）的任务截断长度 */
export const NOTIFICATION_SUMMARY_LIMIT = 30;
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
  /** pi-subagents 派生的子代理会话通知（前端聚合展示） */
  isSubAgent?: boolean;
}

/**
 * markdown → 纯文本（通知摘要用）：去围栏/标题/列表/引用/分隔线等标记，
 * 链接保留文字、行内代码/粗斜体保留内容，空白折叠为单行。
 * 纯函数、可单测：原始 assistant 输出里的 ``` ✅ PASS / --- # R2 这类 markdown
 * 垃圾不得再直接出现在通知列表里。
 */
export function plainText(input: string): string {
  let text = input;
  // 围栏代码块标记行去掉（保留内容行）
  text = text.replace(/^[ \t]*(?:```|~~~)[^\n]*$/gm, " ");
  // 行首标记：标题 / 引用 / 列表 / 任务框 / 分隔线
  text = text
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}(?:>+[ \t]?)+/gm, "")
    .replace(/^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}\[[ xX]\][ \t]+/gm, "")
    .replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm, " ");
  // 行内标记：图片/链接 → 文字；行内代码/粗体/斜体/删除线 → 内容；HTML 标签去掉
  text = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/(?<![A-Za-z0-9_])\*([^*\n]+)\*(?![A-Za-z0-9_])/g, "$1")
    .replace(/(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/<[^>]+>/g, " ");
  return text.replace(/\s+/g, " ").trim();
}

function summarize(text: string | null | undefined): string | null {
  if (!text) return null;
  const clean = plainText(text);
  return clean === "" ? null : truncateText(clean, NOTIFICATION_SUMMARY_LIMIT);
}

/** 首句纯文本摘要：先取首个非空行（换行=句子边界），再去 markdown、按句末标点断句 */
function firstSentence(text: string | null | undefined): string | null {
  if (!text) return null;
  const firstLine =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "") ?? "";
  const clean = plainText(firstLine);
  if (clean === "") return null;
  const idx = clean.search(/[。！？.!?；;]/);
  const sentence = idx >= 0 ? clean.slice(0, idx + 1) : clean;
  return truncateText(sentence, NOTIFICATION_SUMMARY_LIMIT);
}

export interface NotificationSummaryInput {
  kind: NotificationKind;
  /** 本轮最后一条 user 消息（任务名语义） */
  lastUserText?: string | null;
  /** 最后一条 assistant 消息（fallback 摘要来源） */
  lastAssistantText?: string | null;
  /** 全部无内容时的兜底文案 */
  fallback: string;
}

/**
 * 语义化通知摘要（纯函数）：
 * - settled：`已完成：<最后 user 消息清洗 30 字>`（任务名语义）；无 user 时退化为
 *   assistant 首句纯文本；再无则 fallback。
 * - steering：`被插话：<插话内容清洗 30 字>`，无则 fallback。
 */
export function notificationSummary(input: NotificationSummaryInput): string {
  const user = summarize(input.lastUserText);
  const assistant = firstSentence(input.lastAssistantText);
  switch (input.kind) {
    case "settled":
      return user ? `已完成：${user}` : assistant ?? input.fallback;
    case "steering":
      return user ? `被插话：${user}` : input.fallback;
    default:
      return assistant ?? user ?? input.fallback;
  }
}

/**
 * 未读待办语义（全链路统一：服务端 unreadCount / 前端角标 / 列表高亮共用）：
 * kind=done（已手动中止）是噪声回执、不是待办，不计未读（需求 4）。
 */
export function countsAsUnread(item: Pick<NotificationItem, "read" | "kind">): boolean {
  return !item.read && item.kind !== "done";
}

export function makeNotification(draft: NotificationDraft): NotificationItem {
  const cleaned = plainText(draft.text);
  return {
    id: notificationId(draft.sessionId, draft.kind, draft.timestamp),
    sessionId: draft.sessionId,
    sessionName: draft.sessionName ?? null,
    kind: draft.kind,
    text: truncateText(cleaned === "" ? "（无内容）" : cleaned, NOTIFICATION_TEXT_LIMIT),
    timestamp: draft.timestamp,
    read: false,
    isSubAgent: draft.isSubAgent ?? false,
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
  return items.reduce((n, item) => (countsAsUnread(item) ? n + 1 : n), 0);
}

/**
 * 会话历史扫描 → 回填通知（等你处理/出错的会话浮出，含最后输出摘要）。
 *
 * 依赖检查（AC4）：本函数只消费 insight.summary / lastMessageRole（摘要文本
 * lastUserMessage/lastAssistantMessage 已由 buildSessionSummary 在构建期算好），
 * 不依赖全量 messages——Insight 瘦身后输出逐字不变。
 */
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
          isSubAgent: summary.isSubAgent,
        }),
      );
    } else if (summary.status !== "running" && lastMessageRole === "assistant") {
      items.push(
        makeNotification({
          sessionId: summary.id,
          sessionName: summary.name,
          kind: "settled",
          text: notificationSummary({
            kind: "settled",
            lastUserText: summary.lastUserMessage,
            lastAssistantText: summary.lastAssistantMessage,
            fallback: "agent 已完成本轮工作，等你确认",
          }),
          timestamp,
          isSubAgent: summary.isSubAgent,
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
