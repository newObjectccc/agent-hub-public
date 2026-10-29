/**
 * ChatPage UX 批次（e1-chat-ux）集成回归：
 * 1. 阶段化等待反馈：发送中→思考中→工具执行中→回复中→完成（状态条 + 秒级计时 + 任务后台提示）
 * 2. 发送失败重试：网络错误标记「发送失败」，点击重试原样重发
 * 3. 时间分隔线：消息流按日期分组
 * 4. ↓ 新消息按钮：上翻历史时新消息累计，点击回底部
 * 5. 预期提示条：面板驱动过的会话首次进入提示（可关闭记住）；纯终端会话不显示
 * 6. 发送触觉 navigator.vibrate(10)
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
  getSessionAgents: vi.fn(),
  forkSession: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: {
    getSession: mocks.getSession,
    sendPrompt: mocks.sendPrompt,
    abortSession: mocks.abortSession,
    getSessionAgents: mocks.getSessionAgents,
    forkSession: mocks.forkSession,
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
  name: "UX 会话",
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

function click(el: Element | null): void {
  expect(el).not.toBeNull();
  act(() => {
    (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement | null {
  return Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === text) ?? null;
}

beforeEach(() => {
  wsEvent = null;
  localStorage.clear();
  mocks.sendPromptWithMode.mockReset();
  mocks.sendPromptWithMode.mockResolvedValue({ result: { accepted: true, mode: "prompt" }, busyFallback: false });
  mocks.getSession.mockReset();
  mocks.getSession.mockResolvedValue({ session, messages: [], hasMore: false, nextBefore: null });
  mocks.sendPrompt.mockReset();
  mocks.abortSession.mockReset();
  mocks.getSessionAgents.mockReset();
  mocks.getSessionAgents.mockResolvedValue({ agents: [] });
  mocks.forkSession.mockReset();
  mocks.forkSession.mockResolvedValue({ session: { ...session, id: "s1-fork" } });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("阶段化等待反馈（状态条生命周期 + 秒级计时）", () => {
  it("发送中→思考中→工具执行中→回复中→完成；计时跳动；任务后台提示同区显示", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const el = await render();
    typeInput(el, "跑个工具试试");
    click(el.querySelector(".composer-send"));
    await flush();

    const bar = () => el.querySelector(".wait-stage-bar");
    expect(bar()).not.toBeNull();
    expect(bar()!.textContent).toContain("🧠");
    expect(bar()!.textContent).toContain("思考中");
    expect(bar()!.textContent).toContain("· 0s");
    // 任务生命周期预期提示（随主批次第三条需求）
    expect(el.querySelector(".bg-hint")!.textContent).toContain("任务在后台继续");
    expect(el.querySelector(".bg-hint")!.textContent).toContain("server 重启会中断");

    act(() => {
      wsEvent?.({ type: "tool_start", messageId: "live-1", toolCall: { name: "bash", summary: "ls" } });
    });
    expect(bar()!.textContent).toContain("🔧");
    expect(bar()!.textContent).toContain("工具执行中");

    act(() => {
      vi.advanceTimersByTime(45_000);
    });
    expect(bar()!.textContent).toContain("· 45s");

    act(() => {
      wsEvent?.({ type: "text_delta", messageId: "live-1", delta: "好的，" });
    });
    expect(bar()!.textContent).toContain("✍️");
    expect(bar()!.textContent).toContain("回复中");

    act(() => {
      wsEvent?.({ type: "agent_settled" });
    });
    expect(bar()).toBeNull();
  });

  it("message_end 后 5s 无事件，核对服务器 idle 后阶段条消失", async () => {
    vi.useFakeTimers();
    const el = await render();
    act(() => {
      wsEvent?.({ type: "status", status: "running" });
    });
    expect(el.querySelector(".wait-stage-bar")).not.toBeNull();
    await act(async () => {
      wsEvent?.({
        type: "message_end",
        message: { id: "a1", role: "assistant", timestamp: 1, text: "完成", toolCalls: [] },
      });
      vi.advanceTimersByTime(5_100);
      await Promise.resolve();
    });
    expect(el.querySelector(".wait-stage-bar")).toBeNull();
  });
});

describe("发送失败重试", () => {
  it("网络错误 → 该条标记「发送失败」+ 重试按钮；点击原样重发并清除标记", async () => {
    mocks.sendPromptWithMode.mockRejectedValueOnce(new Error("网络错误"));
    const el = await render();
    typeInput(el, "重要消息");
    click(el.querySelector(".composer-send"));
    await flush();

    expect(el.querySelector(".send-failed")).not.toBeNull();
    expect(el.textContent).toContain("发送失败");
    expect(el.querySelector(".wait-stage-bar")).toBeNull();

    click(el.querySelector(".send-retry"));
    await flush();
    expect(mocks.sendPromptWithMode).toHaveBeenCalledTimes(2);
    expect(mocks.sendPromptWithMode.mock.calls[1][1]).toBe("重要消息");
    expect(el.querySelector(".send-failed")).toBeNull();
    // 只有一条占位（重试不新增消息）
    expect(el.querySelectorAll(".msg-row.user")).toHaveLength(1);
    expect(el.querySelector(".wait-stage-bar")).not.toBeNull();
  });

  it("5xx/未接受（accepted:false）同样标记失败可重试", async () => {
    mocks.sendPromptWithMode.mockResolvedValueOnce({ result: { accepted: false, mode: "prompt" }, busyFallback: false });
    const el = await render();
    typeInput(el, "hi");
    click(el.querySelector(".composer-send"));
    await flush();
    expect(el.querySelector(".send-failed")).not.toBeNull();
  });
});

describe("时间分隔线", () => {
  it("消息流按日期分组（首条前也插），今天/昨天/日期标签", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 1, 18, 12, 0, 0).getTime());
    const messages: SessionMessage[] = [
      { id: "m1", role: "user", timestamp: new Date(2026, 1, 17, 22, 0, 0).getTime(), text: "昨天问", toolCalls: [] },
      { id: "m2", role: "assistant", timestamp: new Date(2026, 1, 17, 22, 1, 0).getTime(), text: "昨天答", toolCalls: [] },
      { id: "m3", role: "user", timestamp: new Date(2026, 1, 18, 10, 0, 0).getTime(), text: "今天问", toolCalls: [] },
    ];
    mocks.getSession.mockResolvedValue({ session, messages, hasMore: false, nextBefore: null });
    const el = await render();
    const dividers = Array.from(el.querySelectorAll<HTMLElement>(".date-divider-label")).map((d) => d.textContent);
    expect(dividers).toEqual(["昨天", "今天"]);
  });
});

describe("↓ 新消息按钮", () => {
  it("上翻历史时新消息到达 → 浮出「↓ N 条新消息」，点击回底部消失；贴底时不出现", async () => {
    const el = await render();
    const scrollEl = el.querySelector<HTMLElement>(".chat-messages")!;
    Object.defineProperty(scrollEl, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scrollEl, "clientHeight", { value: 300, configurable: true });
    act(() => {
      (scrollEl as HTMLElement & { scrollTop: number }).scrollTop = 0;
      scrollEl.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    act(() => {
      wsEvent?.({
        type: "message_end",
        message: { id: "n1", role: "assistant", timestamp: 2, text: "新消息 1", toolCalls: [] },
      });
      wsEvent?.({
        type: "message_end",
        message: { id: "n2", role: "assistant", timestamp: 3, text: "新消息 2", toolCalls: [] },
      });
    });
    const btn = el.querySelector<HTMLButtonElement>(".new-messages-btn");
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain("↓ 2 条新消息");
    // 不强制拉扯视口：消息已渲染但浮标独立
    expect(el.textContent).toContain("新消息 1");

    click(btn);
    expect(el.querySelector(".new-messages-btn")).toBeNull();

    // 回到底部后新消息自动跟随，不再弹浮标
    act(() => {
      (scrollEl as HTMLElement & { scrollTop: number }).scrollTop = 700;
      scrollEl.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    act(() => {
      wsEvent?.({
        type: "message_end",
        message: { id: "n3", role: "assistant", timestamp: 4, text: "新消息 3", toolCalls: [] },
      });
    });
    expect(el.querySelector(".new-messages-btn")).toBeNull();
  });
});

describe("驱动来源标注与预期提示条", () => {
  it("面板驱动过的会话进入 → 一次性提示条（复制为新会话 / 知道了记住关闭）", async () => {
    mocks.getSession.mockResolvedValue({
      session: { ...session, lastDrivenBy: "panel" },
      messages: [],
      hasMore: false,
      nextBefore: null,
    });
    const el = await render();
    const hint = el.querySelector(".driver-hint");
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain("重新打开该会话，载入新增消息");
    // 顶栏 📱 面板驱动 徽章
    expect(el.querySelector(".badge.driven-panel")).not.toBeNull();

    click(buttonByText(el, "复制为新会话"));
    await flush();
    expect(mocks.forkSession).toHaveBeenCalledTimes(1);

    click(buttonByText(el, "知道了"));
    expect(el.querySelector(".driver-hint")).toBeNull();
    expect(localStorage.getItem("agent-hub.driverHint.v1:s1")).toBe("1");
  });

  it("纯终端会话（lastDrivenBy=terminal）→ 🖥 终端驱动徽章，无提示条", async () => {
    mocks.getSession.mockResolvedValue({
      session: { ...session, messageCount: 3, lastDrivenBy: "terminal" },
      messages: [],
      hasMore: false,
      nextBefore: null,
    });
    const el = await render();
    expect(el.querySelector(".driver-hint")).toBeNull();
    expect(el.querySelector(".badge.driven-terminal")).not.toBeNull();
    expect(el.querySelector(".badge.driven-panel")).toBeNull();
  });

  it("全新会话（无驱动史）→ 不显示驱动徽章与提示条", async () => {
    const el = await render();
    expect(el.querySelector(".driver-hint")).toBeNull();
    expect(el.querySelector(".badge.driven-terminal")).toBeNull();
    expect(el.querySelector(".badge.driven-panel")).toBeNull();
  });

  it("发送成功 → 徽章切到 📱 面板驱动（本地即时反馈）", async () => {
    const el = await render();
    typeInput(el, "从面板发一条");
    click(el.querySelector(".composer-send"));
    await flush();
    expect(el.querySelector(".badge.driven-panel")).not.toBeNull();
  });
});

describe("发送触觉 + 输入框自增高", () => {
  it("发送成功 navigator.vibrate(10)", async () => {
    const vibrate = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", { vibrate, clipboard: undefined });
    const el = await render();
    typeInput(el, "振动");
    click(el.querySelector(".composer-send"));
    await flush();
    expect(vibrate).toHaveBeenCalledWith(10);
  });

  it("textarea 随内容自增高，上限 6 行（140px）滚动", async () => {
    const el = await render();
    const textarea = el.querySelector<HTMLTextAreaElement>("textarea")!;
    Object.defineProperty(textarea, "scrollHeight", { value: 100, configurable: true });
    typeInput(el, "第一行");
    expect(textarea.style.height).toBe("100px");
    Object.defineProperty(textarea, "scrollHeight", { value: 400, configurable: true });
    typeInput(el, "很多行\n".repeat(20));
    expect(textarea.style.height).toBe("140px");
  });
});

describe("键盘避让（visualViewport）", () => {
  it("键盘弹出 → --kb-inset 抬高输入区；收起归零", async () => {
    const listeners = new Map<string, Set<() => void>>();
    const vv = {
      height: 800,
      offsetTop: 0,
      addEventListener: (type: string, fn: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: () => void) => {
        listeners.get(type)?.delete(fn);
      },
    };
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    const el = await render();
    // 初始无键盘：inset 0
    expect(el.querySelector(".chat-page")!.getAttribute("style")).toContain("--kb-inset: 0px");

    act(() => {
      vv.height = 520;
      listeners.get("resize")?.forEach((fn) => fn());
    });
    expect(el.querySelector(".chat-page")!.getAttribute("style")).toContain("--kb-inset: 280px");

    act(() => {
      vv.height = 800;
      listeners.get("resize")?.forEach((fn) => fn());
    });
    expect(el.querySelector(".chat-page")!.getAttribute("style")).toContain("--kb-inset: 0px");
    delete (window as unknown as Record<string, unknown>).visualViewport;
  });
});

describe("顶部提示行（chat-notice）可手动关闭", () => {
  it("error 事件弹出提示行，✕（aria-label）点击后消失", async () => {
    const el = await render();
    act(() => {
      wsEvent?.({ type: "error", message: "运行期炸了" } as unknown as WsEvent);
    });
    const notice = el.querySelector(".chat-notice");
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain("运行期炸了");
    const close = el.querySelector<HTMLButtonElement>(".chat-notice-close");
    expect(close).not.toBeNull();
    expect(close!.getAttribute("aria-label")).toBe("关闭提示");
    click(close);
    expect(el.querySelector(".chat-notice")).toBeNull();
  });
});
