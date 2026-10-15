/**
 * 打开会话时的智能默认（用户需求：电脑终端里活跃的会话默认"接管终端"，少点一步）：
 * 1. terminal.online=true 且用户未手动选过模式（无 pinned 记录）→ 自动 🖥 接管终端（attach 握手 + 轻提示）
 * 2. 离线（online=false）→ 保持/默认 📱 平行继续，不做接管
 * 3. claude / codex（无 terminal 字段）→ 不接管
 * 4. 用户手动选择永远最高优先：选过一次（pin）重进不被自动改回（含 server attached=true 也不改）
 * 5. 终端在线但用户选过平行 → 尊重平行
 * 6. 自动接管不写 pin：每次打开都重新判定（在线接管/离线回落）
 * 7. defaultPolicy（server 随 terminal 下发，D3）：never=永不自动接管；always=历史空闲也接管（仍须当下可行）
 * 8. 残留 attach 卡死自愈：pin=attach 但接管不可用（claude 无 terminal / pi 离线）→ 本次回落平行，不改写 pin
 * mock 模式参照 ChatPage.attach.test.tsx（额外 mock attachSession/detachSession 握手）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../api/types";
import type { WsEvent } from "../chat/messageStream";
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
  attachSession: vi.fn(),
  detachSession: vi.fn(),
  listHostRequests: vi.fn(),
  respondHostRequest: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: {
    getSession: mocks.getSession,
    sendPrompt: mocks.sendPrompt,
    sendAttachMessage: mocks.sendAttachMessage,
    uploadFile: mocks.uploadFile,
    abortSession: mocks.abortSession,
    getSessionAgents: mocks.getSessionAgents,
    attachSession: mocks.attachSession,
    detachSession: mocks.detachSession,
    listHostRequests: mocks.listHostRequests,
    respondHostRequest: mocks.respondHostRequest,
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
  name: "智能默认会话",
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

/** 会话详情 mock（terminal 缺省 = codex 等无终端状态的会话） */
function mockDetail(
  terminal?: {
    online: boolean;
    attached: boolean;
    driver?: "queue" | "hub";
    mirror?: boolean;
    /** 智能默认策略（server 随 terminal 下发；缺省 = 老 server active-only） */
    defaultPolicy?: "active-only" | "always" | "never";
  },
  source = "pi",
  extra?: Partial<SessionSummary>,
): void {
  mocks.listHostRequests.mockResolvedValue({ requests: [] });
  mocks.getSession.mockResolvedValue({
    session: { ...baseSession, source, ...(terminal ? { terminal } : {}), ...(extra ?? {}) },
    messages: [],
    hasMore: false,
    nextBefore: null,
  });
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

/** 打开模式菜单并点选（"平行继续" / "接管终端"） */
async function pickMode(el: HTMLElement, label: "平行继续" | "接管终端"): Promise<void> {
  click(el.querySelector(".attach-trigger"));
  const item = Array.from(el.querySelectorAll(".attach-menu-item")).find((b) =>
    b.textContent?.includes(label),
  );
  click(item ?? null);
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  wsEvent = null;
  window.localStorage.clear();
  // 首次说明 sheet 全局已读：本文件只测模式默认，不弹 sheet
  window.localStorage.setItem("agent-hub.attachIntro.v1", "1");
  // 队列单例重置为空（用例间隔离）
  getOfflineQueue(fakeStorage());
  mocks.sendPromptWithMode.mockReset();
  mocks.sendPromptWithMode.mockResolvedValue({ result: { accepted: true, mode: "prompt" }, busyFallback: false });
  mocks.getSession.mockReset();
  mockDetail();
  mocks.sendPrompt.mockReset();
  mocks.sendAttachMessage.mockReset();
  mocks.sendAttachMessage.mockResolvedValue({ accepted: true, channel: "attach", commandId: "cmd-1", mode: "prompt" });
  mocks.uploadFile.mockReset();
  mocks.abortSession.mockReset();
  mocks.getSessionAgents.mockReset();
  mocks.getSessionAgents.mockResolvedValue({ agents: [] });
  mocks.attachSession.mockReset();
  mocks.attachSession.mockResolvedValue({
    attached: true,
    agent: { sessionId: "s1", pid: 1, cwd: "/tmp/demo", online: true },
  });
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

describe("打开会话智能默认：终端在线自动接管", () => {
  it("online=true 且无用户选择记录 → 自动 🖥 接管（握手+轻提示），发送走 attach 通道，不写 pin", async () => {
    mockDetail({ online: true, attached: false });
    const el = await render();
    await act(async () => {
      await Promise.resolve();
    });

    // 与 server 握手真正接管（不是只切本地模式）
    expect(mocks.attachSession).toHaveBeenCalledTimes(1);
    expect(modeLabel(el)).toContain("接管终端");
    // 轻提示（自动切换才提示）
    expect(container!.textContent).toContain("终端在线，已默认接管终端");
    // 自动默认不记 pin（下次打开仍按当时终端状态重新判定）
    expect(window.localStorage.getItem(PINNED_KEY)).toBeNull();
    expect(window.localStorage.getItem(MODE_KEY)).toBe("attach");

    typeInput(el, "你好");
    click(el.querySelector(".composer-send"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.sendPromptWithMode).not.toHaveBeenCalled();
    expect(mocks.sendAttachMessage).toHaveBeenCalledTimes(1);
  });

  it("online=false（终端离线）→ 不接管，保持 📱 平行继续且无提示", async () => {
    mockDetail({ online: false, attached: false });
    const el = await render();
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.attachSession).not.toHaveBeenCalled();
    expect(modeLabel(el)).toContain("平行继续");
    expect(container!.textContent).not.toContain("已默认接管");

    typeInput(el, "你好");
    click(el.querySelector(".composer-send"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.sendPromptWithMode).toHaveBeenCalledTimes(1);
    expect(mocks.sendAttachMessage).not.toHaveBeenCalled();
  });

  it.each(["claude", "codex"])("source=%s（无 terminal 字段）→ 不接管，保持 📱 平行继续", async (source) => {
    mockDetail(undefined, source);
    const el = await render();
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.attachSession).not.toHaveBeenCalled();
    expect(modeLabel(el)).toContain("平行继续");
    expect(container!.textContent).not.toContain("已默认接管");
    expect(window.localStorage.getItem(PINNED_KEY)).toBeNull();
  });
});

describe("用户手动选择最高优先（pin）", () => {
  it("自动接管后手动切平行 → 重进不被改回（server attached=true 也不改），pin=parallel", async () => {
    mockDetail({ online: true, attached: false });
    let el = await render();
    await act(async () => {
      await Promise.resolve();
    });
    expect(modeLabel(el)).toContain("接管终端");

    // 用户手动切 📱 平行继续（detach 握手 + 记 pin）
    await pickMode(el, "平行继续");
    expect(mocks.detachSession).toHaveBeenCalledTimes(1);
    expect(modeLabel(el)).toContain("平行继续");
    expect(window.localStorage.getItem(PINNED_KEY)).toBe("parallel");

    // 重进（server 又 attached=true 也不被自动改回，不重复握手）
    act(() => {
      root!.unmount();
    });
    mockDetail({ online: true, attached: true });
    el = await render();
    await act(async () => {
      await Promise.resolve();
    });
    expect(modeLabel(el)).toContain("平行继续");
    expect(mocks.attachSession).toHaveBeenCalledTimes(1);
    expect(container!.textContent).not.toContain("已默认接管");
  });

  it("终端在线但用户选过平行 → 首开即尊重平行，不做接管", async () => {
    window.localStorage.setItem(PINNED_KEY, "parallel");
    window.localStorage.setItem(MODE_KEY, "parallel");
    mockDetail({ online: true, attached: true });
    const el = await render();
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.attachSession).not.toHaveBeenCalled();
    expect(modeLabel(el)).toContain("平行继续");
    expect(container!.textContent).not.toContain("已默认接管");

    typeInput(el, "尊重我的选择");
    click(el.querySelector(".composer-send"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.sendPromptWithMode).toHaveBeenCalledTimes(1);
    expect(mocks.sendAttachMessage).not.toHaveBeenCalled();
  });

  it("用户选过接管（pin=attach）→ 重进恢复接管：终端在线未接管时补握手，无自动提示", async () => {
    window.localStorage.setItem(PINNED_KEY, "attach");
    mockDetail({ online: true, attached: false });
    const el = await render();
    await act(async () => {
      await Promise.resolve();
    });

    // 恢复用户选择 = 真正接管（握手），但不是"自动默认"，不给默认提示
    expect(mocks.attachSession).toHaveBeenCalledTimes(1);
    expect(modeLabel(el)).toContain("接管终端");
    expect(container!.textContent).not.toContain("已默认接管");
  });
});

describe("自动默认只在打开时判定一次（不写 pin，逐次重估）", () => {
  it("首开在线自动接管；再开时离线 → 回落 📱 平行继续", async () => {
    mockDetail({ online: true, attached: false });
    let el = await render();
    await act(async () => {
      await Promise.resolve();
    });
    expect(modeLabel(el)).toContain("接管终端");

    act(() => {
      root!.unmount();
    });
    mockDetail({ online: false, attached: false });
    el = await render();
    await act(async () => {
      await Promise.resolve();
    });
    expect(modeLabel(el)).toContain("平行继续");
    expect(mocks.attachSession).toHaveBeenCalledTimes(1);
    expect(mocks.detachSession).not.toHaveBeenCalled();
  });

  it("server 已接管（attached=true）而本地无记录 → 校正为 🖥 接管 + 轻提示，不重复握手", async () => {
    mockDetail({ online: true, attached: true });
    const el = await render();
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.attachSession).not.toHaveBeenCalled();
    expect(modeLabel(el)).toContain("接管终端");
    expect(container!.textContent).toContain("终端在线，已默认接管终端");
    expect(window.localStorage.getItem(PINNED_KEY)).toBeNull();
  });
});

describe("claude hub 驱动接管默认策略（D3 active-only）", () => {
  it("claude 活跃（status=running + driver=hub）→ 自动默认接管 + 轻提示，不写 pin", async () => {
    mockDetail({ online: true, attached: false, driver: "hub" }, "claude", { status: "running" });
    const el = await render();
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.attachSession).toHaveBeenCalledTimes(1);
    expect(modeLabel(el)).toContain("接管终端");
    expect(container!.textContent).toContain("已默认接管");
    expect(window.localStorage.getItem(PINNED_KEY)).toBeNull();
  });

  it("claude 历史空闲（status=idle）→ 不自动接管，保持 📱 平行继续", async () => {
    mockDetail({ online: true, attached: false, driver: "hub" }, "claude", { status: "idle" });
    const el = await render();
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.attachSession).not.toHaveBeenCalled();
    expect(modeLabel(el)).toContain("平行继续");
    expect(window.localStorage.getItem(PINNED_KEY)).toBeNull();
  });

  it("claude 最后由终端驱动（lastDrivenBy=terminal）→ 自动接管", async () => {
    mockDetail({ online: true, attached: false, driver: "hub" }, "claude", {
      status: "idle",
      lastDrivenBy: "terminal",
    });
    const el = await render();
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.attachSession).toHaveBeenCalledTimes(1);
    expect(modeLabel(el)).toContain("接管终端");
  });

  it("claude 活跃但用户 pin=parallel → 尊重手动选择，不接管", async () => {
    window.localStorage.setItem(PINNED_KEY, "parallel");
    mockDetail({ online: true, attached: false, driver: "hub" }, "claude", { status: "running" });
    const el = await render();
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.attachSession).not.toHaveBeenCalled();
    expect(modeLabel(el)).toContain("平行继续");
  });

  it("claude 已接管（attached=true）→ 校正为 🖥 接管，不重复握手", async () => {
    mockDetail({ online: true, attached: true, driver: "hub" }, "claude", { status: "running" });
    const el = await render();
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.attachSession).not.toHaveBeenCalled();
    expect(modeLabel(el)).toContain("接管终端");
    expect(window.localStorage.getItem(PINNED_KEY)).toBeNull();
  });
});

