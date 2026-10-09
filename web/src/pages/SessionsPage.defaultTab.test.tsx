/**
 * 默认 tab 动态回落回归（产品决策：打开会话页先看"要紧的"）：
 * 等你处理 > 工作中 > 全部；URL 深链（?tab=）与用户手动选择永远优先，且只自动选一次。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../hooks/useGlobalEvents", () => ({
  useGlobalEvents: () => undefined,
}));

import { SessionsPage } from "./SessionsPage";

let root: Root | null = null;
let container: HTMLElement | null = null;

const session = (id: string, status: "idle" | "running") => ({
  id,
  source: "pi",
  name: null,
  cwd: "/tmp/w",
  updatedAt: "2026-10-08T12:00:00.000Z",
  messageCount: 1,
  status,
  lastUserMessage: "hi",
  lastAssistantMessage: "done",
  sessionFile: `/tmp/${id}.jsonl`,
  isSubAgent: false,
});

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

function activeTab(el: HTMLElement): string {
  return el.querySelector(".tab-btn.active")?.textContent ?? "";
}

beforeEach(() => {
  mocks.listSessions.mockReset().mockResolvedValue({ sessions: [] });
  mocks.getDashboardStats.mockReset().mockResolvedValue({
    attentionSessions: [],
    workingSessions: [],
    todayDoneSessions: [],
  });
  mocks.getUsage.mockReset().mockResolvedValue({ windows: null, sessions: [] });
  mocks.getGitStatus.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  window.history.replaceState({}, "", "/");
});

describe("默认 tab 动态回落：等你处理 > 工作中 > 全部", () => {
  it("有等你处理的会话 → 默认落在 ⚠️等你处理", async () => {
    window.history.replaceState({}, "", "/sessions");
    mocks.listSessions.mockResolvedValue({ sessions: [session("s-att", "idle")] });
    mocks.getDashboardStats.mockResolvedValue({
      attentionSessions: [{ id: "s-att" }],
      workingSessions: [],
      todayDoneSessions: [],
    });
    const el = await render();
    expect(activeTab(el)).toContain("等你处理");
    // 自动选中同步 URL（分享一致）
    expect(window.location.search).toBe("?tab=attention");
  });

  it("无等你处理、有工作中 → 默认落在 🔥工作中", async () => {
    window.history.replaceState({}, "", "/sessions");
    mocks.listSessions.mockResolvedValue({ sessions: [session("s-run", "running")] });
    mocks.getDashboardStats.mockResolvedValue({
      attentionSessions: [],
      workingSessions: [{ id: "s-run" }],
      todayDoneSessions: [],
    });
    const el = await render();
    expect(activeTab(el)).toContain("工作中");
    expect(window.location.search).toBe("?tab=working");
  });

  it("两者皆无 → 留在全部（URL 干净不写 ?tab=）", async () => {
    window.history.replaceState({}, "", "/sessions");
    const el = await render();
    expect(activeTab(el)).toContain("全部");
    expect(window.location.search).toBe("");
  });

  it("URL 深链 ?tab=done 永远优先，不被默认回落覆盖", async () => {
    window.history.replaceState({}, "", "/sessions?tab=done");
    mocks.listSessions.mockResolvedValue({ sessions: [session("s-att", "idle")] });
    mocks.getDashboardStats.mockResolvedValue({
      attentionSessions: [{ id: "s-att" }],
      workingSessions: [],
      todayDoneSessions: [],
    });
    const el = await render();
    expect(activeTab(el)).toContain("今日完成");
    expect(window.location.search).toBe("?tab=done");
  });
});
