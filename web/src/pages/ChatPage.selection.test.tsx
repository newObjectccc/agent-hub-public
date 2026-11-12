/**
 * 选区锁集成回归（手机端"复制消息里的部分文字"修复的虚拟化配套）：
 * 消息列表内有活动选区时暂停窗口化（防虚拟裁剪把选区所在行卸载 → 选中的文字消失），
 * 选区消失后恢复窗口化。触发链路：.chat-messages 的 pointerup/pointerdown + document
 * selectionchange → scheduleWindowUpdate → recomputeWindow 里 hasActiveSelectionIn 判定。
 *
 * jsdom 无布局：桩 getBoundingClientRect/clientHeight 让行高可测、窗口化可激活（≥60 条），
 * 观察 .msg-window-pad（虚拟化顶部占位）的出现/消失。
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
    getWorkspace: vi.fn(async (cwd: string) => ({ cwd, projectName: cwd.split("/").pop(), root: null, repositoryRoot: null, isWorktree: false, branch: null, head: null, detached: false, kind: "directory", revision: "1".repeat(64) })),
    getSessionModels: vi.fn(async () => ({ models: [], currentModel: null, defaultModel: null, warning: null })),
    getPiModels: vi.fn(async () => ({ models: [], currentModel: null, defaultModel: null, warning: null })),
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

vi.mock("../hooks/useSessionSocket", () => ({
  useSessionSocket: (_opts: { onEvent: (event: WsEvent) => void }) => {
    // 集成测试不推 ws 事件
  },
}));

import { ChatPage } from "./ChatPage";

const session: SessionSummary = {
  id: "s1",
  source: "pi",
  name: "选区锁会话",
  cwd: "/tmp/demo",
  updatedAt: "2026-02-18T11:00:00.000Z",
  messageCount: 0,
  status: "idle",
  lastUserMessage: null,
  lastAssistantMessage: null,
  sessionFile: "/tmp/demo/s1.jsonl",
  isSubAgent: false,
};

const MESSAGE_COUNT = 60; // ≥ VIRTUAL_MIN_COUNT(60) 才启用窗口化

function makeMessages(): SessionMessage[] {
  const msgs: SessionMessage[] = [];
  for (let i = 0; i < MESSAGE_COUNT; i += 1) {
    msgs.push({
      id: `m${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      timestamp: 1_700_000_000_000 + i * 60_000,
      text: `消息 ${i} 内容`,
      thinking: null,
      toolCalls: [],
    });
  }
  return msgs;
}

let root: Root | null = null;
let container: HTMLElement | null = null;
let rectSpy: ReturnType<typeof vi.spyOn> | null = null;

/** 桩布局：行高 50；.chat-messages 视口 500（顶 0）；.msg-list 在内容 -2000 处（滚动 2000） */
function stubLayout(): void {
  rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const base = { x: 0, y: 0, width: 320, bottom: 0, left: 0, right: 320, toJSON: () => ({}) };
    if (this.classList.contains("msg-row")) return { ...base, top: 0, height: 50 };
    if (this.classList.contains("chat-messages")) return { ...base, top: 0, height: 500 };
    if (this.classList.contains("msg-list")) return { ...base, top: -2000, height: 3700 };
    return { ...base, top: 0, height: 0 };
  });
  // clientHeight（视口高）jsdom 恒 0 → 定义到实例拿不到；直接在原型 getter 上按类分流
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("chat-messages") ? 500 : 0;
    },
  });
}

function restoreLayout(): void {
  rectSpy?.mockRestore();
  rectSpy = null;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
}

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

/** rAF 一拍（recomputeWindow 经 scheduleWindowUpdate 走 rAF） */
async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

function setSelection(anchor: Node | null, text: string): void {
  vi.stubGlobal("getSelection", () => ({
    toString: () => text,
    isCollapsed: text === "",
    rangeCount: text === "" ? 0 : 1,
    anchorNode: anchor,
    focusNode: anchor,
    removeAllRanges: () => undefined,
    addRange: () => undefined,
  }));
}

