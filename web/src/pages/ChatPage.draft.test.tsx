/**
 * 输入草稿持久化（UX 审查 AC1）集成验证：
 * - 输入即持久化（防抖落盘）：切走/刷新/进树页（组件卸载）草稿不丢
 * - 重新进入会话自动恢复；发送成功即清草稿；附件不持久化（只存文本）
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../api/types";
import { DRAFTS_KEY, DRAFT_TTL_MS, loadDraft, saveDraft } from "../utils/drafts";
import type { WsEvent } from "../chat/messageStream";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  sendPromptWithMode: vi.fn(),
  getSession: vi.fn(),
  getSessionAgents: vi.fn(),
  sendPrompt: vi.fn(),
  abortSession: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: {
    getSession: mocks.getSession,
    getSessionAgents: mocks.getSessionAgents,
    sendPrompt: mocks.sendPrompt,
    abortSession: mocks.abortSession,
  },
}));

vi.mock("../api/prompt", () => ({
  sendPromptWithMode: mocks.sendPromptWithMode,
}));

vi.mock("../hooks/useGitStatus", () => ({
  useGitStatus: () => null,
}));

let wsEvent: ((event: WsEvent) => void) | null = null;

vi.mock("../hooks/useSessionSocket", () => ({
  useSessionSocket: (opts: { onEvent: (event: WsEvent) => void }) => {
    wsEvent = opts.onEvent;
  },
}));

import { ChatPage } from "./ChatPage";

const session: SessionSummary = {
  id: "s1",
  source: "pi",
  name: "草稿会话",
  cwd: "/tmp/demo",
  updatedAt: "2026-02-18T11:00:00.000Z",
  messageCount: 0,
  status: "idle",
  lastUserMessage: null,
  lastAssistantMessage: null,
  sessionFile: "/tmp/demo/s1.jsonl",
  isSubAgent: false,
};

let root: Root | null = null;
let container: HTMLElement | null = null;

async function mount(): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ChatPage sessionId="s1" />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

function typeInput(el: HTMLElement, text: string): void {
  const textarea = el.querySelector("textarea")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function waitMs(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeEach(() => {
  wsEvent = null;
  localStorage.clear();
  mocks.sendPromptWithMode.mockReset();
  mocks.sendPromptWithMode.mockResolvedValue({ result: { accepted: true, mode: "prompt" }, busyFallback: false });
  mocks.getSession.mockReset();
  mocks.getSession.mockResolvedValue({ session, messages: [], hasMore: false, nextBefore: null });
  mocks.getSessionAgents.mockReset();
  mocks.getSessionAgents.mockResolvedValue({ agents: [] });
  mocks.sendPrompt.mockReset();
  mocks.abortSession.mockReset();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("ChatPage 草稿持久化（AC1）", () => {
  it("输入文本防抖落盘；切走（卸载）再进自动恢复", async () => {
    const el = await mount();
    typeInput(el, "写到一半的消息");
    await waitMs(400); // 超过防抖 300ms
    expect(localStorage.getItem(DRAFTS_KEY)).toContain("写到一半的消息");

    // 切走（卸载 = 切会话/进树页/刷新的共同路径）
    act(() => {
      root!.unmount();
    });
    container!.remove();
    root = null;
    container = null;

    const el2 = await mount();
    const textarea = el2.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.value).toBe("写到一半的消息");
  });

  it("快速输入后立即切走（防抖未到点）也在卸载时冲刷，不丢草稿", async () => {
    const el = await mount();
    typeInput(el, "来不及落盘的草稿");
    // 不等防抖，直接卸载
    act(() => {
      root!.unmount();
    });
    container!.remove();
    root = null;
    container = null;
    expect(localStorage.getItem(DRAFTS_KEY)).toContain("来不及落盘的草稿");
  });

  it("发送成功即清草稿（已发内容不残留给下次恢复）", async () => {
    const el = await mount();
    typeInput(el, "要发出去的消息");
    await waitMs(400);
    const sendBtn = Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.getAttribute("aria-label") === "发送")!;
    await act(async () => {
      sendBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.sendPromptWithMode).toHaveBeenCalled();
    await waitMs(400);
    expect(el.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
    expect(loadDraft(localStorage, "s1")).toBeNull();
  });

  it("进入会话时按 sessionId 恢复（会话之间不串）", async () => {
    saveDraft(localStorage, "s1", "会话一的草稿");
    saveDraft(localStorage, "s2", "会话二的草稿");
    const el = await mount();
    expect(el.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("会话一的草稿");
  });

  it("30 天未动的旧草稿不恢复（防膨胀清理口径）", async () => {
    saveDraft(localStorage, "s1", "一个月前的草稿", Date.now() - DRAFT_TTL_MS - 1000);
    const el = await mount();
    expect(el.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
  });
});