describe("defaultPolicy 策略消费（D3，随 terminal 下发）", () => {
  it("defaultPolicy 缺省（老 server）→ active-only 行为不变：活跃接管、历史空闲不接管", async () => {
    // 活跃 → 接管（回归）
    mockDetail({ online: true, attached: false, driver: "hub" }, "claude", { status: "running" });
    let el = await render();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.attachSession).toHaveBeenCalledTimes(1);
    expect(modeLabel(el)).toContain("接管终端");

    // 历史空闲 → 不接管（回归）
    act(() => {
      root!.unmount();
    });
    mockDetail({ online: true, attached: false, driver: "hub" }, "claude", { status: "idle" });
    el = await render();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.attachSession).toHaveBeenCalledTimes(1); // 仍是首开那次，不新增
    expect(modeLabel(el)).toContain("平行继续");
    expect(window.localStorage.getItem(PINNED_KEY)).toBeNull();
  });

  it("never → 活跃会话也不自动接管，保持 📱 平行继续（只手动）", async () => {
    mockDetail({ online: true, attached: false, driver: "hub", defaultPolicy: "never" }, "claude", {
      status: "running",
    });
    const el = await render();
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.attachSession).not.toHaveBeenCalled();
    expect(modeLabel(el)).toContain("平行继续");
    expect(container!.textContent).not.toContain("已默认接管");
    expect(window.localStorage.getItem(PINNED_KEY)).toBeNull();

    typeInput(el, "你好");
    click(el.querySelector(".composer-send"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.sendPromptWithMode).toHaveBeenCalledTimes(1);
    expect(mocks.sendAttachMessage).not.toHaveBeenCalled();
  });

  it("always → 历史空闲 claude 会话也自动接管（与 active-only 的区别）", async () => {
    mockDetail({ online: true, attached: false, driver: "hub", defaultPolicy: "always" }, "claude", {
      status: "idle",
      lastDrivenBy: "panel",
    });
    const el = await render();
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.attachSession).toHaveBeenCalledTimes(1);
    expect(modeLabel(el)).toContain("接管终端");
    expect(container!.textContent).toContain("已默认接管");
    expect(window.localStorage.getItem(PINNED_KEY)).toBeNull();
  });

  it("always 但接管当下不可行（pi 终端离线）→ 仍不接管", async () => {
    mockDetail({ online: false, attached: false, defaultPolicy: "always" });
    const el = await render();
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.attachSession).not.toHaveBeenCalled();
    expect(modeLabel(el)).toContain("平行继续");
    expect(window.localStorage.getItem(PINNED_KEY)).toBeNull();
  });
});

