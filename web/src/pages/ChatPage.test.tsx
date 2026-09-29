/**
 * ChatPage 交互回归（手机实测 bug 修复验证）：
 * 1. 快速连点/Enter+点击双通道发送 → 只发一条请求（同步防重入）
 * 2. 连续两条相同文本消息各自独立显示，不重复不误合并
 * 3. 回复完成后中止按钮消失（message_end 后无事件 → 待定收尾翻转 idle；
 *    期间有流事件则不误翻转）
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMessage, SessionSummary } from "../api/types";
import type { WsEvent } from "../chat/messageStream";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  sendPromptWithMode: vi.fn(),
  getSession: vi.fn(),
  sendPrompt: vi.fn(),
  abortSession: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: {
    getSession: mocks.getSession,
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

/** 捕获 WS 事件回调，测试里手动喂事件模拟服务端推送 */
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
  name: "测试会话",
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

async function render(): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ChatPage sessionId="s1" />);
  });
  // 让 getSession 的 promise settle
  await act(async () => {
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

function click(el: Element | null): void {
  expect(el).not.toBeNull();
  act(() => {
    (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function userRows(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(".msg-row.user"));
}

function abortButton(el: HTMLElement): HTMLButtonElement | null {
  return Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "中止") ?? null;
}

beforeEach(() => {
  wsEvent = null;
  mocks.sendPromptWithMode.mockReset();
  mocks.sendPromptWithMode.mockResolvedValue({ result: { accepted: true, mode: "prompt" }, busyFallback: false });
  mocks.getSession.mockReset();
  mocks.getSession.mockResolvedValue({ session, messages: [], hasMore: false, nextBefore: null });
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
  vi.useRealTimers();
});

describe("ChatPage 发送防重入（快速双击只发一条）", () => {
  it("同一帧内极速双击发送按钮 → 只发一次请求、只出一条占位", async () => {
    const el = await render();
    typeInput(el, "你好");
    const sendBtn = el.querySelector<HTMLButtonElement>(".send-btn")!;
    act(() => {
      // 同一事件循环内两次触发（React state 尚未 flush 的时序洞，旧实现会发两条）
      sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mocks.sendPromptWithMode).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
    });
    expect(userRows(el)).toHaveLength(1);
  });

  it("Enter + 点击双通道同帧触发 → 只发一次请求", async () => {
    const el = await render();
    typeInput(el, "你好");
    const textarea = el.querySelector("textarea")!;
    const sendBtn = el.querySelector<HTMLButtonElement>(".send-btn")!;
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mocks.sendPromptWithMode).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
    });
    expect(userRows(el)).toHaveLength(1);
  });
});

describe("ChatPage 连续两条相同文本消息独立显示", () => {
  it("快速连发两条相同文本：两条占位 id 唯一，各自被权威回填，2 条独立显示", async () => {
    const el = await render();
    typeInput(el, "hi");
    click(el.querySelector(".send-btn"));
    await act(async () => {
      await Promise.resolve();
    });
    // 第一条权威回显
    act(() => {
      wsEvent?.({
        type: "message_end",
        message: { id: "user-1", role: "user", timestamp: 1, text: "hi", toolCalls: [] },
      });
    });
    expect(userRows(el)).toHaveLength(1);

    typeInput(el, "hi");
    click(el.querySelector(".send-btn"));
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      wsEvent?.({
        type: "message_end",
        message: { id: "user-2", role: "user", timestamp: 2, text: "hi", toolCalls: [] },
      });
    });
    // 两条相同文本各自独立显示（不重复、不误合并）
    const rows = userRows(el);
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("ChatPage 中止按钮生命周期（回复完成即消失）", () => {
  it("running 时显示中止；message_end 后无任何事件 → 待定超时自动消失", async () => {
    vi.useFakeTimers();
    const el = await render();
    act(() => {
      wsEvent?.({ type: "status", status: "running" });
    });
    expect(abortButton(el)).not.toBeNull();

    act(() => {
      wsEvent?.({
        type: "message_end",
        message: { id: "a1", role: "assistant", timestamp: 1, text: "干完了", toolCalls: [] },
      });
    });
    // 回复落盘后的短静默（兜底 5s）内按钮还在（不闪），超时后消失
    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(abortButton(el)).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(abortButton(el)).toBeNull();
  });

  it("message_end 后又有流事件（agent 还在跑）→ 不误翻转，中止按钮保持", async () => {
    vi.useFakeTimers();
    const el = await render();
    act(() => {
      wsEvent?.({ type: "status", status: "running" });
      wsEvent?.({
        type: "message_end",
        message: { id: "a1", role: "assistant", timestamp: 1, text: "第一段", toolCalls: [] },
      });
    });
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    // 静默中来了新的流事件：继续运行，取消待定收尾
    act(() => {
      wsEvent?.({ type: "message_start", message: { id: "a2", role: "assistant", timestamp: 2 } });
      wsEvent?.({ type: "text_delta", messageId: "a2", delta: "第二段" });
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(abortButton(el)).not.toBeNull();
  });

  it("5s 待定误翻 idle 后，新流事件自愈恢复 running（中止按钮回来）", async () => {
    vi.useFakeTimers();
    const el = await render();
    act(() => {
      wsEvent?.({ type: "status", status: "running" });
      wsEvent?.({
        type: "message_end",
        message: { id: "b1", role: "assistant", timestamp: 1, text: "第一段", toolCalls: [] },
      });
    });
    // 超过 5s 待定窗口：误翻 idle，按钮消失
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(abortButton(el)).toBeNull();
    // 段间长间隙后新流事件到达：自愈恢复 running
    act(() => {
      wsEvent?.({ type: "message_start", message: { id: "b2", role: "assistant", timestamp: 2 } });
      wsEvent?.({ type: "text_delta", messageId: "b2", delta: "第二段" });
    });
    expect(abortButton(el)).not.toBeNull();
  });

  it("agent_settled（hub 必达事件）→ 中止按钮立即消失", async () => {
    const el = await render();
    act(() => {
      wsEvent?.({ type: "status", status: "running" });
    });
    expect(abortButton(el)).not.toBeNull();
    act(() => {
      wsEvent?.({ type: "agent_settled" });
    });
    expect(abortButton(el)).toBeNull();
  });
});
