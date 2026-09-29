/**
 * 通知列表纯函数（与 server/src/notifications.ts 的 countsAsUnread 同口径）：
 * - 未读语义：kind=done（已手动中止）是噪声回执不是待办，不计未读（角标/列表高亮/递减全链路一致）
 * - 子代理（isSubAgent）通知聚合为一行，主会话通知永远在最前
 */
import type { NotificationItem } from "../api/types";

/** 未读待办语义（全链路统一：角标数 = 列表未读数 = 点击后递减） */
export function countsAsUnread(item: Pick<NotificationItem, "read" | "kind">): boolean {
  return !item.read && item.kind !== "done";
}

export function unreadCountOf(items: NotificationItem[]): number {
  return items.reduce((n, item) => (countsAsUnread(item) ? n + 1 : n), 0);
}

/** 子代理聚合行（settled/steering/done 聚合；error 独立显示不进组） */
export interface SubAgentRow {
  type: "subAgents";
  /** 组内条目（时间倒序） */
  items: NotificationItem[];
  /** 组内最新时间（ISO） */
  latest: string;
  /** 组内未读数（并入全局角标，点击明细逐条递减） */
  unread: number;
}

export type NotificationRow = { type: "item"; item: NotificationItem } | SubAgentRow;

const byTimeDesc = (a: NotificationItem, b: NotificationItem): number =>
  Date.parse(b.timestamp) - Date.parse(a.timestamp);

/**
 * 通知行聚合（纯函数）：
 * - isSubAgent 且非 error 的条目聚合为一行「🤖 N 个子代理完成」，默认收起、点开看明细；
 *   error 独立显示（错误不能被聚合淹没）。
 * - 主会话通知永远排在最前（时间倒序），聚合行固定最后。
 */
export function aggregateNotifications(items: NotificationItem[]): NotificationRow[] {
  const main: NotificationItem[] = [];
  const group: NotificationItem[] = [];
  for (const item of items) {
    if (item.isSubAgent === true && item.kind !== "error") group.push(item);
    else main.push(item);
  }
  const rows: NotificationRow[] = [...main.sort(byTimeDesc)].map((item) => ({ type: "item" as const, item }));
  if (group.length > 0) {
    const sorted = [...group].sort(byTimeDesc);
    rows.push({
      type: "subAgents",
      items: sorted,
      latest: sorted[0].timestamp,
      unread: sorted.reduce((n, item) => (countsAsUnread(item) ? n + 1 : n), 0),
    });
  }
  return rows;
}
