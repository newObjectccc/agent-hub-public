/**
 * 全局会话变更订阅：/ws/events
 * server 端 presence 扫描到任一会话文件变化即广播 sessions_changed，
 * 会话完结/出错/插话等事件聚合为 notification 广播，status 变化广播 session_status；
 * 首页据此自动刷新列表（SWR）；断线指数退避重连。
 */
import { useEffect, useRef } from "react";
import type { NotificationItem, SessionStatus } from "../api/types";
import { wsLockProtocols } from "../utils/appLock";

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

export function eventsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/events`;
}

export interface UseGlobalEventsOptions {
  /** 会话列表可能变化（server presence 检测到文件落盘/删除） */
  onSessionsChanged?: () => void;
  /** 新通知（settled/error/steering/done）：驱动横幅/震动/声音与未读角标 */
  onNotification?: (notification: NotificationItem) => void;
  /** 会话运行状态变化（运行看板实时刷新） */
  onSessionStatus?: (payload: { sessionId: string; status: SessionStatus }) => void;
  onStatusChange?: (connected: boolean) => void;
  /** 断线重连成功（非首次连接）后回调：全量补拉（会话列表 + 通知），补上断线期间丢失的广播 */
  onReconnect?: () => void;
}

export function useGlobalEvents({
  onSessionsChanged,
  onNotification,
  onSessionStatus,
  onStatusChange,
  onReconnect,
}: UseGlobalEventsOptions): void {
  const cbs = useRef({ onSessionsChanged, onNotification, onSessionStatus, onStatusChange, onReconnect });
  cbs.current = { onSessionsChanged, onNotification, onSessionStatus, onStatusChange, onReconnect };

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let hadConnection = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = (): void => {
      if (closed) return;
      try {
        ws = new WebSocket(eventsUrl(), wsLockProtocols(window.localStorage));
      } catch {
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        attempt = 0;
        cbs.current.onStatusChange?.(true);
        if (hadConnection) {
          // 重连成功（参照 useSessionSocket 的 onReconnect 模式）：断线期间的
          // sessions_changed / notification / session_status 广播全丢，触发一次全量补拉
          cbs.current.onReconnect?.();
        }
        hadConnection = true;
      };
      ws.onmessage = (raw: MessageEvent<string>) => {
        try {
          const ev = JSON.parse(raw.data) as {
            type?: string;
            notification?: NotificationItem;
            sessionId?: string;
            status?: SessionStatus;
          };
          if (ev.type === "sessions_changed") cbs.current.onSessionsChanged?.();
          else if (ev.type === "notification" && ev.notification) cbs.current.onNotification?.(ev.notification);
          else if (ev.type === "session_status" && ev.sessionId && ev.status) {
            cbs.current.onSessionStatus?.({ sessionId: ev.sessionId, status: ev.status });
          }
        } catch {
          // 忽略非法消息
        }
      };
      ws.onclose = () => {
        cbs.current.onStatusChange?.(false);
        scheduleReconnect();
      };
      ws.onerror = () => {
        ws?.close();
      };
    };

    const scheduleReconnect = (): void => {
      if (closed || timer) return;
      const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
      attempt += 1;
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, delay);
    };

    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, []);
}
