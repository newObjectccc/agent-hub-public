/**
 * 滚动锚定 / 窗口化行为回归（perf 改造"行为零变化"红线）：
 * 1. [AC5] scroll 事件与流式提交同帧：用户上滚越过 160px 后，同帧内的消息提交
 *    不得误触发自动滚底（stickToBottomRef 若只在 scroll 的 rAF 回调更新，
 *    同帧提交会读到过期的"在底部"值 → 错误拉回底部）
 * 2. [AC5 反向] 停在底部附近时同帧提交仍自动滚底（跟随行为保持，修复不得反向破坏）
 * 3. [AC7] loadOlder 前插更早一页：同一更新批次窗口必须重置为全量。
 *    windowStart 是 messages 数组下标，前插 P 条后 slice(windowStart) 错位 →
 *    渲染内容错位 / scrollHeight 恢复公式读错 → 跳动、夹底。
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
  getSession: vi.fn(),
  sendPromptWithMode: vi.fn(),
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
  name: "滚动回归",
  cwd: "/tmp/demo",
  updatedAt: "2026-02-18T11:00:00.000Z",
  messageCount: 0,
  status: "idle",
  lastUserMessage: null,
  lastAssistantMessage: null,
  sessionFile: "/tmp/demo/s1.jsonl",
  isSubAgent: false,
};

function historyMessages(count: number, prefix = "h"): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      id: `${prefix}-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      timestamp: 1_000 + i,
      text: `消息 ${prefix}-${i}：内容`,
      thinking: null,
      toolCalls: [],
    });
  }
  return out;
}

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ChatPage sessionId="s1" />);
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

interface ScrollProbe {
  /** 当前 scrollTop（getter 镜像） */
  top: () => number;
  /** 代码写入 scrollTop 的记录（模拟用户滚动用 jump，不入账） */
  sets: number[];
  /** scrollTo 调用记录 */
  scrollToCalls: Array<{ top: number; behavior?: string }>;
  /** 模拟用户/浏览器滚动（不记作代码写入） */
  jump: (v: number) => void;
  /** 是否发生过滚动行为（赋值 scrollTop 或 scrollTo） */
  scrolled: () => boolean;
}

/**
 * 桩掉 jsdom 不可测的滚动几何：
 * scrollHeight/clientHeight 只读 → defineProperty；scrollTop 读写可追踪；
 * scrollTo 记录调用（旧路径走 scrollTo 或直接赋值都能被断言捕获）。
 */
function trackScroll(
  el: HTMLElement,
  opts: { initialTop: number; scrollHeight: () => number; clientHeight: number },
): ScrollProbe {
  let top = opts.initialTop;
  const sets: number[] = [];
  const scrollToCalls: Array<{ top: number; behavior?: string }> = [];
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      sets.push(v);
      top = v;
    },
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => opts.scrollHeight(),
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => opts.clientHeight,
  });
  Object.defineProperty(el, "scrollTo", {
    configurable: true,
    value: (arg: number | { top: number; behavior?: string }) => {
      const call = typeof arg === "number" ? { top: arg } : arg;
      scrollToCalls.push(call);
      top = call.top;
    },
  });
  return {
    top: () => top,
    sets,
    scrollToCalls,
    jump: (v: number) => {
      top = v;
    },
    scrolled: () => sets.length > 0 || scrollToCalls.length > 0,
  };
}

function chatEl(): HTMLElement {
  const el = container!.querySelector<HTMLElement>(".chat-messages");
  expect(el).not.toBeNull();
  return el!;
}

beforeEach(() => {
  wsEvent = null;
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "Date"],
  });
  mocks.getSession.mockReset();
  mocks.sendPromptWithMode.mockReset();
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
  vi.unstubAllGlobals();
});

describe("stick-to-bottom 一帧竞态（AC5）", () => {
  it("scroll 事件与流式提交同帧：上滚越过 160px 后不误滚底", async () => {
    mocks.getSession.mockResolvedValue({ session, messages: historyMessages(5), hasMore: false, nextBefore: null });
    await render();
    const rows = () => container!.querySelectorAll(".msg-row").length;
    const el = chatEl();
    // 初始 5 条 + 后续每条占位 111px 高；视口 400
    const probe = trackScroll(el, {
      initialTop: 4600,
      scrollHeight: () => 5000 + Math.max(0, rows() - 5) * 111,
      clientHeight: 400,
    });
    // 预热：用户贴底看流式（建立“更新前内容几何”基线，与真实序列一致）
    await act(async () => {
      el.dispatchEvent(new Event("scroll"));
      wsEvent?.({ type: "message_start", message: { id: "live-warm", role: "assistant", timestamp: 4_999 } });
    });
    probe.sets.length = 0;
    probe.scrollToCalls.length = 0;

    // 用户上滚到中部（距底 3600px > 160px 阈值）
    probe.jump(1000);

    // 同一帧：scroll 事件已派发（rAF 回调未执行）+ 流式消息提交（messages 更新）
    await act(async () => {
      el.dispatchEvent(new Event("scroll"));
      wsEvent?.({ type: "message_start", message: { id: "live-a", role: "assistant", timestamp: 5_000 } });
    });

    // 不触发滚动（stick-to-bottom 决策不得读到过期的“在底部”状态）
    expect(probe.scrolled()).toBe(false);
    expect(probe.top()).toBe(1000);
  });

  it("内容大幅增长（首屏加载/图片撑高）：仍自动滚底（贴底语义保持）", async () => {
    mocks.getSession.mockResolvedValue({ session, messages: historyMessages(5), hasMore: false, nextBefore: null });
    await render();
    const rows = () => container!.querySelectorAll(".msg-row").length;
    const el = chatEl();
    // 首屏后新增内容很高（>160px）也不得丢失跟随
    const probe = trackScroll(el, {
      initialTop: 0,
      scrollHeight: () => 2000 + Math.max(0, rows() - 5) * 2000,
      clientHeight: 400,
    });
    await act(async () => {
      el.dispatchEvent(new Event("scroll"));
      wsEvent?.({ type: "message_start", message: { id: "live-big", role: "assistant", timestamp: 5_000 } });
    });
    expect(probe.scrolled()).toBe(true);
    // 新 scrollHeight = 4000 → 底部目标 3600
    expect(probe.top()).toBe(3600);
  });

  it("停在底部附近：同帧流式提交仍自动滚底（跟随行为保持）", async () => {
    mocks.getSession.mockResolvedValue({ session, messages: historyMessages(5), hasMore: false, nextBefore: null });
    await render();
    const rows = () => container!.querySelectorAll(".msg-row").length;
    const el = chatEl();
    const probe = trackScroll(el, {
      initialTop: 4600,
      scrollHeight: () => 5000 + Math.max(0, rows() - 5) * 111,
      clientHeight: 400,
    });

    await act(async () => {
      el.dispatchEvent(new Event("scroll"));
      wsEvent?.({ type: "message_start", message: { id: "live-b", role: "assistant", timestamp: 5_000 } });
    });

    // 新消息使 scrollHeight 变为 5111 → 底部目标 4711
    expect(probe.scrolled()).toBe(true);
    expect(probe.top()).toBe(4711);
  });
});

