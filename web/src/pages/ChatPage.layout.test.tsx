/**
 * i1 chat 布局精修回归（Redmi K90 真机反馈 + 子代理面板追加项）：
 * 1. 头部收纳：git 并入顶栏按钮（subbar 不再占一行）；cwd/来源/驱动/子代理信息收进 ⋯ 菜单；
 *    发送模式入口移入输入按钮行（空闲态不占整行）
 * 2. modebar 仅活动期显示（running/等待/子代理/队列/断线）；running 中止按钮与子代理折叠头同行
 * 3. 子代理面板：进入会话默认收起，手动展开/收起偏好按会话持久
 * 4. 新消息浮标误报：贴底（含大消息撑高）不弹；上翻追加弹 N=1；首屏对账不弹
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubAgentActivity } from "../api/types";
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
let wsStatus: ((connected: boolean) => void) | null = null;

vi.mock("../hooks/useSessionSocket", () => ({
  useSessionSocket: (opts: {
    onEvent: (event: WsEvent) => void;
    onStatusChange?: (connected: boolean) => void;
  }) => {
    wsEvent = opts.onEvent;
    wsStatus = opts.onStatusChange ?? null;
  },
}));

import { ChatPage } from "./ChatPage";

const session = {
  id: "s1",
  source: "pi" as const,
  name: "布局会话",
  cwd: "/tmp/i1-demo",
  updatedAt: "2026-02-18T11:00:00.000Z",
  messageCount: 0,
  status: "idle" as const,
  lastUserMessage: null,
  lastAssistantMessage: null,
  sessionFile: "/tmp/i1-demo/s1.jsonl",
  isSubAgent: true,
  lastDrivenBy: "terminal" as const,
};

const agent = (over: Partial<SubAgentActivity> = {}): SubAgentActivity => ({
  sessionId: "sub-1",
  name: "tester",
  startedAt: Date.now() - 5_000,
  updatedAt: Date.now(),
  status: "running",
  done: false,
  toolRunning: true,
  currentTool: "bash",
  lastOutput: "跑测试中",
  resultSummary: null,
  ...over,
});

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

async function renderFresh(): Promise<HTMLElement> {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  return render();
}

function click(el: Element | null): void {
  expect(el).not.toBeNull();
  act(() => {
    (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** 模拟消息区几何（jsdom 无布局） */
function mockScroll(el: HTMLElement, { scrollHeight, clientHeight, scrollTop }: { scrollHeight: number; clientHeight: number; scrollTop: number }): void {
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  (el as HTMLElement & { scrollTop: number }).scrollTop = scrollTop;
}

function messageEnd(id: string, text: string): void {
  act(() => {
    wsEvent?.({
      type: "message_end",
      message: { id, role: "assistant", timestamp: 1, text, toolCalls: [] },
    });
  });
}

beforeEach(() => {
  wsEvent = null;
  wsStatus = null;
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
});

describe("i1 头部收纳（顶栏一行 + git 并入 + ⋯ 菜单信息）", () => {
  it("subbar 不再占一行；git 入口在顶栏；⋯ 菜单含 cwd/来源/驱动/子代理信息（信息零损失）", async () => {
    const el = await render();
    // git 状态行移除（原 54px 常驻行），入口并入顶栏图标按钮
    expect(el.querySelector(".chat-subbar")).toBeNull();
    expect(el.querySelector(".chat-git-btn")).not.toBeNull();
    // 子代理标记不再常驻顶栏（换行挤压根因），收进 ⋯ 菜单
    expect(el.querySelector(".chat-header .badge.subagent")).toBeNull();
    // ⋯ 菜单打开后信息齐全
    click(el.querySelector(".action-menu-wrap .tool-btn"));
    const info = el.querySelector(".action-menu-info");
    expect(info).not.toBeNull();
    expect(info!.textContent).toContain("/tmp/i1-demo");
    expect(info!.querySelector(".badge.source-pi")).not.toBeNull();
    expect(info!.querySelector(".badge.driven-terminal")).not.toBeNull();
    expect(info!.querySelector(".badge.subagent")).not.toBeNull();
    // 操作入口仍在
    expect(el.querySelector(".action-menu-item")!.textContent).toContain("复制为新会话");
  });

  it("发送模式入口移入输入按钮行；空闲态 modebar 零占位", async () => {
    const el = await render();
    act(() => {
      wsStatus?.(true); // WS 正常连接 = 空闲态
    });
    expect(el.querySelector(".composer-actions .mode-menu-wrap")).not.toBeNull();
    expect(el.querySelector(".composer-modebar")).toBeNull();
    // 展开发送模式菜单仍可用（功能零损失）
    click(el.querySelector(".composer-actions .mode-trigger"));
    expect(el.querySelector(".mode-menu")).not.toBeNull();
    expect(el.querySelectorAll(".mode-menu-item").length).toBeGreaterThan(0);
  });
});

