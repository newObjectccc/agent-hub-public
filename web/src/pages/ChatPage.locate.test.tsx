/**
 * 搜索深链定位（UX 审查 AC2）集成验证：
 * - 命中已加载范围：高亮 + 滚动到命中消息
 * - 命中更早消息：自动按 before 游标加载更早页直到命中（旧实现只看尾部 → 静默失败）
 * - 页数上限内仍未命中：toast 轻提示（不再静默）
 * - 每次带参进入会话都能定位（重挂后重新定位）
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMessage, SessionSummary } from "../api/types";
import { getToasts, dismissToast } from "../utils/toast";
import type { WsEvent } from "../chat/messageStream";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getSessionAgents: vi.fn(),
  sendPrompt: vi.fn(),
  abortSession: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: {
    getSessionModels: vi.fn(async () => ({ models: [], currentModel: null, defaultModel: null, warning: null })),
    getPiModels: vi.fn(async () => ({ models: [], currentModel: null, defaultModel: null, warning: null })),
    getSession: mocks.getSession,
    getSessionAgents: mocks.getSessionAgents,
    sendPrompt: mocks.sendPrompt,
    abortSession: mocks.abortSession,
  },
}));

vi.mock("../api/prompt", () => ({
  sendPromptWithMode: vi.fn().mockResolvedValue({ result: { accepted: true, mode: "prompt" }, busyFallback: false }),
}));

vi.mock("../hooks/useGitStatus", () => ({
  useGitStatus: () => null,
}));

vi.mock("../hooks/useSessionSocket", () => ({
  useSessionSocket: (_opts: { onEvent: (event: WsEvent) => void }) => undefined,
}));

import { ChatPage } from "./ChatPage";

const session: SessionSummary = {
  id: "s1",
  source: "pi",
  name: "深链会话",
  cwd: "/tmp/demo",
  updatedAt: "2026-02-18T11:00:00.000Z",
  messageCount: 0,
  status: "idle",
  lastUserMessage: null,
  lastAssistantMessage: null,
  sessionFile: "/tmp/demo/s1.jsonl",
  isSubAgent: false,
};

function msg(id: string, text: string): SessionMessage {
  return { id, role: "user", timestamp: 0, text, toolCalls: [] };
}

/** 历史 m01..m20：尾部 3 条先行加载，目标藏在第 3 页之前 */
const history = Array.from({ length: 20 }, (_, i) => msg(`m${String(i + 1).padStart(2, "0")}`, `第 ${i + 1} 条消息`));
const tail = history.slice(17); // m18..m20

let root: Root | null = null;
let container: HTMLElement | null = null;
const scrollIntoView = vi.fn();

async function mount(): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ChatPage sessionId="s1" />);
    await Promise.resolve();
    await Promise.resolve();
  });
  // 让定位的异步回溯分页跑完
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return container;
}

/** 等待定位的 rAF 滚动落地（重负载下 rAF 可能晚于固定等待；窗口放宽到 5s 抗慢机抖动） */
async function waitForScroll(): Promise<void> {
  for (let i = 0; i < 200 && scrollIntoView.mock.calls.length === 0; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

function setupPagingMock(): void {
  mocks.getSession.mockImplementation((_id: string, opts: { before?: string; limit?: number } = {}) => {
    if (!opts.before) {
      return Promise.resolve({ session, messages: tail, hasMore: true, nextBefore: "m18" });
    }
    const idx = history.findIndex((m) => m.id === opts.before);
    const start = Math.max(0, idx - 3);
    return Promise.resolve({ session, messages: history.slice(start, idx), hasMore: start > 0, nextBefore: null });
  });
}

beforeEach(() => {
  for (const t of getToasts()) dismissToast(t.id);
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
  window.history.pushState({}, "", "/s/s1");
  mocks.getSession.mockReset();
  mocks.getSessionAgents.mockReset();
  mocks.getSessionAgents.mockResolvedValue({ agents: [] });
  setupPagingMock();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("ChatPage 深链定位（AC2）", () => {
  it("命中已加载范围：高亮命中消息并滚动（不额外拉页）", async () => {
    window.history.pushState({}, "", "/s/s1?q=" + encodeURIComponent("第 18 条消息"));
    const el = await mount();
    const highlighted = el.querySelector(".msg-row.search-hit");
    expect(highlighted).not.toBeNull();
    expect(highlighted!.id).toBe("msg-m18");
    expect(el.textContent).toContain("第 18 条消息");
    const pageCalls = mocks.getSession.mock.calls.filter((c) => c[1]?.before);
    expect(pageCalls).toHaveLength(0);
    await waitForScroll();
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("命中更早消息：按 before 游标自动加载更早页直到命中（旧实现静默失败）", async () => {
    window.history.pushState({}, "", "/s/s1?q=" + encodeURIComponent("第 2 条消息"));
    const el = await mount();
    // 更早页被拉进列表并命中高亮
    expect(el.textContent).toContain("第 2 条消息");
    expect(el.querySelector(".msg-row.search-hit")?.id).toBe("msg-m02");
    const pageCalls = mocks.getSession.mock.calls.filter((c) => c[1]?.before);
    expect(pageCalls.length).toBeGreaterThan(0);
    // before 游标逐页向前
    expect(pageCalls[0][1].before).toBe("m18");
    await waitForScroll();
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("页数上限内仍未命中：toast 轻提示「未在已加载范围找到该消息」（不再静默）", async () => {
    window.history.pushState({}, "", "/s/s1?q=" + encodeURIComponent("根本不存在的关键词"));
    await mount();
    const texts = getToasts().map((t) => t.text);
    expect(texts).toContain("未在已加载范围找到该消息");
  });

  it("?m= 消息 id 精确锚点同样回溯定位", async () => {
    window.history.pushState({}, "", "/s/s1?m=m03");
    const el = await mount();
    expect(el.textContent).toContain("第 3 条消息");
    expect(el.querySelector(".msg-row.search-hit")?.id).toBe("msg-m03");
    await waitForScroll();
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("每次进入会话（重新挂载）都重新定位，不被一次性消费卡住", async () => {
    window.history.pushState({}, "", "/s/s1?q=" + encodeURIComponent("第 2 条消息"));
    const el = await mount();
    await waitForScroll();
    expect(scrollIntoView).toHaveBeenCalled();
    // 切走再进（重挂）
    act(() => {
      root!.unmount();
    });
    container!.remove();
    root = null;
    container = null;
    scrollIntoView.mockClear();
    const el2 = await mount();
    expect(el2.textContent).toContain("第 2 条消息");
    await waitForScroll();
    expect(scrollIntoView).toHaveBeenCalled();
  });
});