beforeEach(() => {
  localStorage.clear();
  mocks.sendPromptWithMode.mockReset();
  mocks.sendPromptWithMode.mockResolvedValue({ result: { accepted: true, mode: "prompt" }, busyFallback: false });
  mocks.getSession.mockReset();
  mocks.getSession.mockResolvedValue({ session, messages: makeMessages(), hasMore: false, nextBefore: null });
  mocks.sendPrompt.mockReset();
  mocks.abortSession.mockReset();
  mocks.getSessionAgents.mockReset();
  mocks.getSessionAgents.mockResolvedValue({ agents: [] });
  mocks.forkSession.mockReset();
  mocks.forkSession.mockResolvedValue({ session: { ...session, id: "s1-fork" } });
  stubLayout();
  setSelection(null, ""); // 默认无选区
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  restoreLayout();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("选区锁：活动选区暂停窗口化，选区消失恢复", () => {
  it("窗口化激活（.msg-window-pad 出现）→ 列表内选区出现后消失 → 选区清除后恢复", async () => {
    const el = await render();
    await flushFrame();

    // 前置：桩布局下窗口化已激活（滚动 2000px，60 条 → 裁掉顶部）
    const pad = () => el.querySelector(".msg-window-pad");
    expect(pad(), "前置：窗口化应已激活").not.toBeNull();

    // 列表内形成活动选区（锚点在 .msg-list 子树）→ pointerup 触发重算 → 窗口化暂停
    const anchor = el.querySelector(".msg-list .bubble") ?? el.querySelector(".msg-list")!;
    setSelection(anchor, "选中的文字");
    act(() => {
      el.querySelector(".chat-messages")!.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });
    await flushFrame();
    expect(pad(), "活动选区期间窗口化应暂停（全量渲染保住选区行）").toBeNull();

    // 选区清除 → pointerdown/pointerup 轮询解锁 → 窗口化恢复
    setSelection(null, "");
    act(() => {
      el.querySelector(".chat-messages")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      el.querySelector(".chat-messages")!.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });
    await flushFrame();
    expect(pad(), "选区消失后窗口化应恢复").not.toBeNull();
  });

  it("selectionchange 事件同样触发选区锁开/关（链路注册与回调）", async () => {
    const el = await render();
    await flushFrame();
    expect(el.querySelector(".msg-window-pad")).not.toBeNull();

    const anchor = el.querySelector(".msg-list .bubble") ?? el.querySelector(".msg-list")!;
    setSelection(anchor, "拖手柄扩选的文字");
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    await flushFrame();
    expect(el.querySelector(".msg-window-pad"), "selectionchange 触发选区锁").toBeNull();

    setSelection(null, "");
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    await flushFrame();
    expect(el.querySelector(".msg-window-pad"), "selectionchange 触发解锁").not.toBeNull();
  });

  it("列表外点按清除选区后也能解锁（兜底监听挂 document 级，覆盖 Safari<17.4）", async () => {
    const el = await render();
    await flushFrame();
    const anchor = el.querySelector(".msg-list .bubble") ?? el.querySelector(".msg-list")!;
    setSelection(anchor, "选中的文字");
    act(() => {
      document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });
    await flushFrame();
    expect(el.querySelector(".msg-window-pad")).toBeNull();

    // 列表外（document 上）点按清除选区
    setSelection(null, "");
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    act(() => {
      outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      outside.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });
    await flushFrame();
    expect(el.querySelector(".msg-window-pad"), "document 级兜底解锁").not.toBeNull();
    outside.remove();
  });

  it("选区锚点在消息列表外（如输入框）不触发选区锁", async () => {
    const el = await render();
    await flushFrame();
    expect(el.querySelector(".msg-window-pad")).not.toBeNull();

    // 选区在文档别处（不在 .msg-list 内）
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    setSelection(outside, "输入框里的字");
    act(() => {
      el.querySelector(".chat-messages")!.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });
    await flushFrame();
    expect(el.querySelector(".msg-window-pad"), "列表外选区不锁窗口化").not.toBeNull();
    outside.remove();
  });
});
