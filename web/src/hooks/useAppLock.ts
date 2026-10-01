/**
 * 应用锁（F1）状态机：模块级单例（解锁屏与设置页共享同一状态）。
 *
 * 相位：loading → setup（未配置）/ locked（需解锁）/ unlocked（正常用）。
 * 安全约束：phase !== "unlocked" 时 App 只挂解锁屏（页面组件不挂载 → 不拉任何会话数据）；
 * 令牌只存 localStorage 且只走 `X-App-Lock-Token` 头；PIN 只交给 server 做哈希。
 */
import { useSyncExternalStore } from "react";
import { appLockApi } from "../api/appLock";
import {
  clearLockToken,
  friendlyLockError,
  isTokenFresh,
  loadLockToken,
  parseAppLockStatus,
  parseLockTokenResult,
  safeSecretCheck,
  saveLockToken,
  type StorageLike,
} from "../utils/appLock";
import {
  createBiometricCredential,
  getBiometricAssertion,
  isBiometricAvailable,
  normalizeCreationOptions,
  normalizeRequestOptions,
} from "../utils/webauthn";

export type LockPhase = "loading" | "setup" | "locked" | "unlocked";

export interface AppLockState {
  phase: LockPhase;
  busy: boolean;
  error: string | null;
  /** 平台认证器可用才显示生物识别按钮 */
  webauthnAvailable: boolean;
  configured: boolean;
  hasWebAuthnCredential: boolean;
}

const initialState: AppLockState = {
  phase: "loading",
  busy: false,
  error: null,
  webauthnAvailable: false,
  configured: false,
  hasWebAuthnCredential: false,
};

function storage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function errorMessage(e: unknown, fallback: string): string {
  // UX 审查 AC3：原始 JS 异常（TypeError 等）绝不裸露，统一映射友好文案
  return friendlyLockError(e, fallback);
}

/** 发令牌响应校验失败的统一错误（内部信号，最终展示为友好 fallback 文案） */
const BAD_TOKEN_RESPONSE = new Error("bad lock token response");

