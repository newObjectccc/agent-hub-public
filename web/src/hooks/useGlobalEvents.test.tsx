/**
 * /ws/events 重连 resync 回归（P1）：手机后台挂起断连数分钟后恢复，
 * 断线期间 sessions_changed / notification / session_status 广播全丢 →
 * 重连成功（非首次连接）触发一次 onReconnect 全量补拉（会话列表 + 通知）。
 * 首次连接不触发补拉（避免首屏双拉）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGlobalEvents, type UseGlobalEventsOptions } from "./useGlobalEvents";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class FakeWebSocket {
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  close(): void {
    this.onclose?.();
  }
  static instances: FakeWebSocket[] = [];
}

function Probe(props: UseGlobalEventsOptions) {
  useGlobalEvents(props);
  return null;
}

let root: Root | null = null;
let container: HTMLElement | null = null;

function mount(node: React.ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function reconnectCount(probe: { reconnect: number }): number {
  return probe.reconnect;
}

describe("useGlobalEvents 断线重连补拉", () => {
  it("首次连接不触发 onReconnect；事件派发正常", () => {
    const onSessionsChanged = vi.fn();
    const onNotification = vi.fn();
    const onReconnect = vi.fn();
    mount(
      <Probe
        onSessionsChanged={onSessionsChanged}
        onNotification={onNotification}
        onReconnect={onReconnect}
      />,
    );
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    act(() => {
      ws.onopen?.();
      ws.onmessage?.({ data: JSON.stringify({ type: "sessions_changed" }) } as MessageEvent<string>);
      ws.onmessage?.({
        data: JSON.stringify({ type: "notification", notification: { id: "n1" } }),
      } as MessageEvent<string>);
    });
    expect(onSessionsChanged).toHaveBeenCalledTimes(1);
    expect(onNotification).toHaveBeenCalledTimes(1);
    // 首次握手不算重连：不做全量补拉（首屏已各自拉取）
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("断线重连成功触发一次 onReconnect（每轮重连各一次）", () => {
    const onReconnect = vi.fn();
    mount(<Probe onReconnect={onReconnect} />);
    const first = FakeWebSocket.instances[0];
    act(() => {
      first.onopen?.();
    });
    expect(onReconnect).not.toHaveBeenCalled();

    // 手机后台挂起断连 → 指数退避重连
    act(() => {
      first.onclose?.();
      vi.advanceTimersByTime(1_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => {
      FakeWebSocket.instances[1].onopen?.();
    });
    expect(onReconnect).toHaveBeenCalledTimes(1);

    // 再断再连：再来一次补拉
    act(() => {
      FakeWebSocket.instances[1].onclose?.();
      vi.advanceTimersByTime(2_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(3);
    act(() => {
      FakeWebSocket.instances[2].onopen?.();
    });
    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  it("卸载后不再补拉（timer 清理，无泄漏回调）", () => {
    const onReconnect = vi.fn();
    mount(<Probe onReconnect={onReconnect} />);
    const ws = FakeWebSocket.instances[0];
    act(() => {
      ws.onopen?.();
    });
    act(() => {
      root?.unmount();
    });
    root = null;
    // 卸载触发 close → 调度被 closed 阻止，不产生新连接
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(reconnectCount({ reconnect: 0 })).toBe(0);
    expect(onReconnect).not.toHaveBeenCalled();
  });
});
