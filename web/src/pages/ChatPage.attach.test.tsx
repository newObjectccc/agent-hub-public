/**
 * 双模式跨设备死锁自愈回归（P1）：
 * 1. loadSession 后用响应 terminal.attached 校正本地 attachMode（server 是事实源）——
 *    电脑已 attach 接管而手机 localStorage 无记录（平行模式）→ 发送不再被 409 ATTACH_ACTIVE 挡死
 * 2. 409 ATTACH_ACTIVE → 自动切 🖥 接管模式 + 提示 + 消息改走 attach 通道补发（同 localId 幂等），
 *    不入手动重试死信
 * 3. 409 ATTACH_REQUIRED（终端未接管）→ 自动切回 📱 平行模式 + 提示 + parallel 补发
 * 4. sendPrompt 幂等键：请求带 clientMessageId（= 乐观占位 localId），重发同键
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../api/types";
import type { WsEvent } from "../chat/messageStream";
import { getOfflineQueue, OFFLINE_QUEUE_KEY, type StorageLike } from "../chat/offlineQueue";

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
  listHostRequests: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: {
    getSession: mocks.getSession,
    sendPrompt: mocks.sendPrompt,
    sendAttachMessage: mocks.sendAttachMessage,
    uploadFile: mocks.uploadFile,
    abortSession: mocks.abortSession,
    getSessionAgents: mocks.getSessionAgents,
    listHostRequests: mocks.listHostRequests,
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

const baseSession: SessionSummary = {
  id: "s1",
  source: "pi",
  name: "双模式会话",
  cwd: "/tmp/demo",
  updatedAt: "2026-02-18T11:00:00.000Z",
  messageCount: 0,
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

/** 模式切换触发器（AttachModeMenu 纯图标 + aria-label） */
function modeLabel(el: HTMLElement): string {
  return el.querySelector(".attach-trigger")?.getAttribute("aria-label") ?? "";
}

