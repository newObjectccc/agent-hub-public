/**
 * WS 连接管理：/ws/sessions/:id
 * - 指数退避重连（1s → 2s → 4s → … 封顶 30s，重连成功后复位）
 * - 重连成功后触发 onReconnect，由页面做 GET /api/sessions/:id 全量对账
 * - 页面隐藏时保持连接（手机切后台由浏览器自行挂起），卸载时主动关闭
 */
import { useEffect, useRef } from "react";
import type { WsEvent } from "../chat/messageStream";

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

export function wsUrl(sessionId: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/sessions/${encodeURIComponent(sessionId)}`;
}

export interface UseSessionSocketOptions {
  sessionId: string;
  onEvent: (event: WsEvent) => void;
  /** 断线重连成功（含首次握手成功后又断开再连上）后回调，用于全量对账 */
  onReconnect?: () => void;
  onStatusChange?: (connected: boolean) => void;
}

export function useSessionSocket({ sessionId, onEvent, onReconnect, onStatusChange }: UseSessionSocketOptions): void {
  const onEventRef = useRef(onEvent);
  const onReconnectRef = useRef(onReconnect);
  const onStatusChangeRef = useRef(onStatusChange);
  onEventRef.current = onEvent;
  onReconnectRef.current = onReconnect;
  onStatusChangeRef.current = onStatusChange;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let attempts = 0;
    let hadConnection = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(wsUrl(sessionId));
      } catch {
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        attempts = 0;
        onStatusChangeRef.current?.(true);
        if (hadConnection) {
          // 重连成功：全量对账（v0 不做增量恢复）
          onReconnectRef.current?.();
        }
        hadConnection = true;
      };

      ws.onmessage = (ev: MessageEvent<string>) => {
        try {
          const data = JSON.parse(ev.data) as WsEvent;
          if (data && typeof data.type === "string") {
            if (data.type === "pong") return;
            onEventRef.current(data);
          }
        } catch {
          // 忽略非 JSON 帧
        }
      };

      ws.onclose = () => {
        onStatusChangeRef.current?.(false);
        scheduleReconnect();
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    const scheduleReconnect = () => {
      if (closed || timer) return;
      const delay = Math.min(BASE_DELAY_MS * 2 ** attempts, MAX_DELAY_MS);
      attempts++;
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, delay);
    };

    connect();

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.onopen = null;
        ws.close();
      }
      onStatusChangeRef.current?.(false);
    };
  }, [sessionId]);
}
