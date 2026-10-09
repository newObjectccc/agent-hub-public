/**
 * 测试用 AppLockStoreLike fake：恒为"未配置"（全局锁屏门禁放行），
 * 让各路由测试不依赖 repo data/app-lock.json 的真实状态（可复现、无副作用）。
 */
import type { AppLockStoreLike, IssuedLockToken } from "../appLock.js";

const never = (name: string): never => {
  throw new Error(`fakeAppLock.${name} 未实现（此 fake 只模拟"未配置"状态）`);
};

export function fakeUnlockedAppLock(): AppLockStoreLike {
  return {
    status: () => ({ configured: false, webauthn: false, expiresAt: null }),
    setup: (): IssuedLockToken => never("setup"),
    unlock: (): IssuedLockToken => never("unlock"),
    change: (): IssuedLockToken => never("change"),
    disable: (): void => never("disable"),
    verifyToken: () => ({ ok: false, expiresAt: null }),
    createChallenge: () => never("createChallenge"),
    consumeChallenge: () => never("consumeChallenge"),
    registerWebAuthn: (): void => never("registerWebAuthn"),
    loginWebAuthn: (): IssuedLockToken => never("loginWebAuthn"),
  };
}
