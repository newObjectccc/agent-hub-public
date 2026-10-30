/**
 * ChatPage 交互回归（手机实测 bug 修复验证）：
 * 1. 快速连点/Enter+点击双通道发送 → 只发一条请求（同步防重入）
 * 2. 连续两条相同文本消息各自独立显示，不重复不误合并
 * 3. 回复完成后中止按钮消失（message_end 后无事件 → 待定收尾翻转 idle；
 *    期间有流事件则不误翻转）
 * 4. 新建空会话进入 chat 页必须是空闲态（用户反馈：新建后即显示「思考中」+ 中止按钮，
 *    疑似默认发送消息——实为 server 状态误判；本文件锁定 UI 契约：不默认发送任何消息、
 *    空闲态无等待提示/无中止按钮，且 server 报 running 时既有行为不破坏）
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
    getSessionModels: vi.fn(async () => ({ models: [], currentModel: null, defaultModel: null, warning: null })),
    getPiModels: vi.fn(async () => ({ models: [], currentModel: null, defaultModel: null, warning: null })),
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
  // J1 图标化：中止按钮改 icon-btn + aria-label（不再以可见文字识别）
  return el.querySelector<HTMLButtonElement>(".modebar-right .abort-btn");
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
    const sendBtn = el.querySelector<HTMLButtonElement>(".composer-send")!;
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
    const sendBtn = el.querySelector<HTMLButtonElement>(".composer-send")!;
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
    click(el.querySelector(".composer-send"));
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
    click(el.querySelector(".composer-send"));
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

describe("ChatPage 中止按钮生命周期（服务器确认整轮完成）", () => {
  it("message_end 后短暂静默，核对服务器 idle 后才消失", async () => {
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
    await act(async () => {
      vi.advanceTimersByTime(2);
      await Promise.resolve();
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

  it("核对服务器 idle 后，新流事件自愈恢复 running（中止按钮回来）", async () => {
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
    await act(async () => {
      vi.advanceTimersByTime(6_000);
      await Promise.resolve();
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

  it("错误终态不会被随后 agent_settled 覆盖成正常空闲", async () => {
    const el = await render();
    act(() => {
      wsEvent?.({ type: "status", status: "error" });
      wsEvent?.({ type: "agent_settled" });
    });
    expect(el.querySelector(".badge.error")).not.toBeNull();
  });

  it("一段回复结束超过 5 秒，服务器仍 running 时继续显示中止和等待状态", async () => {
    vi.useFakeTimers();
    const el = await render();
    mocks.getSession.mockResolvedValueOnce({ session: { ...session, status: "running" }, messages: [] });
    act(() => {
      wsEvent?.({ type: "status", status: "running" });
      wsEvent?.({ type: "message_end", message: { id: "partial", role: "assistant", text: "先检查一下", timestamp: 1, toolCalls: [] } });
    });
    await act(async () => { vi.advanceTimersByTime(6_000); await Promise.resolve(); });
    expect(abortButton(el)).not.toBeNull();
    expect(el.querySelector(".wait-stage-bar")).not.toBeNull();
    expect(mocks.getSession).toHaveBeenLastCalledWith("s1", { limit: 1 });
    await act(async () => { vi.advanceTimersByTime(5_001); await Promise.resolve(); });
    expect(abortButton(el)).toBeNull();
  });

  it("发送下一条消息也会取消旧核对，断线时旧 idle 结果不能清掉新任务", async () => {
    vi.useFakeTimers();
    const el = await render();
    let resolve!: (value: unknown) => void;
    mocks.getSession.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    act(() => {
      wsEvent?.({ type: "status", status: "running" });
      wsEvent?.({ type: "message_end", message: { id: "previous", role: "assistant", text: "上一段", timestamp: 1, toolCalls: [] } });
    });
    await act(async () => { vi.advanceTimersByTime(5_001); await Promise.resolve(); });
    typeInput(el, "下一条任务");
    click(el.querySelector(".composer-send"));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { resolve({ session: { ...session, status: "idle" }, messages: [] }); await Promise.resolve(); });
    expect(abortButton(el)).not.toBeNull();
  });

  it("状态核对失败不误判完成，过时的 idle 响应也不能覆盖新流事件", async () => {
    vi.useFakeTimers();
    const el = await render();
    mocks.getSession.mockRejectedValueOnce(new Error("网络暂时不可用"));
    act(() => {
      wsEvent?.({ type: "status", status: "running" });
      wsEvent?.({ type: "message_end", message: { id: "partial", role: "assistant", text: "第一段", timestamp: 1, toolCalls: [] } });
    });
    await act(async () => { vi.advanceTimersByTime(6_000); await Promise.resolve(); });
    expect(abortButton(el)).not.toBeNull();
    let resolve!: (value: unknown) => void;
    mocks.getSession.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await act(async () => { vi.advanceTimersByTime(5_001); await Promise.resolve(); });
    act(() => { wsEvent?.({ type: "message_start", message: { id: "next", role: "assistant", timestamp: 2 } }); });
    await act(async () => { resolve({ session: { ...session, status: "idle" }, messages: [] }); await Promise.resolve(); });
    expect(abortButton(el)).not.toBeNull();
  });
});

describe("ChatPage 新建空会话进入（空闲态，不默认发送消息）", () => {
  function waitBar(el: HTMLElement): HTMLElement | null {
    return el.querySelector<HTMLElement>(".wait-stage-bar");
  }

  it("空会话加载完：无「思考中」等待提示、无中止按钮、发送按钮正常", async () => {
    const el = await render();
    // 无任何阶段化等待反馈（发送中/思考中/工具执行中/回复中均不出现）
    expect(waitBar(el)).toBeNull();
    // 无中止按钮（不是「可以停止」的运行态）
    expect(abortButton(el)).toBeNull();
    // 正常发送按钮（空闲态渲染「发送」而非「发送中…」加载态）
    const sendBtn = el.querySelector<HTMLButtonElement>(".composer-send");
    expect(sendBtn).not.toBeNull();
    expect(sendBtn!.textContent).toContain("发送");
    expect(sendBtn!.querySelector(".spinner")).toBeNull();
    // 输入内容后即可发送（非禁用/中止态）
    typeInput(el, "你好");
    expect(el.querySelector<HTMLButtonElement>(".composer-send")!.disabled).toBe(false);
  });

  it("进入页面不默认发送任何消息（用户疑问：会默认发送吗？→ 不会）", async () => {
    const el = await render();
    await act(async () => {
      await Promise.resolve();
    });
    // 只发生会话拉取（loadSession 对账），不产生任何发送/中止请求
    expect(mocks.getSession).toHaveBeenCalled();
    expect(mocks.sendPromptWithMode).not.toHaveBeenCalled();
    expect(mocks.sendPrompt).not.toHaveBeenCalled();
    expect(mocks.abortSession).not.toHaveBeenCalled();
    // 也没有任何本地用户消息占位（空会话消息列表为空）
    expect(userRows(el)).toHaveLength(0);
  });

  it("server 报 running（外部/别处运行中）→ 进入即显示「思考中」+ 中止按钮（既有行为不破坏）", async () => {
    mocks.getSession.mockResolvedValue({
      session: { ...session, status: "running" },
      messages: [],
      hasMore: false,
      nextBefore: null,
    });
    const el = await render();
    expect(waitBar(el)).not.toBeNull();
    expect(waitBar(el)!.textContent).toContain("思考中");
    expect(abortButton(el)).not.toBeNull();
  });
});
