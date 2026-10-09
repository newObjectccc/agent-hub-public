/**
 * SessionsPage refresh 并发序号回归（P2）：WS 事件风暴下连续触发 refresh，
 * 旧请求晚到的会话列表响应不得覆盖新数据（requestId 单调递增，过期响应丢弃）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary, UsageTotals } from "../api/types";
import type { UseGlobalEventsOptions } from "../hooks/useGlobalEvents";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getDashboardStats: vi.fn(),
  getUsage: vi.fn(),
  getGitStatus: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: {
    listSessions: mocks.listSessions,
    getDashboardStats: mocks.getDashboardStats,
    getUsage: mocks.getUsage,
    getGitStatus: mocks.getGitStatus,
    createSession: vi.fn(),
  },
}));

let globalEvents: UseGlobalEventsOptions | null = null;

vi.mock("../hooks/useGlobalEvents", () => ({
  useGlobalEvents: (opts: UseGlobalEventsOptions) => {
    globalEvents = opts;
  },
}));

vi.mock("../hooks/useGitStatus", () => ({
  useGitStatus: () => null,
}));

import { SessionsPage } from "./SessionsPage";

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<SessionsPage />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

function summary(id: string, name: string): SessionSummary {
  return {
    id,
    source: "pi",
    name,
    cwd: "/tmp/w",
    updatedAt: "2026-02-18T11:00:00.000Z",
    messageCount: 1,
    status: "idle",
    lastUserMessage: null,
    lastAssistantMessage: null,
    sessionFile: `/tmp/w/${id}.jsonl`,
    isSubAgent: false,
  };
}

beforeEach(() => {
  globalEvents = null;
  window.history.replaceState({}, "", "/sessions");
  mocks.listSessions.mockReset();
  mocks.getDashboardStats.mockReset();
  mocks.getDashboardStats.mockResolvedValue({
    working: 0,
    needAttention: 0,
    todayDone: 0,
    todayMessages: 0,
    weekCommits: 0,
    streak: 0,
    weekMessages: 0,
    weekDone: 0,
    todayDoneSessions: [],
    workingSessions: [],
    attentionSessions: [],
  });
  mocks.getUsage.mockReset();
  mocks.getUsage.mockResolvedValue({ sessions: [] as Array<{ sessionId: string; totals: UsageTotals }> });
  mocks.getGitStatus.mockReset();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("SessionsPage refresh 并发序号", () => {
  it("旧列表响应晚到不覆盖新数据（过期序号丢弃）", async () => {
    const pending: Array<(v: unknown) => void> = [];
    mocks.listSessions.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const el = await render();
    expect(mocks.listSessions).toHaveBeenCalledTimes(1);

    // WS 事件风暴：旧请求未回时又触发 refresh
    await act(async () => {
      globalEvents!.onSessionsChanged?.();
      await Promise.resolve();
    });
    expect(mocks.listSessions).toHaveBeenCalledTimes(2);

    // 新请求先返回
    await act(async () => {
      pending[1]({ sessions: [summary("s-new", "新数据会话")] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(el.textContent).toContain("新数据会话");

    // 旧响应晚到：丢弃，不回退
    await act(async () => {
      pending[0]({ sessions: [summary("s-old", "旧数据会话")] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(el.textContent).toContain("新数据会话");
    expect(el.textContent).not.toContain("旧数据会话");
  });

  it("旧列表响应晚到失败也不弹过期错误条", async () => {
    const resolveFirst: Array<(v: unknown) => void> = [];
    const rejecters: Array<(e: unknown) => void> = [];
    mocks.listSessions.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          resolveFirst.push(resolve);
          rejecters.push(reject);
        }),
    );
    const el = await render();
    await act(async () => {
      globalEvents!.onSessionStatus?.({ sessionId: "s1", status: "running" });
      await Promise.resolve();
    });
    await act(async () => {
      resolveFirst[1]({ sessions: [summary("s-new", "新数据会话")] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(el.querySelector(".error-banner")).toBeNull();
    await act(async () => {
      rejecters[0](new Error("旧请求超时"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(el.querySelector(".error-banner")).toBeNull();
    expect(el.textContent).toContain("新数据会话");
  });
});