beforeEach(() => {
  wsEvent = null;
  // 模式/pin 残留清零（用例间隔离：上一用例自愈写入的生效模式/手动 pin 不影响下一用例）
  localStorage.removeItem(MODE_KEY);
  localStorage.removeItem(PINNED_KEY);
  // 队列单例重置为空（用例间隔离）
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
  mocks.listHostRequests.mockReset();
  mocks.listHostRequests.mockResolvedValue({ requests: [] });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("loadSession 校正本地 attachMode（server 是事实源）", () => {
  it("server terminal.attached=true 而本地无记录 → 校正为 🖥 接管模式，发送走 attach 通道", async () => {
    mocks.getSession.mockResolvedValue({
      session: { ...baseSession, terminal: { online: true, attached: true } },
      messages: [],
      hasMore: false,
      nextBefore: null,
    });
    const el = await render();
    expect(modeLabel(el)).toContain("接管终端");

    typeInput(el, "你好");
    click(el.querySelector(".composer-send"));
    await act(async () => {
      await Promise.resolve();
    });
    // 不再走 parallel（409 ATTACH_ACTIVE 死锁根因），直接 attach 通道
    expect(mocks.sendPromptWithMode).not.toHaveBeenCalled();
    expect(mocks.sendAttachMessage).toHaveBeenCalledTimes(1);
    // attach 通道幂等键 = 乐观占位 localId
    const localId = String(mocks.sendAttachMessage.mock.calls[0][3]);
    expect(localId.startsWith("local-")).toBe(true);
  });

  it("server terminal.attached=false 而本地是接管残留 → 校正回 📱 平行模式", async () => {
    localStorage.setItem("agent-hub.attachMode.v1:s1", "attach");
    // online:false：终端离线不触发智能默认（在线自动接管见 ChatPage.attachDefault.test.tsx），单测校正语义
    mocks.getSession.mockResolvedValue({
      session: { ...baseSession, terminal: { online: false, attached: false } },
      messages: [],
      hasMore: false,
      nextBefore: null,
    });
    const el = await render();
    expect(modeLabel(el)).toContain("平行继续");

    typeInput(el, "你好");
    click(el.querySelector(".composer-send"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.sendAttachMessage).not.toHaveBeenCalled();
    expect(mocks.sendPromptWithMode).toHaveBeenCalledTimes(1);
    localStorage.removeItem("agent-hub.attachMode.v1:s1");
  });
});

describe("409 ATTACH_ACTIVE 死锁自愈（跨设备）", () => {
  it("parallel 发送被 409 挡 → 自动切 🖥 接管 + 提示 + 同键改走 attach 补发，队列不死信", async () => {
    // 跨设备现实：电脑已 attach（server terminal 真值 attached=true），手机用户 pin 过平行——
    // pin 压住 loadSession 的 attached 校正，首条消息才走 parallel 撞 409（自愈前提）。
    // terminal 真值在场也是 isAttachSending 修复后的回归语义：terminal 存在且 attached!==false → 走 attach
    //（terminal 缺失才不走 attach，防 claudeDriver.enabled=false / 老 server 400 卡死，见下方专门用例）
    localStorage.setItem(PINNED_KEY, "parallel");
    mocks.getSession.mockResolvedValue({
      session: { ...baseSession, terminal: { online: true, attached: true } },
      messages: [],
      hasMore: false,
      nextBefore: null,
    });
    mocks.sendPromptWithMode.mockRejectedValue(
      Object.assign(new Error("终端接管中：消息由电脑终端 pi 执行"), { code: "ATTACH_ACTIVE", status: 409 }),
    );
    const el = await render();
    typeInput(el, "弱网重发");
    click(el.querySelector(".composer-send"));
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // 自动切 🖥 接管模式（后续发送不再撞墙）
    expect(modeLabel(el)).toContain("接管终端");
    // 提示含出路
    expect(container!.textContent).toContain("终端接管中");
    // 消息改走 attach 通道补发，幂等键与原发送同键
    expect(mocks.sendAttachMessage).toHaveBeenCalledTimes(1);
    const retryKey = String(mocks.sendAttachMessage.mock.calls[0][3]);
    const originalKey = String(mocks.sendPromptWithMode.mock.calls[0][5]);
    expect(retryKey).toBe(originalKey);
    // 自愈成功出队：不入手动重试死信
    await act(async () => {
      await Promise.resolve();
    });
    expect(getOfflineQueue().pending("s1")).toHaveLength(0);
    // 后续发送走 attach 通道（不再触发 sendPromptWithMode）
    typeInput(el, "第二条");
    click(el.querySelector(".composer-send"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.sendPromptWithMode).toHaveBeenCalledTimes(1);
    expect(mocks.sendAttachMessage).toHaveBeenCalledTimes(2);
  });

  it("terminal 缺失（claudeDriver.enabled=false / 老 server）→ 首发走平行，409 自愈补发仍送达，不死信", async () => {
    // isAttachSending 修复后：terminal 缺失不走 attach 发送通道（防「claude 会话接管未启用」400 卡死）；
    // 若 server 端仍在接管（409 ATTACH_ACTIVE），自愈链路照常 attach 补发，消息不丢
    mocks.sendPromptWithMode.mockRejectedValue(
      Object.assign(new Error("终端接管中：消息由电脑终端 pi 执行"), { code: "ATTACH_ACTIVE", status: 409 }),
    );
    const el = await render(); // beforeEach 默认 getSession 无 terminal 字段
    typeInput(el, "terminal 缺失");
    click(el.querySelector(".composer-send"));
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // 首发走平行（不进 attach 通道吃 400），自愈后由 attach 补发送达
    expect(mocks.sendAttachMessage).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
    });
    expect(getOfflineQueue().pending("s1")).toHaveLength(0);
  });

  it("409 ATTACH_REQUIRED（终端未接管）→ 自动切回 📱 平行模式 + 提示 + parallel 补发", async () => {
    mocks.getSession.mockResolvedValue({
      session: { ...baseSession, terminal: { online: true, attached: true } },
      messages: [],
      hasMore: false,
      nextBefore: null,
    });
    mocks.sendAttachMessage.mockRejectedValue(
      Object.assign(new Error("该会话未处于接管模式"), { code: "ATTACH_REQUIRED", status: 409 }),
    );
    const el = await render();
    expect(modeLabel(el)).toContain("接管终端");

    typeInput(el, "终端退出了");
    click(el.querySelector(".composer-send"));
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(modeLabel(el)).toContain("平行继续");
    expect(container!.textContent).toContain("已自动切回");
    // 改走 parallel 补发（同键幂等）
    expect(mocks.sendPromptWithMode).toHaveBeenCalledTimes(1);
    const retryKey = String(mocks.sendPromptWithMode.mock.calls[0][5]);
    const originalKey = String(mocks.sendAttachMessage.mock.calls[0][3]);
    expect(retryKey).toBe(originalKey);
    await act(async () => {
      await Promise.resolve();
    });
    expect(getOfflineQueue().pending("s1")).toHaveLength(0);
  });
});

describe("sendPrompt 幂等键（重发同键）", () => {
  it("前台恢复的旧 GET 晚于 WS 完成返回，不抹掉新回复或恢复运行中", async () => {
    mocks.getSession.mockResolvedValue({ session: { ...baseSession, source: "codex", terminal: { online: true, attached: true, source: "codex", driver: "hub", defaultPolicy: "never" } }, messages: [], hasMore: false, nextBefore: null });
    const el = await render();
    let finish!: (value: unknown) => void;
    mocks.getSession.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => {
      wsEvent?.({ type: "message_end", message: { id: "native-user-new", role: "user", timestamp: 100, text: "新消息", toolCalls: [] } });
      wsEvent?.({ type: "message_end", message: { id: "native-answer-new", role: "assistant", timestamp: 101, text: "已经完成的新回复", toolCalls: [] } });
      wsEvent?.({ type: "status", status: "idle" });
      wsEvent?.({ type: "agent_settled" });
      finish({ session: { ...baseSession, status: "running" }, messages: [], hasMore: false, nextBefore: null });
      await Promise.resolve();
    });
    expect(el.textContent).toContain("已经完成的新回复");
    expect(el.querySelector('[aria-label="等待反馈：思考中"]')).toBeNull();
  });
  it("Codex HTTP202后晚到的失败回执保留原文和接管通道，重连不自动转发", async () => {
    mocks.getSession.mockResolvedValue({ session: { ...baseSession, source: "codex", terminal: { online: true, attached: true, source: "codex", driver: "hub", defaultPolicy: "never" } }, messages: [], hasMore: false, nextBefore: null });
    const el = await render();
    typeInput(el, "未确认的消息");
    click(el.querySelector(".composer-send"));
    await act(async () => { await Promise.resolve(); });
    expect(getOfflineQueue().pending("s1")[0]?.commandId).toBe("cmd-1");
    act(() => wsEvent?.({ type: "command_ack", commandId: "cmd-1", ok: false, error: "RPC超时，请先核对是否已被接收" }));
    expect(getOfflineQueue().pending("s1")[0]).toMatchObject({ text: "未确认的消息", source: "codex", channel: "attach", autoRetry: false });
    expect(mocks.sendPromptWithMode).not.toHaveBeenCalled();
  });
  it("Codex 接管失效时保留消息等待手动处理，不切换到 exec 自动补发", async () => {
    mocks.getSession.mockResolvedValue({ session: { ...baseSession, source: "codex", terminal: { online: true, attached: true, source: "codex", driver: "hub", defaultPolicy: "never" } }, messages: [], hasMore: false, nextBefore: null });
    mocks.sendAttachMessage.mockRejectedValue(Object.assign(new Error("Codex 写者正在释放"), { code: "ATTACH_REQUIRED", status: 409 }));
    const el = await render();
    typeInput(el, "保留这条消息");
    click(el.querySelector(".composer-send"));
    await act(async () => { await Promise.resolve(); });
    expect(mocks.sendPromptWithMode).not.toHaveBeenCalled();
    const pending = getOfflineQueue().pending("s1");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ text: "保留这条消息", source: "codex", channel: "attach", autoRetry: false });
  });
  it("正常发送请求带 clientMessageId（= 占位 id）", async () => {
    const el = await render();
    typeInput(el, "幂等键");
    click(el.querySelector(".composer-send"));
    await act(async () => {
      await Promise.resolve();
    });
    const call = mocks.sendPromptWithMode.mock.calls[0];
    const clientMessageId = String(call[5]);
    expect(clientMessageId.startsWith("local-")).toBe(true);
    // 与乐观占位消息 id 一致（DOM 行 id = msg-<消息 id>；重发复用同键）
    const rows = el.querySelectorAll<HTMLElement>(".msg-row.user");
    expect(rows[0].id).toBe(`msg-${clientMessageId}`);
    // OFFLINE_QUEUE_KEY 未被写入（成功路径不入队）
    expect(window.localStorage.getItem(OFFLINE_QUEUE_KEY)).toBeNull();
  });
});