describe("i1 modebar 空间分配（running 中止按钮不挤爆子代理区）", () => {
  it("running 时 modebar 出现：子代理折叠头与中止按钮同行且都在 modebar 内", async () => {
    mocks.getSessionAgents.mockResolvedValue({ agents: [agent()] });
    const el = await render();
    act(() => {
      wsStatus?.(true);
      wsEvent?.({ type: "status", status: "running" });
    });
    const modebar = el.querySelector(".composer-modebar");
    expect(modebar).not.toBeNull();
    // 子代理区与中止按钮同属一个 flex 行（结构契约：CSS 里 nowrap + flex 策略保证不换行）
    expect(modebar!.querySelector(".subagent-panel.inline")).not.toBeNull();
    expect(modebar!.querySelector(".subagent-panel-toggle")).not.toBeNull();
    expect(modebar!.querySelector(".modebar-right .abort-btn")).not.toBeNull();
    // 发送模式入口不在 modebar（避免四元素挤一行），在输入按钮行
    expect(modebar!.querySelector(".mode-menu-wrap")).toBeNull();
    expect(el.querySelector(".composer-actions .mode-menu-wrap")).not.toBeNull();
  });

  it("断线提示保留在 modebar（功能零损失）", async () => {
    const el = await render();
    act(() => {
      wsStatus?.(false);
    });
    const modebar = el.querySelector(".composer-modebar");
    expect(modebar).not.toBeNull();
    expect(modebar!.textContent).toContain("连接断开");
  });
});

describe("i1 子代理面板：进入默认收起 + 偏好按会话持久", () => {
  it("有子代理的会话进入 → 默认收起（一行摘要/角标），不自动展开", async () => {
    mocks.getSessionAgents.mockResolvedValue({ agents: [agent()] });
    const el = await render();
    expect(el.querySelector(".subagent-panel-toggle")!.textContent).toBe("展开");
    expect(el.querySelector(".subagent-card")).toBeNull();
  });

  it("手动展开 → 记住展开偏好；重进保持展开；再收起 → 重进保持收起", async () => {
    mocks.getSessionAgents.mockResolvedValue({ agents: [agent()] });
    const el = await render();
    click(el.querySelector(".subagent-panel-toggle"));
    expect(el.querySelector(".subagent-card")).not.toBeNull();
    expect(localStorage.getItem("agent-hub.subagentPanel.v1:s1")).toBe("0"); // 0 = 展开

    const el2 = await renderFresh();
    expect(el2.querySelector(".subagent-card")).not.toBeNull();

    click(el2.querySelector(".subagent-panel-toggle"));
    expect(el2.querySelector(".subagent-card")).toBeNull();
    expect(localStorage.getItem("agent-hub.subagentPanel.v1:s1")).toBe("1"); // 1 = 收起

    const el3 = await renderFresh();
    expect(el3.querySelector(".subagent-card")).toBeNull();
    expect(el3.querySelector(".subagent-panel-toggle")!.textContent).toBe("展开");
  });
});

