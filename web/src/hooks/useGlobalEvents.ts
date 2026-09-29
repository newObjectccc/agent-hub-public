/**
 * 全局会话变更订阅：/ws/events
 * server 端 presence 扫描到任一会话文件变化即广播 sessions_changed，
 * 首页据此自动刷新列表（SWR）；断线指数退避重连。
 */
import { useEffect, useRef } from "react";

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

export function eventsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/events`;
}

export interface UseGlobalEventsOptions {
  /** 会话列表可能变化（server presence 检测到文件落盘/删除） */
  onSessionsChanged?: () => void;
  onStatusChange?: (connected: boolean) => void;
}

export function useGlobalEvents({ onSessionsChanged, onStatusChange }: UseGlobalEventsOptions): void {
  const cbs = useRef({ onSessionsChanged, onStatusChange });
  cbs.current = { onSessionsChanged, onStatusChange };

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = (): void => {
      if (closed) return;
      try {
        ws = new WebSocket(eventsUrl());
      } catch {
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        attempt = 0;
        cbs.current.onStatusChange?.(true);
      };
      ws.onmessage = (raw: MessageEvent<string>) => {
        try {
          const ev = JSON.parse(raw.data) as { type?: string };
          if (ev.type === "sessions_changed") cbs.current.onSessionsChanged?.();
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
