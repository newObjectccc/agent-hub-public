/**
 * 应用锁前端纯逻辑（F1）：令牌持久化（localStorage，不存 PIN 明文）+ 密钥规则。
 */
import { describe, expect, it } from "vitest";
import {
  clearLockToken,
  friendlyLockError,
  isPinSecret,
  isTokenFresh,
  isValidSecret,
  loadLockToken,
  LOCK_TOKEN_KEY,
  parseAppLockStatus,
  parseLockTokenResult,
  safeSecretCheck,
  saveLockToken,
} from "./appLock";
import { ApiError } from "../api/client";

function fakeStorage(): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; removeItem: (k: string) => void; data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

describe("appLock 前端：密钥规则（与 server 同口径）", () => {
  it("PIN 4-6 位数字 / 口令 8-128 字符；其余非法", () => {
    expect(isValidSecret("1234")).toBe(true);
    expect(isValidSecret("123456")).toBe(true);
    expect(isValidSecret("123")).toBe(false);
    expect(isValidSecret("1234567")).toBe(false);
    expect(isValidSecret("passphrase-1")).toBe(true);
    expect(isValidSecret("short7c")).toBe(false);
    expect(safeSecretCheck("12")).toContain("4-6 位数字");
    expect(safeSecretCheck("1234")).toBeNull();
    expect(isPinSecret("1234")).toBe(true);
    expect(isPinSecret("12a4")).toBe(false);
  });
});

describe("appLock 前端：解锁令牌持久化", () => {
  it("save/load/clear 往返；只存令牌不存 PIN", () => {
    const storage = fakeStorage();
    saveLockToken(storage, { token: "tok-abc", expiresAt: 123 });
    const raw = storage.data.get(LOCK_TOKEN_KEY) ?? "";
    expect(raw).toContain("tok-abc");
    expect(raw).not.toContain("pin");
    expect(loadLockToken(storage)).toEqual({ token: "tok-abc", expiresAt: 123 });
    clearLockToken(storage);
    expect(loadLockToken(storage)).toBeNull();
  });

  it("损坏 JSON / 缺字段 → null；存储不可用不抛", () => {
    const storage = fakeStorage();
    storage.setItem(LOCK_TOKEN_KEY, "not json");
    expect(loadLockToken(storage)).toBeNull();
    storage.setItem(LOCK_TOKEN_KEY, JSON.stringify({ token: "" }));
    expect(loadLockToken(storage)).toBeNull();
    expect(loadLockToken(null)).toBeNull();
    expect(() => saveLockToken(null, { token: "t", expiresAt: 1 })).not.toThrow();
    expect(() => clearLockToken(null)).not.toThrow();
  });

  it("isTokenFresh：7 天内有效、过期/临期无效（30s 时钟偏差余量）", () => {
    const now = 1_000_000;
    expect(isTokenFresh({ token: "t", expiresAt: now + 60_000 }, now)).toBe(true);
    expect(isTokenFresh({ token: "t", expiresAt: now + 10_000 }, now)).toBe(false);
    expect(isTokenFresh({ token: "t", expiresAt: now - 1 }, now)).toBe(false);
    expect(isTokenFresh(null, now)).toBe(false);
  });
});

describe("appLock 错误映射与响应校验（UX 审查 AC3）", () => {
  it("friendlyLockError：ApiError 用服务端中文提示；JS 异常映射 fallback（不裸露）", () => {
    expect(friendlyLockError(new ApiError(401, "UNAUTHORIZED", "PIN 不正确"), "解锁失败，请重试")).toBe("PIN 不正确");
    const raw = new TypeError("Cannot read properties of null (reading 'configured')");
    const friendly = friendlyLockError(raw, "解锁失败，请重试");
    expect(friendly).toBe("解锁失败，请重试");
    expect(friendly).not.toContain("Cannot read");
    expect(friendlyLockError("字符串异常", "兜底")).toBe("兜底");
  });

  it("parseAppLockStatus：坏响应体（null/缺字段/错型）→ null（不误落 setup）", () => {
    expect(parseAppLockStatus(null)).toBeNull();
    expect(parseAppLockStatus({ error: { code: "X" } })).toBeNull();
    expect(parseAppLockStatus({ configured: "yes", unlocked: false })).toBeNull();
    expect(parseAppLockStatus("html body")).toBeNull();
    expect(
      parseAppLockStatus({ configured: true, webauthn: true, unlocked: false, expiresAt: null }),
    ).toEqual({ configured: true, webauthn: true, unlocked: false, expiresAt: null });
  });

  it("parseLockTokenResult：无令牌/坏令牌 → null（坏体不当解锁成功）", () => {
    expect(parseLockTokenResult({ ok: false })).toBeNull();
    expect(parseLockTokenResult({ token: "", expiresAt: 1 })).toBeNull();
    expect(parseLockTokenResult({ token: "t", expiresAt: Number.NaN })).toBeNull();
    expect(parseLockTokenResult(null)).toBeNull();
    expect(parseLockTokenResult({ token: "tok", expiresAt: 123 })).toEqual({ token: "tok", expiresAt: 123 });
  });
});
