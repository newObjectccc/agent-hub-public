/**
 * 顶部横幅「已关闭/已读」记忆（参照 ChatPage bgHintDismissed 的 localStorage 模式）：
 * 手动 ✕ / 点击进入 / 滑动关闭的通知记入持久列表，刷新后同一条通知不再重复弹出。
 * 解析为纯函数 + StorageLike 注入，副作用薄封装（写失败仅本次会话内记住），可测。
 */

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

export const NOTICE_DISMISS_KEY = "agent-hub.noticeBanner.dismissed.v1";

/** 持久列表上限（只防存储膨胀，最近 50 次手动关闭足够覆盖"刷新后不重复弹"） */
export const NOTICE_DISMISS_MAX = 50;

/** 解析持久化的 id 列表（非法 JSON / 非数组 / 超长安全收敛，纯函数） */
export function parseDismissedIds(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
  return list.slice(-NOTICE_DISMISS_MAX);
}

export function loadDismissedIds(storage: StorageLike | null | undefined): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(NOTICE_DISMISS_KEY);
    if (raw === null) return [];
    return parseDismissedIds(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** 记一条已关闭/已读（去重 + 只留最新 MAX 条），返回新列表；写失败仅内存生效 */
export function recordDismissedId(
  storage: StorageLike | null | undefined,
  id: string,
  prev: readonly string[] = [],
): string[] {
  const next = parseDismissedIds([...prev.filter((x) => x !== id), id]);
  if (!storage) return next;
  try {
    storage.setItem(NOTICE_DISMISS_KEY, JSON.stringify(next));
  } catch {
    // 隐私模式等写入失败：忽略，本次会话内仍记住
  }
  return next;
}
