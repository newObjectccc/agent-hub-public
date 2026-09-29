/**
 * 会话消息分页（GET /api/sessions/:id?before=<messageId>&limit=<n>，契约补充）。
 *
 * 语义（docs/API_CONTRACT.md §1）：
 * - 不带查询参数：保持 v0 行为，返回 active branch 全量消息（hasMore=false）
 * - `limit=N`：返回尾部 N 条（chat 首屏懒加载用）
 * - `before=<id>`：返回该 id **之前**（不含）的最近 N 条（上滑加载更早消息）
 * - `hasMore`：本页之前是否还有更早消息
 * - `nextBefore`：下一页游标 = 本页最早一条消息 id；无更早消息为 null
 *
 * 纯函数，便于单测。未知 `before` 游标时退化为尾部窗口（客户端按 id 去重合并，
 * 不会因游标漂移破坏历史）。
 */
import type { MessageDto } from "../types.js";

/** chat 首屏 / 上滑加载的默认页大小 */
export const DEFAULT_PAGE_LIMIT = 50;
/** limit 上限（防一次性拉爆内存） */
export const MAX_PAGE_LIMIT = 500;

export interface MessagePage {
  messages: MessageDto[];
  /** 本页之前是否还有更早消息 */
  hasMore: boolean;
  /** 下一页 before 游标（本页最早一条消息 id）；无更早消息时 null */
  nextBefore: string | null;
}

/** 无分页查询时的全量响应（v0 兼容） */
export function fullPage(messages: MessageDto[]): MessagePage {
  return { messages, hasMore: false, nextBefore: null };
}

/**
 * 校验并归一 limit：整数、1..MAX_PAGE_LIMIT。
 * 非法值返回 null（由调用方决定报错），缺省返回 DEFAULT_PAGE_LIMIT。
 */
export function parseLimit(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number(String(raw));
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_LIMIT) return null;
  return n;
}

function tailWindow(messages: MessageDto[], limit: number): MessagePage {
  const start = Math.max(0, messages.length - limit);
  const window = messages.slice(start);
  return {
    messages: window,
    hasMore: start > 0,
    nextBefore: start > 0 && window.length > 0 ? window[0].id : null,
  };
}

/** 按 before 游标 + limit 切一页更早消息 */
export function paginateMessages(
  messages: MessageDto[],
  options: { before?: string | null; limit?: number | null } = {},
): MessagePage {
  const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
  const before = typeof options.before === "string" && options.before !== "" ? options.before : null;
  if (!before) return tailWindow(messages, limit);

  const idx = messages.findIndex((m) => m.id === before);
  // 未知游标：退化为尾部窗口（幂等安全，客户端按 id 去重）
  if (idx === -1) return tailWindow(messages, limit);

  const start = Math.max(0, idx - limit);
  const window = messages.slice(start, idx);
  return {
    messages: window,
    hasMore: start > 0,
    nextBefore: start > 0 && window.length > 0 ? window[0].id : null,
  };
}
