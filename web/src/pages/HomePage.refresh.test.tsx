/**
 * refresh 并发序号回归（P2）：WS 事件风暴下连续触发 refresh，
 * 旧请求晚到的响应不得覆盖新数据（requestId 单调递增，过期响应丢弃）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkingSessionCard } from "../api/types";
import type { UseGlobalEventsOptions } from "../hooks/useGlobalEvents";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  getDashboardStats: vi.fn(),
  getUsage: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: {
    getDashboardStats: mocks.getDashboardStats,
    getUsage: mocks.getUsage,
  },
}));

let globalEvents: UseGlobalEventsOptions | null = null;

vi.mock("../hooks/useGlobalEvents", () => ({
  useGlobalEvents: (opts: UseGlobalEventsOptions) => {
    globalEvents = opts;
  },
}));

import { HomePage } from "./HomePage";

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<HomePage />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

function card(id: string, name: string): WorkingSessionCard {
  return {
    id,
    name,
    cwd: "/tmp/w",
    status: "running",
    source: "pi",
    startedAt: "2026-02-18T10:00:00.000Z",
    currentTool: null,
    lastOutput: null,
    updatedAt: "2026-02-18T11:00:00.000Z",
  };
}

beforeEach(() => {
  globalEvents = null;
  mocks.getDashboardStats.mockReset();
  mocks.getUsage.mockReset();
  mocks.getUsage.mockResolvedValue({ windows: null });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("HomePage refresh 并发序号", () => {
  it("旧响应晚到不覆盖新数据（过期序号丢弃）", async () => {
    const pending: Array<(v: unknown) => void> = [];
    mocks.getDashboardStats.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const el = await render();
    expect(mocks.getDashboardStats).toHaveBeenCalledTimes(1);

    // WS 事件风暴：旧请求未回时又触发一次 refresh
    await act(async () => {
      globalEvents!.onSessionStatus?.({ sessionId: "s1", status: "running" });
      await Promise.resolve();
    });
    expect(mocks.getDashboardStats).toHaveBeenCalledTimes(2);

    // 新请求先返回（新数据生效）
    await act(async () => {
      pending[1]({ workingSessions: [card("s-new", "新数据会话")], attentionSessions: [] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(el.textContent).toContain("新数据会话");

    // 旧响应晚到：丢弃，不回退
    await act(async () => {
      pending[0]({ workingSessions: [card("s-old", "旧数据会话")], attentionSessions: [] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(el.textContent).toContain("新数据会话");
    expect(el.textContent).not.toContain("旧数据会话");
  });

  it("旧响应晚到失败也不弹过期错误条（错误提示同样按序号丢弃）", async () => {
    const pending: Array<(v: unknown) => void> = [];
    const rejecters: Array<(e: unknown) => void> = [];
    mocks.getDashboardStats.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          pending.push(resolve);
          rejecters.push(reject);
        }),
    );
    const el = await render();
    await act(async () => {
      globalEvents!.onNotification?.({
        id: "n1",
        sessionId: "s1",
        sessionName: null,
        kind: "settled",
        text: "x",
        read: false,
        timestamp: "2026-02-18T11:00:00.000Z",
      });
      await Promise.resolve();
    });
    await act(async () => {
      pending[1]({ workingSessions: [], attentionSessions: [] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(el.querySelector(".error-banner")).toBeNull();
    // 过期请求失败：不弹错误条打扰
    await act(async () => {
      rejecters[0](new Error("旧请求超时"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(el.querySelector(".error-banner")).toBeNull();
  });
});
