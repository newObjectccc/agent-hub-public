/**
 * 通知中心：铃铛（未读角标）+ 下拉通知列表（点击跳会话并标记该条已读）+ 全部已读。
 * 数据由 HomePage 统一拉取（GET /api/notifications）后下传，WS 新通知实时并入。
 *
 * 列表逻辑（用户实测反馈修复）：
 * - 子代理（isSubAgent）通知聚合为一行「🤖 N 个子代理完成」，点开看明细；主会话通知永远在最前
 * - 点击条目跳转会话的同时标记该条已读（乐观更新，角标即时递减）
 * - kind=done（已手动中止）不计未读（噪声回执，不是待办），不高亮
 * - 点外部/Esc 关闭 + 与其他弹层互斥（useDismissable）
 */
import { useRef, useState } from "react";
import type { NotificationItem } from "../api/types";
import { useDismissable } from "../hooks/useDismissable";
import { relativeTime } from "../utils/relativeTime";
import { aggregateNotifications, countsAsUnread, splitRowsByRead, type NotificationRow } from "../utils/notifications";
import { BellIcon } from "./icons";
import { Button } from "./ui/button";

export const NOTIFICATION_KIND_LABEL: Record<NotificationItem["kind"], string> = {
  settled: "干完了",
  error: "出错了",
  steering: "被插话",
  done: "已中止",
};

interface NotificationCenterProps {
  notifications: NotificationItem[];
  unreadCount: number;
  loading?: boolean;
  onReload: () => void;
  onMarkAllRead: () => void;
  /** 点击条目跳转前标记该条已读（乐观更新由调用方处理） */
  onMarkRead: (id: string) => void;
  onOpenSession: (sessionId: string) => void;
}

function NotificationRowItem({
  item,
  onOpen,
  sub = false,
}: {
  item: NotificationItem;
  onOpen: (item: NotificationItem) => void;
  sub?: boolean;
}) {
  return (
    <button
      type="button"
      className={`notif-item${sub ? " notif-sub-item" : ""}${countsAsUnread(item) ? " unread" : " read"}`}
      onClick={() => onOpen(item)}
    >
      <div className="notif-item-head">
        <span className={`notif-kind ${item.kind}`}>{NOTIFICATION_KIND_LABEL[item.kind]}</span>
        <span className="notif-session">{item.sessionName ?? item.sessionId.slice(0, 8)}</span>
        <span className="session-time">{relativeTime(item.timestamp)}</span>
      </div>
      <div className="notif-text">{item.text}</div>
    </button>
  );
}

function SubAgentGroupRow({
  row,
  onOpen,
}: {
  row: Extract<NotificationRow, { type: "subAgents" }>;
  onOpen: (item: NotificationItem) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="notif-group">
      <button
        type="button"
        className={`notif-group-head${row.unread > 0 ? " unread" : ""}`}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="notif-group-title">🤖 {row.items.length} 个子代理完成（点开查看）</span>
        {row.unread > 0 && (
          <span className="notif-badge" aria-label={`${row.unread} 条未读`}>
            {row.unread}
          </span>
        )}
      </button>
      {expanded && (
        <ul className="notif-group-list">
          {row.items.map((item) => (
            <li key={item.id}>
              <NotificationRowItem item={item} onOpen={onOpen} sub />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function NotificationCenter({
  notifications,
  unreadCount,
  loading = false,
  onReload,
  onMarkAllRead,
  onMarkRead,
  onOpenSession,
}: NotificationCenterProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // 点外部/Esc 关闭 + 与设置菜单/⋯菜单等弹层互斥（触屏 touchend 兼容）
  useDismissable({ open, onDismiss: () => setOpen(false), rootRef: panelRef });

  const rows = aggregateNotifications(notifications);
  const { unread: unreadRows, read: readRows } = splitRowsByRead(rows);
  const openItem = (item: NotificationItem): void => {
    onMarkRead(item.id);
    onOpenSession(item.sessionId);
    setOpen(false);
  };

  return (
    <div className="notif-root" ref={panelRef}>
      <Button
        type="button"
        variant="secondary"
        size="icon"
        className="min-h-[44px] min-w-[44px] notif-bell"
        aria-label={unreadCount > 0 ? `通知（${unreadCount} 条未读）` : "通知"}
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          if (!open) onReload();
        }}
      >
        <BellIcon />
        {unreadCount > 0 && (
          <span className="notif-badge" aria-hidden>
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </Button>
      {open && (
        <div className="card notif-panel" role="dialog" aria-label="通知中心">
          <div className="notif-panel-head">
            <span className="notif-panel-title">通知</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onMarkAllRead}
              disabled={unreadCount === 0}
            >
              全部已读
            </Button>
          </div>
          {loading && notifications.length === 0 && (
            <div className="skeleton notif-skeleton" aria-hidden>
              <div className="skeleton-bar w-full" />
              <div className="skeleton-bar w-2/3" />
            </div>
          )}
          {!loading && notifications.length === 0 && <div className="empty">暂无通知</div>}
          <ul className="notif-list">
            {unreadRows.length > 0 && (
              <li className="notif-section-head" role="presentation">
                未读（{unreadRows.reduce((n, r) => (r.type === "item" ? n + (countsAsUnread(r.item) ? 1 : 0) : n + r.unread), 0)}）
              </li>
            )}
            {unreadRows.map((row) =>
              row.type === "item" ? (
                <li key={row.item.id}>
                  <NotificationRowItem item={row.item} onOpen={openItem} />
                </li>
              ) : (
                <li key="sub-agents-unread">
                  <SubAgentGroupRow row={row} onOpen={openItem} />
                </li>
              ),
            )}
            {readRows.length > 0 && unreadRows.length > 0 && (
              <li className="notif-section-head read" role="presentation">
                已读
              </li>
            )}
            {readRows.map((row) =>
              row.type === "item" ? (
                <li key={row.item.id}>
                  <NotificationRowItem item={row.item} onOpen={openItem} />
                </li>
              ) : (
                <li key="sub-agents-read">
                  <SubAgentGroupRow row={row} onOpen={openItem} />
                </li>
              ),
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
