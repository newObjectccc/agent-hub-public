/**
 * 通知中心：铃铛（未读角标）+ 下拉通知列表（点击跳会话）+ 全部已读。
 * 数据由 HomePage 统一拉取（GET /api/notifications）后下传，WS 新通知实时并入。
 */
import { useRef, useState } from "react";
import type { NotificationItem } from "../api/types";
import { relativeTime } from "../utils/relativeTime";
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
  onOpenSession: (sessionId: string) => void;
}

export function NotificationCenter({
  notifications,
  unreadCount,
  loading = false,
  onReload,
  onMarkAllRead,
  onOpenSession,
}: NotificationCenterProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  return (
    <div className="notif-root">
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
        <div className="card notif-panel" ref={panelRef} role="dialog" aria-label="通知中心">
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
            {notifications.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`notif-item${item.read ? "" : " unread"}`}
                  onClick={() => {
                    onOpenSession(item.sessionId);
                    setOpen(false);
                  }}
                >
                  <div className="notif-item-head">
                    <span className={`notif-kind ${item.kind}`}>{NOTIFICATION_KIND_LABEL[item.kind]}</span>
                    <span className="notif-session">{item.sessionName ?? item.sessionId.slice(0, 8)}</span>
                    <span className="session-time">{relativeTime(item.timestamp)}</span>
                  </div>
                  <div className="notif-text">{item.text}</div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
