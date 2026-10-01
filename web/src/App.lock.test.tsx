/**
 * App 应用锁门控（F1，安全验收）：
 * - 未解锁：只挂解锁屏，**不拉任何会话数据**（sessions/dashboard/notifications 全部零调用）
 * - 解锁后：业务页面正常挂载
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getSession: vi.fn(),
  getSessionAgents: vi.fn(),
  getDashboardStats: vi.fn(),
  getNotifications: vi.fn(),
  markNotificationsRead: vi.fn(),
  getSystem: vi.fn(),
  sendPrompt: vi.fn(),
  abortSession: vi.fn(),
  forkSession: vi.fn(),
  uploadFile: vi.fn(),
  sendAttachMessage: vi.fn(),
  attachSession: vi.fn(),
  detachSession: vi.fn(),
  search: vi.fn(),
  getCommands: vi.fn(),
  getFsTree: vi.fn(),
  getSessionTree: vi.fn(),
  createSession: vi.fn(),
  compactSession: vi.fn(),
  getGitStatus: vi.fn(),
  getGitLog: vi.fn(),
  getGitDiff: vi.fn(),
  getGitBranches: vi.fn(),
  getFileContent: vi.fn(),
}));

const lockState = vi.hoisted(() => ({
  current: {
    phase: "locked" as string,
    busy: false,
    error: null as string | null,
    webauthnAvailable: false,
    configured: true,
    hasWebAuthnCredential: false,
    setup: () => Promise.resolve(),
    unlock: () => Promise.resolve(),
    change: () => Promise.resolve(true),
    disable: () => Promise.resolve(true),
    biometricUnlock: () => Promise.resolve(),
    registerBiometric: () => Promise.resolve(true),
    lockNow: () => undefined,
    retry: () => Promise.resolve(),
    clearError: () => undefined,
  },
}));

vi.mock("./hooks/useAppLock", () => ({
  useAppLock: () => lockState.current,
}));

vi.mock("./api/client", () => ({
  api: { ...apiMocks },
  ApiError: class ApiError extends Error {
    code: string;
    status: number;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  request: vi.fn(),
}));

import { App } from "./App";

let root: Root | null = null;
let container: HTMLElement | null = null;

async function renderApp(pathname: string): Promise<HTMLElement> {
  window.history.pushState({}, "", pathname);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<App />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

beforeEach(() => {
  for (const fn of Object.values(apiMocks)) fn.mockReset();
  lockState.current.phase = "locked";
  localStorage.clear();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("App 应用锁门控", () => {
  it("锁定态：只挂解锁屏，零会话数据请求（锁屏不泄漏会话内容）", async () => {
    const el = await renderApp("/");
    expect(el.querySelector(".lock-screen")).not.toBeNull();
    expect(el.textContent).toContain("应用锁");
    // 核心安全断言：解锁屏不发起任何会话/看板/通知数据请求
    expect(apiMocks.listSessions).not.toHaveBeenCalled();
    expect(apiMocks.getSession).not.toHaveBeenCalled();
    expect(apiMocks.getSessionAgents).not.toHaveBeenCalled();
    expect(apiMocks.getDashboardStats).not.toHaveBeenCalled();
    expect(apiMocks.getNotifications).not.toHaveBeenCalled();
  });

  it("未配置（setup 态）：显示设置屏；解锁后业务页面正常挂载", async () => {
    lockState.current.phase = "setup";
    const setupEl = await renderApp("/");
    expect(setupEl.querySelector(".lock-screen")).not.toBeNull();
    expect(setupEl.textContent).toContain("设置应用锁");
    act(() => {
      root?.unmount();
    });

    lockState.current.phase = "unlocked";
    const el = await renderApp("/settings");
    expect(el.querySelector(".lock-screen")).toBeNull();
    expect(el.querySelector(".settings-panel-page")).not.toBeNull();
    expect(el.textContent).toContain("应用锁");
  });

  it("解锁失败（error 停在 locked 相位）：仍是解锁屏，绝不回落「设置应用锁」首屏", async () => {
    lockState.current.phase = "locked";
    lockState.current.error = "PIN 不正确";
    const el = await renderApp("/");
    expect(el.querySelector(".lock-screen")).not.toBeNull();
    expect(el.textContent).toContain("🔒 应用锁");
    expect(el.textContent).not.toContain("设置应用锁");
    expect(el.querySelector(".lock-error")!.textContent).toContain("PIN 不正确");
    lockState.current.error = null;
  });

  it("错误条「重试」可用（调用锁状态机 retry，不裸露死胡同）", async () => {
    const retry = vi.fn(() => Promise.resolve());
    lockState.current.phase = "locked";
    lockState.current.error = "无法连接服务端，暂时无法解锁";
    lockState.current.retry = retry;
    const el = await renderApp("/");
    const btn = el.querySelector<HTMLButtonElement>(".lock-retry");
    expect(btn).not.toBeNull();
    act(() => {
      btn!.click();
    });
    expect(retry).toHaveBeenCalledTimes(1);
    lockState.current.error = null;
    lockState.current.retry = () => Promise.resolve();
  });
});
