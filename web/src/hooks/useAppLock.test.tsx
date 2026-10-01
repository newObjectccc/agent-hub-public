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
import { ApiError } from "../api/client";

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
  retry: () => Promise<void>;
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

describe("useAppLock 错误路径（UX 审查 AC3：严格停在 locked，错误不裸露）", () => {
  it("解锁失败（PIN 错）严格停在 locked 相位，可原地重试成功", async () => {
    mocks.status.mockResolvedValue({ configured: true, webauthn: false, unlocked: false, expiresAt: null });
    mocks.unlock
      .mockRejectedValueOnce(new ApiError(401, "UNAUTHORIZED", "PIN 不正确"))
      .mockResolvedValueOnce({ ok: true, token: "tok-retry", expiresAt: Date.now() + 1000 });
    await mountHook();
    expect(latest!.phase).toBe("locked");
    await act(async () => {
      await latest!.unlock("0000");
    });
    // 严格停在 locked（实测 bug：错误后回落 setup 首屏）；错误为服务端友好提示
    expect(latest!.phase).toBe("locked");
    expect(latest!.error).toBe("PIN 不正确");
    expect(localStorage.getItem(LOCK_TOKEN_KEY)).toBeNull();
    // 重试成功 → unlocked
    await act(async () => {
      await latest!.unlock("1234");
    });
    expect(latest!.phase).toBe("unlocked");
    expect(localStorage.getItem(LOCK_TOKEN_KEY)).toContain("tok-retry");
  });

  it("服务端返回坏令牌体（ok:false 无 token）→ 视为失败停在 locked（不当解锁成功）", async () => {
    mocks.status.mockResolvedValue({ configured: true, webauthn: false, unlocked: false, expiresAt: null });
    mocks.unlock.mockResolvedValue({ ok: false });
    await mountHook();
    await act(async () => {
      await latest!.unlock("1234");
    });
    expect(latest!.phase).toBe("locked");
    expect(latest!.error).toBe("解锁失败，请重试");
  });

  it("status 坏响应体（null/缺字段）→ 停在 locked，绝不误落 setup", async () => {
    mocks.status.mockResolvedValueOnce(null);
    await mountHook();
    expect(latest!.phase).toBe("locked");
    expect(latest!.configured).toBe(true);
    expect(latest!.error).toBe("无法连接服务端，暂时无法解锁");
  });

  it("原始 JS 异常（Cannot read properties…）不裸露：错误文案为友好 fallback", async () => {
    mocks.status.mockResolvedValue({ configured: true, webauthn: false, unlocked: false, expiresAt: null });
    mocks.unlock.mockRejectedValue(new TypeError("Cannot read properties of null (reading 'configured')"));
    await mountHook();
    await act(async () => {
      await latest!.unlock("1234");
    });
    expect(latest!.phase).toBe("locked");
    expect(latest!.error).toBe("解锁失败，请重试");
    expect(latest!.error).not.toContain("Cannot read");
  });

  it("生物识别失败同样停在 locked（回落 PIN），错误可重试", async () => {
    mocks.status.mockResolvedValue({ configured: true, webauthn: true, unlocked: false, expiresAt: null });
    mocks.webauthnLoginStart.mockRejectedValue(new Error("not allowed"));
    await mountHook();
    await act(async () => {
      await (latest as unknown as { biometricUnlock: () => Promise<void> }).biometricUnlock();
    });
    expect(latest!.phase).toBe("locked");
    expect(latest!.error).toBe("生物识别失败，请改用 PIN");
  });

  it("retry：状态获取失败后重试成功 → 按 server 状态显示且错误清除", async () => {
    mocks.status.mockRejectedValueOnce(new ApiError(503, "UNAVAILABLE", "服务暂不可用"));
    await mountHook();
    expect(latest!.phase).toBe("locked");
    expect(latest!.error).toBe("服务暂不可用");
    mocks.status.mockResolvedValue({ configured: true, webauthn: false, unlocked: false, expiresAt: null });
    await act(async () => {
      await latest!.retry();
    });
    expect(latest!.phase).toBe("locked");
    expect(latest!.error).toBeNull();
    expect(latest!.busy).toBe(false);
  });
});
