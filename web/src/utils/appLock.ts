/**
 * 应用锁（F1）前端纯逻辑：解锁令牌持久化与密钥规则（与 server/src/appLock.ts 同口径）。
 *
 * 设计：PIN/口令只交给 server 做 SHA-256 加盐哈希；解锁后 server 发 7 天令牌，
 * 本地只存令牌（localStorage），**不存 PIN 明文**。令牌只走 `X-App-Lock-Token`
 * 请求头，绝不进 URL/日志。token 失效/过期 → 显示解锁屏。
 *
 * 错误路径（UX 审查 AC3）：响应体严格校验（坏体 = 错误，绝不落入 setup 相位）；
 * 错误文案友好化（原始 JS 异常绝不直接抛给用户）。
 */
import type { AppLockStatus } from "../api/appLock";

export const LOCK_TOKEN_KEY = "agent-hub.appLockToken.v1";

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface LockToken {
  token: string;
  expiresAt: number;
}

/** 密钥合法性：4-6 位数字 PIN，或 8-128 字符口令（passphrase） */
export function isValidSecret(secret: string): boolean {
  if (typeof secret !== "string") return false;
  if (/^\d{4,6}$/.test(secret)) return true;
  return secret.length >= 8 && secret.length <= 128;
}

export function secretRuleHint(): string {
  return "PIN 为 4-6 位数字，或 8-128 字符口令";
}

/** 校验密钥：合法返回 null，否则返回错误文案（设置/修改表单用） */
export function safeSecretCheck(secret: string): string | null {
  return isValidSecret(secret) ? null : secretRuleHint();
}

/** 是否纯数字 PIN 输入态（数字键盘模式） */
export function isPinSecret(secret: string): boolean {
  return /^\d+$/.test(secret);
}

/** 读解锁令牌（损坏/缺省 → null，绝不 throw） */
export function loadLockToken(storage: StorageLike | null): LockToken | null {
  try {
    const raw = storage?.getItem(LOCK_TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LockToken>;
    if (!parsed || typeof parsed.token !== "string" || parsed.token === "") return null;
    if (typeof parsed.expiresAt !== "number" || !Number.isFinite(parsed.expiresAt)) return null;
    return { token: parsed.token, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

export function saveLockToken(storage: StorageLike | null, token: LockToken): void {
  try {
    storage?.setItem(LOCK_TOKEN_KEY, JSON.stringify(token));
  } catch {
    // 存储不可用：退化为本次页面内解锁（刷新后需重新解锁）
  }
}

export function clearLockToken(storage: StorageLike | null): void {
  try {
    storage?.removeItem(LOCK_TOKEN_KEY);
  } catch {
    // 忽略
  }
}

/** 令牌是否仍在有效期内（含 30s 时钟偏差余量） */
export function isTokenFresh(token: LockToken | null, now: number = Date.now()): boolean {
  return token !== null && token.expiresAt - 30_000 > now;
}

/**
 * WS 子协议（携带解锁令牌；子协议不进 URL/日志，遵守 token 不落 URL 约定）。
 * 未解锁/令牌不新鲜时返回 undefined（服务端锁屏门禁会拒绝发送）。
 */
export function wsLockProtocols(storage: StorageLike | null): string[] | undefined {
  const token = loadLockToken(storage);
  if (token === null || !isTokenFresh(token)) return undefined;
  return [`lock-token.${token.token}`];
}

/**
 * 错误 → 用户可读文案（UX 审查 AC3 错误裸露修复）：
 * 只信任服务端业务错误（ApiError）的中文提示；其余 JS 异常（TypeError、
 * JSON 解析错等）一律映射为 fallback，绝不把原始异常渲染给用户。
 */
export function friendlyLockError(e: unknown, fallback: string): string {
  // 只信服务端业务错误（ApiError，name 鸭子判定：跨模块实例也可靠）；TypeError 等一律 fallback
  if (e instanceof Error && e.name === "ApiError" && e.message.trim() !== "") return e.message;
  return fallback;
}

/**
 * 严格校验 /status 响应体（UX 审查 AC3）：坏体（null/缺字段/代理返回 HTML 解析失败等）
 * 返回 null → 调用方按错误处理（停在 locked），绝不因 undefined.configured 误落 setup。
 */
export function parseAppLockStatus(raw: unknown): AppLockStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.configured !== "boolean" || typeof r.unlocked !== "boolean") return null;
  return {
    configured: r.configured,
    webauthn: r.webauthn === true,
    unlocked: r.unlocked,
    expiresAt: typeof r.expiresAt === "number" && Number.isFinite(r.expiresAt) ? r.expiresAt : null,
  };
}

/**
 * 严格校验发令牌响应体：无令牌/坏令牌视为失败（防止 `{ok:false}` 等坏体被当成解锁成功）。
 * 合法返回 LockToken，否则 null。
 */
export function parseLockTokenResult(raw: unknown): LockToken | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.token !== "string" || r.token === "") return null;
  if (typeof r.expiresAt !== "number" || !Number.isFinite(r.expiresAt)) return null;
  return { token: r.token, expiresAt: r.expiresAt };
}