class AppLockController {
  private state: AppLockState = initialState;
  private listeners = new Set<() => void>();
  private initStarted = false;

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    if (!this.initStarted) {
      this.initStarted = true;
      void this.init();
    }
    return () => this.listeners.delete(fn);
  };

  readonly getSnapshot = (): AppLockState => this.state;

  private set(patch: Partial<AppLockState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** 启动：本地令牌仍有效 → 直接解锁（后台向 server 复核）；否则看 server 状态决定 setup/locked */
  private async init(): Promise<void> {
    const token = loadLockToken(storage());
    const fresh = isTokenFresh(token);
    if (fresh && token) {
      this.set({ phase: "unlocked", busy: false, error: null, configured: true });
      // 后台复核（令牌被 server 轮换/关闭锁等情况）；失败不打扰（离线时以本地为准）
      try {
        const status = parseAppLockStatus(await appLockApi.status(token.token));
        if (!status) throw BAD_TOKEN_RESPONSE;
        if (!status.unlocked) {
          clearLockToken(storage());
          this.set({ phase: status.configured ? "locked" : "setup", configured: status.configured, hasWebAuthnCredential: status.webauthn });
        } else {
          this.set({ hasWebAuthnCredential: status.webauthn });
        }
      } catch {
        // 离线/服务不可达/坏响应体：保持本地解锁（页面数据本也拉不到）
      }
      void this.detectBiometric();
      return;
    }
    if (token && !fresh) clearLockToken(storage());
    await this.refreshStatus("无法连接服务端，暂时无法解锁");
    void this.detectBiometric();
  }

  /**
   * 无本地令牌时向 server 取锁状态（启动/重试共用）。
   * 错误路径严格停在 locked 相位（UX 审查 AC3）：坏响应体/异常都不落入 setup；
   * 只有 server 明确回答 configured=false 才进 setup。
   */
  private async refreshStatus(fallback: string): Promise<void> {
    this.set({ phase: "loading", busy: true, error: null });
    try {
      const status = parseAppLockStatus(await appLockApi.status(null));
      if (!status) throw BAD_TOKEN_RESPONSE;
      this.set({
        phase: status.configured ? "locked" : "setup",
        configured: status.configured,
        hasWebAuthnCredential: status.webauthn,
        busy: false,
      });
    } catch (e) {
      this.set({
        phase: "locked",
        busy: false,
        configured: true,
        error: errorMessage(e, fallback),
      });
    }
  }

  private async detectBiometric(): Promise<void> {
    const available = await isBiometricAvailable();
    this.set({ webauthnAvailable: available });
  }

  /** 首次设置 PIN/口令（解锁屏 setup 态） */
  readonly setup = async (secret: string): Promise<void> => {
    if (this.state.busy) return;
    const problem = safeSecretCheck(secret);
    if (problem) {
      this.set({ error: problem });
      return;
    }
    this.set({ busy: true, error: null });
    try {
      const issued = parseLockTokenResult(await appLockApi.setup(secret));
      if (!issued) throw BAD_TOKEN_RESPONSE;
      saveLockToken(storage(), issued);
      this.set({ phase: "unlocked", busy: false, configured: true });
    } catch (e) {
      // 错误路径停在 setup 相位（设置未完成，留在设置屏重试），不误跳 unlocked
      this.set({ busy: false, error: errorMessage(e, "设置失败，请重试") });
    }
  };

  /** PIN/口令解锁 */
  readonly unlock = async (secret: string): Promise<void> => {
    if (this.state.busy) return;
    this.set({ busy: true, error: null });
    try {
      const issued = parseLockTokenResult(await appLockApi.unlock(secret));
      if (!issued) throw BAD_TOKEN_RESPONSE;
      saveLockToken(storage(), issued);
      this.set({ phase: "unlocked", busy: false });
    } catch (e) {
      // 错误路径严格停在 locked 相位（UX 审查 AC3）：PIN 错/坏响应体都留在解锁屏重试
      this.set({ busy: false, phase: "locked", error: errorMessage(e, "解锁失败，请重试") });
    }
  };

  /** 设置页改 PIN/口令（需旧 PIN；成功后令牌轮换） */
  readonly change = async (oldSecret: string, newSecret: string): Promise<boolean> => {
    const problem = safeSecretCheck(newSecret);
    if (problem) {
      this.set({ error: problem });
      return false;
    }
    this.set({ busy: true, error: null });
    try {
      const issued = parseLockTokenResult(await appLockApi.change(oldSecret, newSecret));
      if (!issued) throw BAD_TOKEN_RESPONSE;
      saveLockToken(storage(), issued);
      this.set({ busy: false, configured: true });
      return true;
    } catch (e) {
      this.set({ busy: false, error: errorMessage(e, "修改失败，请重试") });
      return false;
    }
  };

  /** 设置页关闭应用锁（需旧 PIN） */
  readonly disable = async (oldSecret: string): Promise<boolean> => {
    this.set({ busy: true, error: null });
    try {
      await appLockApi.disable(oldSecret);
      clearLockToken(storage());
      this.set({ busy: false, configured: false, hasWebAuthnCredential: false, phase: "unlocked" });
      return true;
    } catch (e) {
      this.set({ busy: false, error: errorMessage(e, "关闭失败，请重试") });
      return false;
    }
  };

  /** 生物识别快捷解锁（WebAuthn 可用才显示入口；失败回落 PIN） */
  readonly biometricUnlock = async (): Promise<void> => {
    if (this.state.busy) return;
    this.set({ busy: true, error: null });
    try {
      const start = await appLockApi.webauthnLoginStart();
      const assertion = await getBiometricAssertion(normalizeRequestOptions(start.options.publicKey));
      const issued = parseLockTokenResult(await appLockApi.webauthnLoginFinish({ challengeId: start.challengeId, credential: assertion }));
      if (!issued) throw BAD_TOKEN_RESPONSE;
      saveLockToken(storage(), issued);
      this.set({ phase: "unlocked", busy: false });
    } catch (e) {
      // 错误路径严格停在 locked 相位：回落 PIN 解锁屏重试
      this.set({ busy: false, phase: "locked", error: errorMessage(e, "生物识别失败，请改用 PIN") });
    }
  };

  /** 设置页启用生物识别（需已解锁；注册平台认证器公钥到 server） */
  readonly registerBiometric = async (): Promise<boolean> => {
    const token = loadLockToken(storage());
    if (!token) {
      this.set({ error: "请先解锁再启用生物识别" });
      return false;
    }
    this.set({ busy: true, error: null });
    try {
      const start = await appLockApi.webauthnRegisterStart(token.token);
      const credential = await createBiometricCredential(normalizeCreationOptions(start.options.publicKey));
      await appLockApi.webauthnRegisterFinish(token.token, { challengeId: start.challengeId, credential });
      this.set({ busy: false, hasWebAuthnCredential: true });
      return true;
    } catch (e) {
      this.set({ busy: false, error: errorMessage(e, "生物识别注册失败") });
      return false;
    }
  };

  /** 立即锁定（设置页手动锁）：清令牌回到解锁屏 */
  readonly lockNow = (): void => {
    clearLockToken(storage());
    this.set({ phase: this.state.configured ? "locked" : "setup", error: null });
  };

  /** 状态获取失败后的重试（解锁屏错误条「重试」按钮）：重新拉 server 锁状态 */
  readonly retry = async (): Promise<void> => {
    if (this.state.busy) return;
    await this.refreshStatus("无法连接服务端，暂时无法解锁");
  };

  /** 清除错误提示 */
  readonly clearError = (): void => {
    if (this.state.error !== null) this.set({ error: null });
  };
}

export const appLockController = new AppLockController();

export function useAppLock(): AppLockState & {
  setup: (secret: string) => Promise<void>;
  unlock: (secret: string) => Promise<void>;
  change: (oldSecret: string, newSecret: string) => Promise<boolean>;
  disable: (oldSecret: string) => Promise<boolean>;
  biometricUnlock: () => Promise<void>;
  registerBiometric: () => Promise<boolean>;
  lockNow: () => void;
  retry: () => Promise<void>;
  clearError: () => void;
} {
  const state = useSyncExternalStore(appLockController.subscribe, appLockController.getSnapshot, appLockController.getSnapshot);
  return {
    ...state,
    setup: appLockController.setup,
    unlock: appLockController.unlock,
    change: appLockController.change,
    disable: appLockController.disable,
    biometricUnlock: appLockController.biometricUnlock,
    registerBiometric: appLockController.registerBiometric,
    lockNow: appLockController.lockNow,
    retry: appLockController.retry,
    clearError: appLockController.clearError,
  };
}
