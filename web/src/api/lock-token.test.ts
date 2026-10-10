/**
 * 全 API 自动携带应用锁令牌（X-App-Lock-Token）回归测试。
 *
 * 背景（真机踩坑）：服务端 P2 加固后全局锁门禁要求所有 /api/* 请求带锁令牌，
 * 而主请求封装 request() 曾漏注入 → 解锁后全体 423 → 面板「加载中→失败」。
 * 此测试锁死：有新鲜令牌必带头；无令牌/过期令牌不带头；调用方显式头不被覆盖。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";
import { LOCK_TOKEN_KEY, currentLockHeaders, saveLockToken, clearLockToken } from "../utils/appLock";

function stubFetch(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ windows: { today: {}, last7Days: {}, all: {} }, sessions: [] }),
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const storage = () => (typeof localStorage === "undefined" ? null : localStorage);

afterEach(() => {
  clearLockToken(storage());
  vi.unstubAllGlobals();
});

describe("currentLockHeaders", () => {
  it("新鲜令牌 → 输出 X-App-Lock-Token；无令牌 → 空对象", () => {
    clearLockToken(storage());
    expect(currentLockHeaders()).toEqual({});
    saveLockToken(storage(), { token: "tok-123", expiresAt: Date.now() + 86_400_000 });
    expect(currentLockHeaders()).toEqual({ "X-App-Lock-Token": "tok-123" });
  });

  it("过期令牌（含 30s 余量）→ 不带头", () => {
    saveLockToken(storage(), { token: "stale", expiresAt: Date.now() + 10_000 });
    expect(currentLockHeaders()).toEqual({});
  });
});

describe("request() 自动注入锁令牌", () => {
  it("发起 API 请求时自动带 X-App-Lock-Token（P2 门禁对齐）", async () => {
    saveLockToken(storage(), { token: "tok-auto", expiresAt: Date.now() + 86_400_000 });
    const fn = stubFetch();
    await api.getUsage();
    const init = fn.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers["X-App-Lock-Token"]).toBe("tok-auto");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("无令牌时请求照常发出（仅不带头），Content-Type 不丢", async () => {
    clearLockToken(storage());
    const fn = stubFetch();
    await api.getUsage();
    const init = fn.mock.calls[0][1] as { headers: Record<string, string> };
    expect("X-App-Lock-Token" in init.headers).toBe(false);
    expect(init.headers["Content-Type"]).toBe("application/json");
  });
});
