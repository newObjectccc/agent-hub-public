/**
 * 侧边栏/抽屉「新建会话」?new=1 深链回归测试（bug：已在会话页时点击无效果）：
 * - 根因：route 只解析 pathname，会话页内导航不重挂载，createOpen 挂载初值不再重算
 * - 修复：SessionsPage 监听 popstate，URL 带 new=1 时同步弹出新建表单
 * - 附带：表单关闭时清掉 ?new=1（刷新/后退不再自动弹出）
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getDashboardStats: vi.fn(),
  getUsage: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: {
    getSessionModels: vi.fn(async () => ({ models: [], currentModel: null, defaultModel: null, warning: null })),
    getPiModels: vi.fn(async () => ({ models: [], currentModel: null, defaultModel: null, warning: null })),
    listSessions: mocks.listSessions,
    getDashboardStats: mocks.getDashboardStats,
    getUsage: mocks.getUsage,
    createSession: mocks.createSession,
  },
}));

// WS 全局事件在 jsdom 无 WebSocket：mock 为空操作（本用例只测 ?new=1 深链）
vi.mock("../hooks/useGlobalEvents", () => ({
  useGlobalEvents: () => undefined,
}));

import { SessionsPage } from "./SessionsPage";
import { navigate, newSessionPath } from "../utils/router";

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<SessionsPage />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

/** 新建会话表单（Sheet dialog）是否打开 */
function formOpen(el: HTMLElement): boolean {
  return el.querySelector('[role="dialog"][aria-label="新建会话"]') !== null;
}

beforeEach(() => {
  mocks.listSessions.mockReset().mockResolvedValue({ sessions: [] });
  mocks.getDashboardStats.mockReset().mockResolvedValue(null);
  mocks.getUsage.mockReset().mockResolvedValue({ windows: null, sessions: [] });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  window.history.replaceState({}, "", "/");
});

describe("侧边栏「新建会话」?new=1 深链", () => {
  it("深链直接进入 /sessions?new=1 → 表单打开", async () => {
    window.history.replaceState({}, "", "/sessions?new=1");
    const el = await render();
    expect(formOpen(el)).toBe(true);
  });

  it("已在会话页时点击侧边栏按钮（navigate ?new=1，组件不重挂载）→ 表单打开", async () => {
    window.history.replaceState({}, "", "/sessions");
    const el = await render();
    expect(formOpen(el)).toBe(false);

    // 模拟侧边栏按钮：go(newSessionPath()) → navigate → popstate
    await act(async () => {
      navigate(newSessionPath());
      await Promise.resolve();
    });
    expect(window.location.search).toBe("?new=1");
    expect(formOpen(el)).toBe(true);
  });

  it("会话页带 ?tab= 时点击按钮：tab 参数不丢且表单打开", async () => {
    window.history.replaceState({}, "", "/sessions?tab=working");
    const el = await render();
    expect(formOpen(el)).toBe(false);

    await act(async () => {
      navigate(newSessionPath());
      await Promise.resolve();
    });
    expect(window.location.search).toBe("?tab=working&new=1");
    expect(formOpen(el)).toBe(true);
  });

  it("表单打开后 URL 失去 ?new=1 不强制关闭（只开不关）", async () => {
    window.history.replaceState({}, "", "/sessions?new=1");
    const el = await render();
    expect(formOpen(el)).toBe(true);
    // 清参后路由变化（不带 new=1）：表单保持打开（手动打开的表单不被 URL 强制关闭）
    window.history.replaceState({}, "", "/sessions");
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
      await Promise.resolve();
    });
    expect(formOpen(el)).toBe(true);
  });

  it("关闭表单 → 清掉 ?new=1（刷新/后退不再自动弹出）", async () => {
    window.history.replaceState({}, "", "/sessions?new=1");
    const el = await render();
    expect(formOpen(el)).toBe(true);

    const close = el.querySelector(".sheet-close");
    await act(async () => {
      (close as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(formOpen(el)).toBe(false);
    expect(window.location.search).toBe("");
  });
});