describe("i1 新消息浮标误报（贴底不弹 / 上翻弹）", () => {
  it("贴底状态追加消息 → 不弹浮标", async () => {
    const el = await render();
    const scrollEl = el.querySelector<HTMLElement>(".chat-messages")!;
    mockScroll(scrollEl, { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 });
    messageEnd("m1", "第一条");
    expect(el.querySelector(".new-messages-btn")).toBeNull();
  });

  it("大消息撑高 scrollHeight（旧口径根因）：上次布局贴底 → 仍不弹浮标", async () => {
    const el = await render();
    const scrollEl = el.querySelector<HTMLElement>(".chat-messages")!;
    // 贴底（1000/300/700 → 距底 0）→ 第一条消息：effect 记下内容高 1000
    mockScroll(scrollEl, { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 });
    messageEnd("m1", "第一条");
    // 大消息把内容撑到 1400：当前几何距底 400（>160），但用户没动 → 旧口径会误报
    mockScroll(scrollEl, { scrollHeight: 1400, clientHeight: 300, scrollTop: 700 });
    messageEnd("m2", "第二条是一条很长很长的消息".repeat(8));
    expect(el.querySelector(".new-messages-btn")).toBeNull();
  });

  it("上翻历史追加消息 → 浮标 N=1；点回底部消失", async () => {
    const el = await render();
    const scrollEl = el.querySelector<HTMLElement>(".chat-messages")!;
    mockScroll(scrollEl, { scrollHeight: 1400, clientHeight: 300, scrollTop: 0 });
    messageEnd("m1", "上翻时到达");
    const btn = el.querySelector<HTMLButtonElement>(".new-messages-btn");
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain("↓ 1 条新消息");
    click(btn);
    expect(el.querySelector(".new-messages-btn")).toBeNull();
  });

  it("首屏对账填充（loadSession）不弹浮标：打开会话就在最新处", async () => {
    mocks.getSession.mockResolvedValue({
      session,
      messages: [
        { id: "h1", role: "assistant", timestamp: 1, text: "历史 1", toolCalls: [] },
        { id: "h2", role: "assistant", timestamp: 2, text: "历史 2", toolCalls: [] },
      ],
      hasMore: false,
      nextBefore: null,
    });
    const el = await render();
    const scrollEl = el.querySelector<HTMLElement>(".chat-messages")!;
    mockScroll(scrollEl, { scrollHeight: 2000, clientHeight: 300, scrollTop: 0 });
    expect(el.querySelector(".new-messages-btn")).toBeNull();
  });
});

describe("J1 顶栏图标按钮统一规范（Redmi K90 实测反馈）", () => {
  it("顶栏全部图标按钮同属 .icon-btn 盒子（返回/树/git/⋯/模式切换）且带 aria-label 语义", async () => {
    const el = await render();
    const expectIconBtn = (sel: string, aria: string): void => {
      const btn = el.querySelector<HTMLButtonElement>(sel);
      expect(btn, sel).not.toBeNull();
      expect(btn!.classList.contains("icon-btn"), sel).toBe(true);
      expect(btn!.getAttribute("aria-label"), sel).toContain(aria);
    };
    expectIconBtn(".chat-header .back", "返回列表");
    expectIconBtn(".chat-header .chat-tree-btn", "查看会话分支树");
    expectIconBtn(".chat-header .chat-git-btn", "git");
    expectIconBtn(".chat-header .attach-trigger", "会话驱动模式");
    expectIconBtn(".action-menu-wrap .tool-btn", "会话操作");
    // 树按钮纯图标（可见文字为零，语义在 aria-label/title）
    expect(el.querySelector(".chat-tree-btn")!.textContent!.trim()).toBe("");
  });

  it("running 态顶栏无「运行中」文字徽章（信息冗余），模式区分图标保留", async () => {
    const el = await render();
    act(() => {
      wsStatus?.(true);
      wsEvent?.({ type: "status", status: "running" });
    });
    const header = el.querySelector(".chat-header")!;
    expect(header.textContent).not.toContain("运行中");
    expect(header.textContent).not.toContain("空闲");
    // 模式区分本身保留（纯图标触发器仍在）
    expect(header.querySelector(".attach-trigger")).not.toBeNull();
  });

  it("状态徽章：空闲不再显示（真机反馈：噪音无信息），错误保留（信息不丢）", async () => {
    const el = await render();
    act(() => {
      wsStatus?.(true);
    });
    // 真机反馈：空闲标签对用户是噪音（状态交给阶段条/echo 表达），不再渲染
    expect(el.querySelector(".chat-header .badge.idle")).toBeNull();
    act(() => {
      wsEvent?.({ type: "status", status: "error" });
    });
    expect(el.querySelector(".chat-header .badge.error")).not.toBeNull();
  });

  it("中止按钮并入同一图标规范：icon-btn 危险色盒子 + aria-label，无可见文字", async () => {
    const el = await render();
    act(() => {
      wsStatus?.(true);
      wsEvent?.({ type: "status", status: "running" });
    });
    const abort = el.querySelector<HTMLButtonElement>(".modebar-right .abort-btn");
    expect(abort).not.toBeNull();
    expect(abort!.classList.contains("icon-btn")).toBe(true);
    expect(abort!.textContent!.trim()).toBe("");
    expect(abort!.querySelector("svg")).not.toBeNull();
    expect(abort!.getAttribute("aria-label")).toBe("中止当前任务");
    expect(abort!.getAttribute("title")).toBe("中止当前任务");
  });
});