describe("残留 attach 模式卡死自愈（claudeDriver.enabled=false / 老 server）", () => {
  it("pin=attach 但 claude 无 terminal（attachAvailability false）→ 本次回落平行，pin 仍为 attach，发送走 parallel", async () => {
    // 复现：曾手动 pin 过 attach，server 随后 claudeDriver.enabled=false（terminal 不下发）或旧 server
    // 修复前：pinned 分支直接 applyAttachMode("attach") 不查 attachAvailability → 发送走 attach 通道
    // → server 400「claude 会话接管未启用」，detach 也 400，用户卡死当场无法切换
    window.localStorage.setItem(PINNED_KEY, "attach");
    window.localStorage.setItem(MODE_KEY, "attach"); // 残留生效模式也是 attach
    mockDetail(undefined, "claude"); // claude 会话无 terminal 字段
    const el = await render();
    await act(async () => {
      await Promise.resolve();
    });

    // 本次打开优雅回落：不握手、模式为平行（发送不会走 attach 通道吃 400）
    expect(mocks.attachSession).not.toHaveBeenCalled();
    expect(modeLabel(el)).toContain("平行继续");
    // 不改写 pin：用户手动选择永久优先，attach 仍可手动再选
    expect(window.localStorage.getItem(PINNED_KEY)).toBe("attach");
    expect(window.localStorage.getItem(MODE_KEY)).toBe("parallel");

    typeInput(el, "卡死自愈");
    click(el.querySelector(".composer-send"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.sendPromptWithMode).toHaveBeenCalledTimes(1);
    expect(mocks.sendAttachMessage).not.toHaveBeenCalled();
  });

  it("pin=attach 但 pi 终端离线（attachAvailability false）→ 本次回落平行，pin 仍为 attach", async () => {
    window.localStorage.setItem(PINNED_KEY, "attach");
    mockDetail({ online: false, attached: false });
    const el = await render();
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.attachSession).not.toHaveBeenCalled();
    expect(modeLabel(el)).toContain("平行继续");
    expect(window.localStorage.getItem(PINNED_KEY)).toBe("attach");
    expect(window.localStorage.getItem(MODE_KEY)).toBe("parallel");
  });

  it("pin=attach 且接管可用（terminal 在线）→ 仍按 pin 恢复接管（自愈只在不可用时回落）", async () => {
    window.localStorage.setItem(PINNED_KEY, "attach");
    mockDetail({ online: true, attached: false });
    const el = await render();
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.attachSession).toHaveBeenCalledTimes(1);
    expect(modeLabel(el)).toContain("接管终端");
    expect(window.localStorage.getItem(PINNED_KEY)).toBe("attach");
  });
});
