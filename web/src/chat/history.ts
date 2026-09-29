/**
 * chat 消息历史懒加载：进页面先渲染尾部 ~TAIL_MESSAGE_LIMIT 条，
 * 上滑/点按钮加载更早一页（GET /api/sessions/:id?before=&limit=）。
 *
 * 合并规则（纯函数，便于单测）：
 * - 早页只往头部前插，尾部（流式/乐观占位消息）保持不动
 * - 按 id 去重：WS 流式消息与 REST 分页重叠时不产生重复气泡
 */
import type { SessionMessage } from "../api/types";

/** 首屏尾部消息条数 */
export const TAIL_MESSAGE_LIMIT = 50;
/** 每次向上加载的页大小 */
export const OLDER_PAGE_LIMIT = 50;
/** 距顶部多少 px 内触发自动加载更早消息 */
export const LOAD_OLDER_SCROLL_THRESHOLD_PX = 240;

/** 把更早一页并入现有列表（前插 + 按 id 去重） */
export function mergeOlderMessages(current: SessionMessage[], older: SessionMessage[]): SessionMessage[] {
  const seen = new Set(current.map((m) => m.id));
  const head = older.filter((m) => !seen.has(m.id));
  return head.length > 0 ? [...head, ...current] : current;
}

/** 当前已加载窗口的最早消息 id（下一页 before 游标） */
export function oldestMessageId(messages: SessionMessage[]): string | null {
  return messages.length > 0 ? messages[0].id : null;
}

/**
 * 是否触发自动加载更早消息（纯函数）：
 * 已到顶附近、还有更早消息、且不在加载中。
 */
export function shouldLoadOlder(input: { scrollTop: number; hasMore: boolean; loading: boolean }): boolean {
  return input.hasMore && !input.loading && input.scrollTop <= LOAD_OLDER_SCROLL_THRESHOLD_PX;
}
