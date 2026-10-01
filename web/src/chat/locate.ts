/**
 * 搜索深链定位（UX 审查 AC2）：目标消息不在已加载尾部时，
 * 按 before 游标自动加载更早页直到命中；页数上限防无限拉取，仍未命中由调用方给轻提示。
 * 纯逻辑（加载器注入）可单测。
 */
import type { SessionMessage } from "../api/types";
import { mergeOlderMessages, oldestMessageId } from "./history";
import { locateHitId, type LocateTarget } from "../utils/search";

/** 自动回溯加载的页数上限（~6 页 × 50 条 ≈ 300 条，防无限拉取） */
export const LOCATE_MAX_PAGES = 6;

export interface LocatePage {
  messages: SessionMessage[];
  hasMore: boolean;
}

export interface LocateResult {
  /** 命中消息 id（限内未命中 → null，调用方 toast 轻提示） */
  hitId: string | null;
  /** 回溯加载后的完整消息列表 */
  messages: SessionMessage[];
  hasMore: boolean;
  /** 实际加载的更早页数 */
  pagesLoaded: number;
}

/**
 * 定位深链锚点：先在已加载消息找；miss 时按 before 游标加载更早页（≤maxPages）。
 * loadOlder 抛错即停止回溯（网络抖动不阻断页面，按当前已加载范围给结果）。
 */
export async function locateWithPaging(opts: {
  messages: SessionMessage[];
  hasMore: boolean;
  target: LocateTarget;
  loadOlder: (beforeId: string) => Promise<LocatePage>;
  maxPages?: number;
  /** 每并入一页回调一次（调用方 setState 增量刷新，命中前用户能看到列表在长） */
  onPageMerged?: (messages: SessionMessage[], hasMore: boolean) => void;
}): Promise<LocateResult> {
  const maxPages = opts.maxPages ?? LOCATE_MAX_PAGES;
  let messages = opts.messages;
  let hasMore = opts.hasMore;
  let hitId = locateHitId(messages, opts.target);
  let pagesLoaded = 0;
  while (hitId === null && hasMore && pagesLoaded < maxPages) {
    const anchor = oldestMessageId(messages);
    if (!anchor) break;
    let page: LocatePage;
    try {
      page = await opts.loadOlder(anchor);
    } catch {
      break;
    }
    pagesLoaded++;
    messages = mergeOlderMessages(messages, page.messages ?? []);
    hasMore = Boolean(page.hasMore);
    opts.onPageMerged?.(messages, hasMore);
    hitId = locateHitId(messages, opts.target);
  }
  return { hitId, messages, hasMore, pagesLoaded };
}
