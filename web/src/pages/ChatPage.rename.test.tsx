/**
 * 会话改名链路集成（chat 顶栏 ⋯ 菜单 → RenameSessionSheet）：
 * - 菜单「重命名」打开弹层，当前名预填
 * - 保存 → api.renameSession(id, 新名) → 页头名字立即刷新（onRenamed → setSession）
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  sendPrompt: vi.fn(),
  abortSession: vi.fn(),
  getSessionAgents: vi.fn(),
  forkSession: vi.fn(),
  renameSession: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: {
    getSessionModels: vi.fn(async () => ({ models: [], currentModel: null, defaultModel: null, warning: null })),
    getPiModels: vi.fn(async () => ({ models: [], currentModel: null, defaultModel: null, warning: null })),
    getSession: mocks.getSession,
    sendPrompt: mocks.sendPrompt,
    abortSession: mocks.abortSession,
    getSessionAgents: mocks.getSessionAgents,
    forkSession: mocks.forkSession,
    renameSession: mocks.renameSession,
  },
}));

vi.mock("../api/prompt", () => ({
  sendPromptWithMode: mocks.sendPromptWithMode,
}));

vi.mock("../hooks/useGitStatus", () => ({
  useGitStatus: () => null,
}));

vi.mock("../hooks/useSessionSocket", () => ({
  useSessionSocket: (opts: { onEvent: (event: WsEvent) => void }) => {
    void opts;
  },
}));

import { ChatPage } from "./ChatPage";

const session: SessionSummary = {
  id: "s1",
  source: "pi",
  name: "旧名字",
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

function click(el: Element | null): void {
  act(() => {
    (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function type(el: Element | null, value: string): void {
  act(() => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  for (const m of Object.values(mocks)) m.mockReset();
});

describe("ChatPage 会话改名（⋯ 菜单 → 重命名）", () => {
  it("菜单「重命名」→ 弹层预填当前名；保存后页头立即显示新名", async () => {
    mocks.getSession.mockResolvedValue({ session, messages: [], hasMore: false });
    mocks.getSessionAgents.mockResolvedValue({ agents: [] });
    mocks.renameSession.mockImplementation(async (_id: string, name: string) => ({
      session: { ...session, name: name === "" ? null : name },
    }));

    const el = await render();
    expect(el.querySelector(".chat-title .name")!.textContent).toBe("旧名字");

    // ⋯ 菜单 → 「重命名」
    click(el.querySelector('button[aria-label="会话操作"]'));
    const renameItem = [...el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((i) =>
      i.textContent?.includes("重命名"),
    );
    expect(renameItem).toBeDefined();
    click(renameItem!);

    // 弹层预填当前名
    const input = el.querySelector<HTMLInputElement>('input[aria-label="会话名称"]');
    expect(input).not.toBeNull();
    expect(input!.value).toBe("旧名字");

    // 改名保存 → 调 API → 页头立即刷新
    type(input, "新名字");
    const save = [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "保存");
    await act(async () => {
      click(save!);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.renameSession).toHaveBeenCalledWith("s1", "新名字");
    expect(el.querySelector(".chat-title .name")!.textContent).toBe("新名字");
    // 弹层关闭
    expect(el.querySelector('input[aria-label="会话名称"]')).toBeNull();
  });
});