describe("loadOlder 前插与窗口化锚点（AC7）", () => {
  const ROW_H = 100;
  const GAP = 11;
  let realGBCR: typeof HTMLElement.prototype.getBoundingClientRect;

  /** 滚动几何桩：行高 100、视口 400、列表内容位于底部（scrollTop = rows*111-11-400 口径） */
  function stubGeometry(): void {
    realGBCR = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
      let height = ROW_H;
      let top = 0;
      if (this.classList.contains("chat-messages")) {
        height = 400;
        top = 0;
      } else if (this.classList.contains("msg-list")) {
        const rows = container?.querySelectorAll(".msg-row").length ?? 0;
        const pad = container?.querySelector<HTMLElement>(".msg-window-pad");
        height = rows * (ROW_H + GAP) - GAP + (pad ? parseFloat(pad.style.height) : 0);
        top = -(height - 400);
      }
      return {
        top,
        height,
        bottom: top + height,
        left: 0,
        right: 320,
        width: 320,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    };
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  }

  it("loadOlder 前插更早一页：同批窗口重置为全量（无错位帧、无夹底）", async () => {
    stubGeometry();
    mocks.getSession.mockImplementation((_id: string, opts?: { before?: string }) => {
      if (opts?.before) {
        // 更早一页：50 条
        return Promise.resolve({ session, messages: historyMessages(50, "p"), hasMore: true, nextBefore: null });
      }
      return Promise.resolve({ session, messages: historyMessages(80), hasMore: true, nextBefore: null });
    });
    await render();
    const el = chatEl();
    const probe = trackScroll(el, {
      initialTop: 0,
      scrollHeight: () => {
        const rows = container!.querySelectorAll(".msg-row").length;
        const pad = container!.querySelector<HTMLElement>(".msg-window-pad");
        return rows * (ROW_H + GAP) - GAP + (pad ? parseFloat(pad.style.height) : 0) + (pad ? GAP : 0);
      },
      clientHeight: 400,
    });

    const c = container!;
    // 收敛窗口（渐进限速：多帧逼近目标窗口）
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(50);
      });
    }
    // 前置：80 条已窗口化（只渲染尾部若干行 + 顶部占位）
    const padBefore = c.querySelector<HTMLElement>(".msg-window-pad");
    expect(padBefore).not.toBeNull();
    const rowsBefore = c.querySelectorAll(".msg-row").length;
    expect(rowsBefore).toBeLessThan(80);

    const topBefore = probe.top(); // restore 读 scrollHeight/scrollTop（下面断言锚点守恒）
    const scrollHeightBefore = Number(
      (Object.getOwnPropertyDescriptor(el, "scrollHeight")!.get as () => number)(),
    );

    // 触发"加载更早"（前插 50 条 → messages 下标整体 +50，windowStart 错位）
    const btn = Array.from(c.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("加载更早消息"),
    );
    expect(btn).not.toBeNull();
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // 关键断言：同一更新批次窗口已重置全量 —— 无占位、全部 130 条按正确顺序渲染。
    // 旧实现 slice(windowStart=旧下标) 会渲染错位内容（丢前插行/丢历史头部）→ 跳动、夹底。
    expect(c.querySelector(".msg-window-pad")).toBeNull();
    expect(c.querySelectorAll(".msg-row")).toHaveLength(130);
    expect(c.querySelector("#msg-p-0")).not.toBeNull();
    expect(c.querySelector("#msg-h-0")).not.toBeNull();
    expect(c.querySelector("#msg-h-79")).not.toBeNull();

    // 锚点守恒：restore = scrollHeight_new - scrollHeight_old + scrollTop_old，
    // 前插 50 行（50×111px）后视口内容不动 → scrollTop 增量 ≈ 前插内容高度
    const restoredTop = probe.sets[probe.sets.length - 1];
    expect(restoredTop).toBe(
      Number((Object.getOwnPropertyDescriptor(el, "scrollHeight")!.get as () => number)()) -
        scrollHeightBefore +
        topBefore,
    );
    expect(restoredTop).toBeGreaterThan(50 * (ROW_H + GAP) - 2);
  });
});
