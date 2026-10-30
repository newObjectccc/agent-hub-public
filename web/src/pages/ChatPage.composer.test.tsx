/**
 * 输入语义（UX 审查 AC4）集成验证：
 * - Enter 发送：桌面 Enter 发送；触屏回车=换行（习惯不推翻）；触屏+外接键盘可 Enter 发送
 * - 中文输入法组合结束后的冷却窗内 Enter 不误发
 * - 发送模式不被静默重置：粘性选择保留；一次性模式复位时给一行轻提示
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../api/types";
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
    getSessionModels: vi.fn(async () => ({ models: [], currentModel: null, defaultModel: null, warning: null })),
    getPiModels: vi.fn(async () => ({ models: [], currentModel: null, defaultModel: null, warning: null })),
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
  name: "输入语义会话",
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

async function pressEnter(el: HTMLElement, opts: { isComposing?: boolean; shiftKey?: boolean } = {}): Promise<void> {
  const textarea = el.querySelector("textarea")!;
  await act(async () => {
    const ev = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: opts.shiftKey ?? false,
      bubbles: true,
      cancelable: true,
    });
    if (opts.isComposing) Object.defineProperty(ev, "isComposing", { value: true });
    textarea.dispatchEvent(ev);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function feedWs(event: WsEvent): void {
  act(() => {
    wsEvent?.(event);
  });
}

function modeTrigger(el: HTMLElement): string {
  return el.querySelector(".mode-trigger")?.textContent ?? "";
}

function pickMode(el: HTMLElement, index: number): void {
  act(() => {
    el.querySelector<HTMLButtonElement>(".mode-trigger")!.click();
  });
  act(() => {
    el.querySelectorAll<HTMLButtonElement>(".mode-menu-item")[index].click();
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
  vi.unstubAllGlobals();
});

describe("ChatPage Enter 发送语义（AC4）", () => {
  it("桌面（非触屏）Enter 发送", async () => {
    const el = await mount();
    typeInput(el, "桌面回车发送");
    await pressEnter(el);
    expect(mocks.sendPromptWithMode).toHaveBeenCalledTimes(1);
  });

  it("触屏软键盘回车=换行（不发送，习惯不推翻）", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("pointer: coarse"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const el = await mount();
    typeInput(el, "触屏回车换行");
    await pressEnter(el);
    expect(mocks.sendPromptWithMode).not.toHaveBeenCalled();
  });

  it("触屏 + 外接物理键盘（Tab 证据）：Enter 发送（修复外接键盘无法回车发送）", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("pointer: coarse"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const el = await mount();
    // 外接键盘特征事件（软键盘不发 Tab）
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    typeInput(el, "外接键盘回车发送");
    await pressEnter(el);
    expect(mocks.sendPromptWithMode).toHaveBeenCalledTimes(1);
  });

  it("中文输入法组合期 Enter 不误发（isComposing）", async () => {
    const el = await mount();
    typeInput(el, "拼音候选");
    await pressEnter(el, { isComposing: true });
    expect(mocks.sendPromptWithMode).not.toHaveBeenCalled();
  });

  it("compositionend 后短冷却窗内 Enter 不误发；冷却结束恢复", async () => {
    const el = await mount();
    typeInput(el, "输入法刚确认");
    act(() => {
      el.querySelector("textarea")!.dispatchEvent(new Event("compositionend", { bubbles: true }));
    });
    await pressEnter(el);
    expect(mocks.sendPromptWithMode).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await pressEnter(el);
    expect(mocks.sendPromptWithMode).toHaveBeenCalledTimes(1);
  });
});

describe("ChatPage 发送模式（AC4：不静默重置）", () => {
  it("粘性选择（💬 新消息）回合结束保留，SendModeMenu 显示与实际一致", async () => {
    const el = await mount();
    pickMode(el, 1); // 💬 新消息（prompt）
    expect(modeTrigger(el)).toContain("💬 新消息");
    // 回合结束（status → idle）
    feedWs({ type: "status", status: "idle" } as WsEvent);
    expect(modeTrigger(el)).toContain("💬 新消息");
    // 无复位提示（没被改回 auto）
    expect(el.querySelector(".chat-notice")).toBeNull();
  });

  it("一次性模式（✋ 插话）回合结束自动复位为 ⚡ 自动 + 一行轻提示（不静默）", async () => {
    const el = await mount();
    pickMode(el, 2); // ✋ 插话（steer）
    expect(modeTrigger(el)).toContain("✋ 插话");
    feedWs({ type: "status", status: "idle" } as WsEvent);
    expect(modeTrigger(el)).toContain("⚡ 自动");
    expect(el.querySelector(".chat-notice")?.textContent).toContain("仅对本轮生效");
  });

  it("agent_settled 收尾同口径：粘性保留、一次性复位带提示", async () => {
    const el = await mount();
    pickMode(el, 3); // ⏭ 排队（followUp）
    feedWs({ type: "agent_settled" } as WsEvent);
    expect(modeTrigger(el)).toContain("⚡ 自动");
    expect(el.querySelector(".chat-notice")?.textContent).toContain("仅对本轮生效");
  });
});
