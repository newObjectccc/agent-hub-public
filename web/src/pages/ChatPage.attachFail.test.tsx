/**
 * 「假接管」不丢消息 + 平行模式知情权回归（P0-2 / P2-8）。
 *
 * 修复前的真机踩坑链：关掉电脑终端后的 90s 内（心跳 TTL）打开会话 → `isOnline` 仍 true →
 * 前端自动接管并提示"终端在线，已默认接管终端" → 消息入队却没人取（扩展随终端进程一起没了）→
 * 60s 后才给一条小字提示 → detach 把指令取消，只有一条 echo → **消息既不入离线队列也不回落
 * 平行模式，输入框已清空 → 文本彻底消失，得重打**。
 *
 * 另一条：双模式说明 sheet 的弹出条件曾绑 `terminal?.online === true`，于是「终端离线、
 * 用手机继续历史会话」这个**平行模式的主场景**永远看不到说明——而平行模式下 pi 的
 * bash/edit/write 会在电脑上真实执行且无人批准，用户完全不知情。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { SessionSummary } from "../api/types";
import type { WsEvent } from "../chat/messageStream";
import { ATTACH_INTRO_KEY } from "../api/attach";
import { getOfflineQueue, type StorageLike } from "../chat/offlineQueue";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  sendPromptWithMode: vi.fn(),
  getSession: vi.fn(),
  sendPrompt: vi.fn(),
  sendAttachMessage: vi.fn(),
  uploadFile: vi.fn(),
  abortSession: vi.fn(),
  getSessionAgents: vi.fn(),
  compactSession: vi.fn(),
  attachSession: vi.fn(),
  detachSession: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: {
    getSessionModels: vi.fn(async () => ({ models: [], currentModel: null, defaultModel: null, warning: null })),
    getPiModels: vi.fn(async () => ({ models: [], currentModel: null, defaultModel: null, warning: null })),
    getSession: mocks.getSession,
    sendPrompt: mocks.sendPrompt,
    sendAttachMessage: mocks.sendAttachMessage,
    uploadFile: mocks.uploadFile,
    abortSession: mocks.abortSession,
    getSessionAgents: mocks.getSessionAgents,
    compactSession: mocks.compactSession,
    attachSession: mocks.attachSession,
    detachSession: mocks.detachSession,
  },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

vi.mock("../api/prompt", () => ({ sendPromptWithMode: mocks.sendPromptWithMode }));
vi.mock("../hooks/useGitStatus", () => ({ useGitStatus: () => null }));

let wsEvent: ((event: WsEvent) => void) | null = null;
vi.mock("../hooks/useSessionSocket", () => ({
  useSessionSocket: (opts: { onEvent: (event: WsEvent) => void }) => {
    wsEvent = opts.onEvent;
  },
}));

import { ChatPage } from "./ChatPage";

const baseSession: SessionSummary = {
  id: "s1",
  source: "pi",
  name: "历史会话",
  cwd: "/tmp/demo",
  updatedAt: "2026-02-18T11:00:00.000Z",
  // 有历史消息：空会话闸门（attachDefaultWorthy：无消息且不 running 默认永不接管）
  // 不适用于本文件的智能默认场景；新建空会话的不接管行为在 ChatPage.attachDefault.test.tsx 覆盖
  messageCount: 2,
  status: "idle",
  lastUserMessage: null,
  lastAssistantMessage: null,
  sessionFile: "/tmp/demo/s1.jsonl",
  isSubAgent: false,
};

const MODE_KEY = "agent-hub.attachMode.v1:s1";
const PINNED_KEY = "agent-hub.attachModePinned.v1:s1";

function fakeStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ChatPage sessionId="s1" />);
  });
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

const modeLabel = (el: HTMLElement) => el.querySelector(".attach-trigger")?.getAttribute("aria-label") ?? "";

async function sendAttach(el: HTMLElement, text: string): Promise<void> {
  typeInput(el, text);
  click(el.querySelector(".composer-send"));
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  wsEvent = null;
  localStorage.removeItem(MODE_KEY);
  localStorage.removeItem(PINNED_KEY);
  localStorage.removeItem(ATTACH_INTRO_KEY);
  getOfflineQueue(fakeStorage());
  mocks.sendPromptWithMode.mockReset();
  mocks.sendPromptWithMode.mockResolvedValue({ result: { accepted: true, mode: "prompt" }, busyFallback: false });
  mocks.getSession.mockReset();
  mocks.getSession.mockResolvedValue({ session: baseSession, messages: [], hasMore: false, nextBefore: null });
  mocks.sendPrompt.mockReset();
  mocks.sendAttachMessage.mockReset();
  mocks.sendAttachMessage.mockResolvedValue({ accepted: true, channel: "attach", commandId: "cmd-1", mode: "prompt" });
  mocks.uploadFile.mockReset();
  mocks.abortSession.mockReset();
  mocks.getSessionAgents.mockReset();
  mocks.getSessionAgents.mockResolvedValue({ agents: [] });
  mocks.compactSession.mockReset();
  mocks.compactSession.mockResolvedValue({ ok: true });
  mocks.attachSession.mockReset();
  mocks.attachSession.mockResolvedValue({ attached: true, agent: { sessionId: "s1", pid: 1, cwd: "/tmp/demo", online: true, capabilities: [], lastSeen: 1 } });
  mocks.detachSession.mockReset();
  mocks.detachSession.mockResolvedValue({ attached: false });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("attach 回执失败：消息绝不静默丢失", () => {
  it("command_ack ok=false → 原文退回离线队列 + 自动切回平行 + 给出「重试」出路", async () => {
    mocks.getSession.mockResolvedValue({
      session: { ...baseSession, terminal: { online: true, attached: true } },
      messages: [],
      hasMore: false,
      nextBefore: null,
    });
    const el = await render();
    expect(modeLabel(el)).toContain("接管终端");

    await sendAttach(el, "重要消息别丢");
    expect(mocks.sendAttachMessage).toHaveBeenCalledTimes(1);

    // 终端回执失败（指令被取消 / 终端已退出 / 执行失败）
    await act(async () => {
      wsEvent?.({ type: "command_ack", commandId: "cmd-1", ok: false, error: "已退出接管模式，指令取消" });
    });

    const queued = getOfflineQueue().list();
    expect(queued.some((q) => q.text === "重要消息别丢")).toBe(true);
    // 手动重试（不自动重发）：无法排除“终端其实执行了、只是回执丢了”，自动重发会重复执行
    expect(queued.find((q) => q.text === "重要消息别丢")?.autoRetry).toBe(false);
    expect(queued.find((q) => q.text === "重要消息别丢")?.channel).toBe("parallel");
    // 终端已证明不可靠 → 自动切回平行，别让用户再撞一次
    expect(modeLabel(el)).toContain("平行继续");
    // 提示必须给出路（常驻，不 6s 消失）
    expect(el.textContent).toContain("重试");
    expect(el.textContent).toContain("不用重打");
  });

  it("回执先于发送响应到达且失败 → 同样退队（时序边界不遗漏）", async () => {
    mocks.getSession.mockResolvedValue({
      session: { ...baseSession, terminal: { online: true, attached: true } },
      messages: [],
      hasMore: false,
      nextBefore: null,
    });
    // sendAttachMessage 挂起，先把失败回执喂进去（长轮询秒级投递的真实时序）
    let release: ((v: unknown) => void) | null = null;
    mocks.sendAttachMessage.mockReturnValue(new Promise((r) => { release = r; }));
    const el = await render();

    typeInput(el, "时序边界消息");
    act(() => {
      (el.querySelector(".composer-send") as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      wsEvent?.({ type: "command_ack", commandId: "cmd-9", ok: false, error: "终端未响应" });
    });
    await act(async () => {
      release?.({ accepted: true, channel: "attach", commandId: "cmd-9", mode: "prompt" });
      await Promise.resolve();
    });

    const queued = getOfflineQueue().list();
    expect(queued.some((q) => q.text === "时序边界消息")).toBe(true);
  });

  it("409 ATTACH_UNAVAILABLE（终端心跳在但扩展停止取指令）→ 自愈切平行 + 自动重试", async () => {
    mocks.getSession.mockResolvedValue({
      session: { ...baseSession, terminal: { online: true, attached: true, responsive: false } },
      messages: [],
      hasMore: false,
      nextBefore: null,
    });
    mocks.sendAttachMessage.mockRejectedValue(
      new ApiError(409, "ATTACH_UNAVAILABLE", "终端扩展已停止取指令（电脑终端可能刚关闭）：这条消息没有发出去。"),
    );
    const el = await render();
    await sendAttach(el, "别让我重打");

    // 自愈路径会立即 flush 补发（同 localId 幂等），所以消息要么在队列里、要么已补发出去；
    // 关键是它绝不可能静默消失
    const queued = getOfflineQueue().list();
    const hit = queued.find((q) => q.text === "别让我重打");
    if (hit) {
      // server 在入队前就拒了 = 消息明确未投递 → 自动重发安全
      expect(hit.autoRetry).toBe(true);
      expect(hit.channel).toBe("parallel");
    } else {
      expect(mocks.sendPromptWithMode).toHaveBeenCalled();
      const resent = mocks.sendPromptWithMode.mock.calls.find((c) => String(c[1]).includes("别让我重打"));
      expect(resent, "已出队则必须已走平行通道补发").toBeTruthy();
    }
    expect(modeLabel(el)).toContain("平行继续");
    expect(el.textContent).toContain("终端没有响应");
  });
});

describe("双模式说明 sheet：平行模式的主场景必须知情", () => {
  it("终端离线（terminal=null）也弹说明，且明示工具会在电脑上真实执行、无人批准", async () => {
    mocks.getSession.mockResolvedValue({
      session: { ...baseSession, terminal: null },
      messages: [],
      hasMore: false,
      nextBefore: null,
    });
    const el = await render();
    // 修复前：弹出条件绑 terminal?.online === true → 这个场景永远不弹
    expect(el.textContent).toContain("选择会话驱动模式");
    expect(el.textContent).toContain("无人工批准");
    expect(el.textContent).toContain("真实执行");
  });

  it("claude 源的平行说明按源给准确权限语义（默认档说明 + 配置指向，不锁死单一档位行为）", async () => {
    mocks.getSession.mockResolvedValue({
      session: { ...baseSession, source: "claude", terminal: null },
      messages: [],
      hasMore: false,
      nextBefore: null,
    });
    const el = await render();
    // 锁「默认档位说明 + 配置指向」：默认档位下自动执行、无人工批准，且明示档位可配置
    expect(el.textContent).toContain("无人工批准");
    expect(el.textContent).toContain("默认");
    expect(el.textContent).toContain("claudeDriver.permissionMode");
  });

  it("看过一次就不再弹（一次性说明，不常驻打扰）", async () => {
    localStorage.setItem(ATTACH_INTRO_KEY, "1");
    mocks.getSession.mockResolvedValue({
      session: { ...baseSession, terminal: null },
      messages: [],
      hasMore: false,
      nextBefore: null,
    });
    const el = await render();
    expect(el.textContent).not.toContain("选择会话驱动模式");
  });
});

describe("双写闸门拦截后的文本保留（不丢、可重试）", () => {
  it("409 EXTERNAL_ACTIVE → 文本保留为失败气泡（含重试入口）且入队", async () => {
    mocks.getSession.mockResolvedValue({
      session: { ...baseSession, terminal: null },
      messages: [],
      hasMore: false,
      nextBefore: null,
    });
    mocks.sendPromptWithMode.mockRejectedValue(
      new ApiError(409, "EXTERNAL_ACTIVE", "电脑上似乎仍在运行这个会话（会话文件刚被写入）。"),
    );
    const el = await render();
    typeInput(el, "被拦的文本");
    click(el.querySelector(".composer-send"));
    await act(async () => {
      await Promise.resolve();
    });
    // 文本不丢：失败气泡保留 + 重试入口可见
    expect(el.textContent).toContain("被拦的文本");
    expect(el.querySelectorAll(".send-failed").length).toBe(1);
    expect(Array.from(el.querySelectorAll("button")).some((b) => b.textContent.trim() === "重试")).toBe(true);
    // 且进了离线队列（持久化，刷新不丢）
    expect(getOfflineQueue().list().some((q) => q.text === "被拦的文本")).toBe(true);
    // 闸门是 4xx 业务拒绝 → 手动重试（不自动重发：重发也一样被拒）
    expect(getOfflineQueue().list().find((q) => q.text === "被拦的文本")?.autoRetry).toBe(false);
  });
});

describe("智能默认不得把死终端当成可接管", () => {
  it("terminal.online=true 但 responsive=false → 不自动接管（仍留在平行模式）", async () => {
    mocks.getSession.mockResolvedValue({
      session: { ...baseSession, terminal: { online: true, attached: false, responsive: false } },
      messages: [],
      hasMore: false,
      nextBefore: null,
    });
    const el = await render();
    // 修复前：只看 online → 自动 attach + 提示"终端在线，已默认接管终端" = 假接管
    expect(modeLabel(el)).toContain("平行继续");
    expect(el.textContent).not.toContain("已默认接管终端");
  });

  it("responsive 缺省（老 server 不下发）→ 按在线容错，保持历史行为", async () => {
    mocks.getSession.mockResolvedValue({
      session: { ...baseSession, terminal: { online: true, attached: false } },
      messages: [],
      hasMore: false,
      nextBefore: null,
    });
    const el = await render();
    expect(modeLabel(el)).toContain("接管终端");
  });
});
