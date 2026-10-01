/**
 * 应用锁状态机（F1）：
 * - 无有效令牌 → 按 server 状态显示 setup/locked；解锁成功令牌落 localStorage
 * - 本地令牌有效 → 直接 unlocked（后台复核）
 * - lockNow 清令牌回解锁屏；改密/关闭需旧 PIN（由 server 校验，这里验流程）
 * 每个用例 vi.resetModules() 取全新单例，互不污染。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCK_TOKEN_KEY } from "../utils/appLock";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  setup: vi.fn(),
  unlock: vi.fn(),
  change: vi.fn(),
  disable: vi.fn(),
  webauthnRegisterStart: vi.fn(),
  webauthnRegisterFinish: vi.fn(),
  webauthnLoginStart: vi.fn(),
  webauthnLoginFinish: vi.fn(),
}));

vi.mock("../api/appLock", () => ({
  appLockApi: { ...mocks },
}));

type HookState = {
  phase: string;
  busy: boolean;
  error: string | null;
  configured: boolean;
  unlock: (secret: string) => Promise<void>;
  setup: (secret: string) => Promise<void>;
  lockNow: () => void;
};

let root: Root | null = null;
let container: HTMLElement | null = null;
let latest: HookState | null = null;

async function mountHook(): Promise<void> {
  vi.resetModules();
  const { useAppLock } = await import("./useAppLock");
  function Probe() {
    latest = useAppLock() as unknown as HookState;
    return <div data-testid="phase">{latest.phase}</div>;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  latest = null;
  localStorage.clear();
  mocks.status.mockReset();
  mocks.setup.mockReset();
  mocks.unlock.mockReset();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("useAppLock 状态机", () => {
  it("未配置 → setup 相位；setup 成功令牌落 localStorage 并解锁", async () => {
    mocks.status.mockResolvedValue({ configured: false, webauthn: false, unlocked: false, expiresAt: null });
    mocks.setup.mockResolvedValue({ ok: true, token: "tok-1", expiresAt: Date.now() + 1000 });
    await mountHook();
    expect(latest!.phase).toBe("setup");
    await act(async () => {
      await latest!.setup("1234");
    });
    expect(latest!.phase).toBe("unlocked");
    expect(localStorage.getItem(LOCK_TOKEN_KEY)).toContain("tok-1");
  });

  it("已配置无令牌 → locked；解锁成功令牌持久化", async () => {
    mocks.status.mockResolvedValue({ configured: true, webauthn: true, unlocked: false, expiresAt: null });
    mocks.unlock.mockResolvedValue({ ok: true, token: "tok-2", expiresAt: Date.now() + 1000 });
    await mountHook();
    expect(latest!.phase).toBe("locked");
    await act(async () => {
      await latest!.unlock("1234");
    });
    expect(mocks.unlock).toHaveBeenCalledWith("1234");
    expect(latest!.phase).toBe("unlocked");
    expect(localStorage.getItem(LOCK_TOKEN_KEY)).toContain("tok-2");
  });

  it("本地令牌有效 → 直接 unlocked；lockNow 清令牌回 locked", async () => {
    localStorage.setItem(LOCK_TOKEN_KEY, JSON.stringify({ token: "tok-3", expiresAt: Date.now() + 3_600_000 }));
    mocks.status.mockResolvedValue({ configured: true, webauthn: false, unlocked: true, expiresAt: Date.now() + 3_600_000 });
    await mountHook();
    expect(latest!.phase, "有效令牌不打扰用户").toBe("unlocked");
    act(() => {
      latest!.lockNow();
    });
    expect(latest!.phase).toBe("locked");
    expect(localStorage.getItem(LOCK_TOKEN_KEY)).toBeNull();
  });

  it("令牌过期 → 清理并回解锁屏（server 状态已配置）", async () => {
    localStorage.setItem(LOCK_TOKEN_KEY, JSON.stringify({ token: "tok-old", expiresAt: Date.now() - 1000 }));
    mocks.status.mockResolvedValue({ configured: true, webauthn: false, unlocked: false, expiresAt: null });
    await mountHook();
    expect(latest!.phase).toBe("locked");
    expect(localStorage.getItem(LOCK_TOKEN_KEY)).toBeNull();
    expect(mocks.status).toHaveBeenCalledWith(null);
  });
});
