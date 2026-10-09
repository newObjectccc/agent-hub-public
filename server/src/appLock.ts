/**
 * 应用锁（F1）：手机 PWA「打开面板先解锁」。
 *
 * 设计（与 config auth.token 的关系，见 docs/API_CONTRACT.md §13）：
 * - **应用锁**管 UI 解锁：PIN/口令只存 **SHA-256 加盐哈希**（data/app-lock.json，0600，绝不存明文），
 *   解锁成功 server 发短期令牌（7 天滑动过期：活跃自动续期），前端存 localStorage，过期/失效重新解锁；
 *   PIN/口令验证失败限速（连错 5 次起指数退避临时锁定），防暴力破解。
 * - **auth.token** 管 API 鉴权（可选，live-feed / 指令通道共享密钥）。两者完全独立：
 *   应用锁令牌不进日志/URL（只走 `X-App-Lock-Token` 请求头），也不替代 auth.token。
 * - 锁屏不拉任何会话数据（前端只挂解锁屏，页面组件不挂载）。
 *
 * 可选增强：生物识别快捷解锁（WebAuthn platform authenticator，server 侧验签）。
 * 浏览器不支持（无 getPublicKey / 无平台认证器）时前端隐藏按钮，一切照常走 PIN。
 */
import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ErrorCodes, HubError } from "./errors.js";

export const APP_LOCK_FILE = "app-lock.json";
/** 解锁令牌有效期：7 天（滑动过期：活动续期） */
export const LOCK_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 滑动续期节流：距上次续期 ≥ 1 小时才落盘新过期时间（防每个请求写盘） */
export const TOKEN_RENEW_INTERVAL_MS = 60 * 60 * 1000;
/** PIN/口令失败限速：连错 5 次起临时锁定，指数退避 30s → 60s → … 封顶 15min */
export const LOCK_MAX_FAILURES = 5;
export const LOCK_BACKOFF_BASE_MS = 30_000;
export const LOCK_BACKOFF_MAX_MS = 15 * 60 * 1000;

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 密钥合法性：4-6 位数字 PIN，或 8-128 字符口令（passphrase） */
export function isValidSecret(secret: unknown): secret is string {
  if (typeof secret !== "string") return false;
  if (/^\d{4,6}$/.test(secret)) return true;
  return secret.length >= 8 && secret.length <= 128;
}

export function secretRuleHint(): string {
  return "PIN 为 4-6 位数字，或 8-128 字符口令";
}

/** 加盐哈希（盐为随机 hex，随记录持久化；彩虹表无效） */
export function hashSecret(salt: string, secret: string): string {
  return sha256Hex(`${salt}:${secret}`);
}

export function makeSecretSalt(): string {
  return randomBytes(16).toString("hex");
}

/** 解锁令牌：随机 32 字节，server 只存 sha256(token)（token 本身不落盘） */
export interface IssuedLockToken {
  token: string;
  expiresAt: number;
}

export function newLockToken(now: number): IssuedLockToken & { tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: sha256Hex(token), expiresAt: now + LOCK_TOKEN_TTL_MS };
}

export interface AppLockCredential {
  /** base64url（credential.rawId） */
  credentialId: string;
  /** base64url（SPKI DER 公钥） */
  publicKey: string;
  signCount: number;
}

export interface AppLockRecord {
  version: 1;
  /** sha256(salt:secret) hex —— 绝不存明文 */
  hash: string;
  salt: string;
  /** sha256(token) hex；未解锁/令牌已清时为 null */
  tokenHash: string | null;
  tokenExpiresAt: number | null;
  webauthn: AppLockCredential | null;
  /**
   * 连续验证失败计数（可选，旧文件无此字段按 0）：持久化到 app-lock.json，
   * 重启后继续计数（防重启清零暴力破解），验证成功时清零。
   */
  failures?: number;
  /** 临时锁定截止时间戳（可选；指数退避，与 failures 一同持久化，跨重启生效） */
  lockedUntil?: number;
  createdAt: number;
  updatedAt: number;
}

/** JSON → 记录（损坏/缺字段一律 null，绝不 throw） */
export function parseAppLockRecord(raw: string): AppLockRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<AppLockRecord>;
    if (!parsed || parsed.version !== 1) return null;
    if (typeof parsed.hash !== "string" || parsed.hash.length !== 64) return null;
    if (typeof parsed.salt !== "string" || parsed.salt === "") return null;
    const tokenHash = typeof parsed.tokenHash === "string" && parsed.tokenHash.length === 64 ? parsed.tokenHash : null;
    const tokenExpiresAt = typeof parsed.tokenExpiresAt === "number" ? parsed.tokenExpiresAt : null;
    const failures = typeof parsed.failures === "number" && parsed.failures > 0 ? Math.floor(parsed.failures) : undefined;
    const lockedUntil = typeof parsed.lockedUntil === "number" && parsed.lockedUntil > 0 ? parsed.lockedUntil : undefined;
    let webauthn: AppLockCredential | null = null;
    if (parsed.webauthn && typeof parsed.webauthn === "object") {
      const w = parsed.webauthn as Partial<AppLockCredential>;
      if (typeof w.credentialId === "string" && w.credentialId !== "" && typeof w.publicKey === "string" && w.publicKey !== "") {
        webauthn = {
          credentialId: w.credentialId,
          publicKey: w.publicKey,
          signCount: typeof w.signCount === "number" && w.signCount >= 0 ? Math.floor(w.signCount) : 0,
        };
      }
    }
    return {
      version: 1,
      hash: parsed.hash,
      salt: parsed.salt,
      tokenHash,
      tokenExpiresAt,
      webauthn,
      ...(failures !== undefined ? { failures } : {}),
      ...(lockedUntil !== undefined ? { lockedUntil } : {}),
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

/** 记录 → JSON（稳定格式便于 diff/备份；不含任何明文密钥） */
export function serializeAppLockRecord(record: AppLockRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function hashToken(token: string): string {
  return sha256Hex(token);
}

function secretEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

/* ====================== WebAuthn 验证（纯函数，可单测） ====================== */

export function b64urlToBuf(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function bufToB64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export interface ClientDataCheckInput {
  /** base64url */
  clientDataJSON: string;
  /** 期望的挑战（base64url） */
  challenge: string;
  type: "webauthn.get" | "webauthn.create";
  /** 期望 rpId（hostname，不含端口） */
  rpId: string;
}

export type ClientDataCheckResult = { ok: true; origin: string } | { ok: false; reason: string };

/** 校验 clientDataJSON：type / challenge / origin hostname 与 rpId 一致 */
export function checkWebAuthnClientData(input: ClientDataCheckInput): ClientDataCheckResult {
  let parsed: { type?: unknown; challenge?: unknown; origin?: unknown };
  try {
    parsed = JSON.parse(b64urlToBuf(input.clientDataJSON).toString("utf8")) as typeof parsed;
  } catch {
    return { ok: false, reason: "clientDataJSON 解析失败" };
  }
  if (parsed.type !== input.type) return { ok: false, reason: `clientData.type 不匹配: ${String(parsed.type)}` };
  if (parsed.challenge !== input.challenge) return { ok: false, reason: "challenge 不匹配" };
  const origin = typeof parsed.origin === "string" ? parsed.origin : "";
  let hostname = "";
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return { ok: false, reason: "origin 非法" };
  }
  if (hostname !== input.rpId.toLowerCase()) {
    return { ok: false, reason: "origin 与 rpId 不匹配" };
  }
  return { ok: true, origin };
}

export interface AssertionCheckInput {
  /** base64url */
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

export interface AssertionCheckContext {
  challenge: string;
  rpId: string;
  stored: AppLockCredential;
}

export type AssertionCheckResult = { ok: true; signCount: number } | { ok: false; reason: string };

/**
 * WebAuthn 断言验签：
 * signature = ECDSA-P256-SHA256 over (authenticatorData || sha256(clientDataJSON))；
 * 另校验 credentialId、rpIdHash、userPresent/userVerified 标志与签名计数器（防克隆）。
 */
export function checkWebAuthnAssertion(input: AssertionCheckInput, ctx: AssertionCheckContext): AssertionCheckResult {
  if (input.credentialId !== ctx.stored.credentialId) {
    return { ok: false, reason: "credentialId 不匹配" };
  }
  const clientCheck = checkWebAuthnClientData({
    clientDataJSON: input.clientDataJSON,
    challenge: ctx.challenge,
    type: "webauthn.get",
    rpId: ctx.rpId,
  });
  if (!clientCheck.ok) return clientCheck;
  let authData: Buffer;
  let clientData: Buffer;
  let signature: Buffer;
  try {
    authData = b64urlToBuf(input.authenticatorData);
    clientData = b64urlToBuf(input.clientDataJSON);
    signature = b64urlToBuf(input.signature);
  } catch {
    return { ok: false, reason: "断言字段非法" };
  }
  if (authData.length < 37) return { ok: false, reason: "authenticatorData 过短" };
  const rpIdHash = authData.subarray(0, 32);
  if (!secretEquals(rpIdHash.toString("hex"), sha256Hex(ctx.rpId))) {
    return { ok: false, reason: "rpIdHash 不匹配" };
  }
  const flags = authData[32];
  if ((flags & 0x01) === 0) return { ok: false, reason: "userPresent 未置位" };
  if ((flags & 0x04) === 0) return { ok: false, reason: "userVerified 未置位" };
  const signCount = authData.readUInt32BE(33);
  if ((signCount > 0 || ctx.stored.signCount > 0) && signCount <= ctx.stored.signCount) {
    return { ok: false, reason: "signCount 回退（疑似克隆认证器）" };
  }
  let key;
  try {
    key = createPublicKey({ key: b64urlToBuf(ctx.stored.publicKey), format: "der", type: "spki" });
  } catch {
    return { ok: false, reason: "存储的公钥非法" };
  }
  const signed = Buffer.concat([authData, createHash("sha256").update(clientData).digest()]);
  const verified = cryptoVerify("sha256", signed, key, signature);
  if (!verified) return { ok: false, reason: "签名验证失败" };
  return { ok: true, signCount };
}

/** 注册用公钥可解析性校验（SPKI DER） */
export function isValidSpkiPublicKey(publicKeyB64url: string): boolean {
  try {
    createPublicKey({ key: b64urlToBuf(publicKeyB64url), format: "der", type: "spki" });
    return true;
  } catch {
    return false;
  }
}

/* ====================== 持久化存储 ====================== */

export interface AppLockStatus {
  configured: boolean;
  webauthn: boolean;
  /** 当前解锁令牌过期时间（未解锁为 null）——不含任何哈希/明文 */
  expiresAt: number | null;
}

export interface AppLockStoreLike {
  status(): AppLockStatus;
  setup(secret: string): IssuedLockToken;
  unlock(secret: string): IssuedLockToken;
  change(oldSecret: string, newSecret: string): IssuedLockToken;
  disable(oldSecret: string): void;
  verifyToken(token: string): { ok: boolean; expiresAt: number | null };
  createChallenge(kind: "create" | "get"): { challengeId: string; challenge: string };
  consumeChallenge(challengeId: string, kind: "create" | "get"): string | null;
  registerWebAuthn(input: { credentialId: string; publicKey: string; clientDataJSON: string; challenge: string; rpId: string }): void;
  loginWebAuthn(input: {
    credentialId: string;
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    challenge: string;
    rpId: string;
  }): IssuedLockToken;
}

interface PendingChallenge {
  challenge: string;
  kind: "create" | "get";
  expiresAt: number;
}

const CHALLENGE_TTL_MS = 2 * 60 * 1000;

/**
 * 持久化应用锁：构造时同步加载（记录极小，构造完即准确）；
 * 状态变更同步落盘（安全配置写失败必须上抛，绝不"以为锁上了其实没有"）。
 */
export class AppLockStore implements AppLockStoreLike {
  private record: AppLockRecord | null = null;
  private challenges = new Map<string, PendingChallenge>();
  /** 连续失败计数（PIN/口令/生物识别，成功即清零）：持久化在 record.failures，跨重启继续计 */
  private failures = 0;
  /** 临时锁定截止（指数退避）：持久化在 record.lockedUntil，跨重启生效 */
  private lockedUntil = 0;

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    try {
      this.record = parseAppLockRecord(readFileSync(this.file, "utf8"));
    } catch {
      this.record = null;
    }
    // 失败限速状态从盘上恢复（P2：连错锁定跨重启生效，重启不再清零）
    if (this.record) {
      this.failures = this.record.failures ?? 0;
      this.lockedUntil = this.record.lockedUntil ?? 0;
    }
  }

  status(): AppLockStatus {
    const rec = this.record;
    if (!rec) return { configured: false, webauthn: false, expiresAt: null };
    return {
      configured: true,
      webauthn: rec.webauthn !== null,
      expiresAt: rec.tokenHash !== null && rec.tokenExpiresAt !== null && rec.tokenExpiresAt > this.now() ? rec.tokenExpiresAt : null,
    };
  }

  private save(rec: AppLockRecord): void {
    mkdirSync(dirname(this.file), { recursive: true });
    // 凭据文件仅属主可读写（0600）：writeFileSync 的 mode 只在新建时生效，已有文件需 chmod 收紧
    writeFileSync(this.file, serializeAppLockRecord(rec), { encoding: "utf8", mode: 0o600 });
    chmodSync(this.file, 0o600);
    this.record = rec;
  }

  /** 锁定期内拒绝验证（429 + 剩余秒数） */
  private assertNotThrottled(): void {
    const now = this.now();
    if (this.lockedUntil > now) {
      const seconds = Math.ceil((this.lockedUntil - now) / 1000);
      throw new HubError(ErrorCodes.APP_LOCK_DENIED, `尝试过于频繁，请 ${seconds} 秒后重试`, 429);
    }
  }

  /** 验证失败计数 + 指数退避（连错 5 次锁 30s，之后每多错一次翻倍，封顶 15min）；持久化落盘 */
  private recordFailure(): void {
    this.failures += 1;
    if (this.failures >= LOCK_MAX_FAILURES) {
      const over = this.failures - LOCK_MAX_FAILURES;
      const backoff = Math.min(LOCK_BACKOFF_BASE_MS * 2 ** over, LOCK_BACKOFF_MAX_MS);
      this.lockedUntil = this.now() + backoff;
    }
    this.persistFailureState();
  }

  private recordSuccess(): void {
    this.failures = 0;
    this.lockedUntil = 0;
  }

  /** 失败限速状态落盘（只改 failures/lockedUntil，不动任何凭据字段） */
  private persistFailureState(): void {
    const rec = this.record;
    if (!rec) return;
    this.save({ ...rec, failures: this.failures, lockedUntil: this.lockedUntil, updatedAt: this.now() });
  }

  private issueToken(rec: AppLockRecord): IssuedLockToken {
    const { token, tokenHash, expiresAt } = newLockToken(this.now());
    // 发新令牌 = 本轮验证成功：失败计数/锁定一并清零落盘
    this.save({ ...rec, failures: 0, lockedUntil: 0, tokenHash, tokenExpiresAt: expiresAt, updatedAt: this.now() });
    return { token, expiresAt };
  }

  setup(secret: string): IssuedLockToken {
    if (this.record) {
      throw new HubError(ErrorCodes.APP_LOCK_EXISTS, "应用锁已配置：修改/关闭需验证旧 PIN", 409);
    }
    if (!isValidSecret(secret)) {
      throw new HubError(ErrorCodes.INVALID_REQUEST, secretRuleHint());
    }
    const salt = makeSecretSalt();
    const rec: AppLockRecord = {
      version: 1,
      hash: hashSecret(salt, secret),
      salt,
      tokenHash: null,
      tokenExpiresAt: null,
      webauthn: null,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    return this.issueToken(rec);
  }

  private verifySecret(rec: AppLockRecord, secret: string): boolean {
    return typeof secret === "string" && secret !== "" && secretEquals(hashSecret(rec.salt, secret), rec.hash);
  }

  unlock(secret: string): IssuedLockToken {
    const rec = this.record;
    if (!rec) {
      throw new HubError(ErrorCodes.APP_LOCK_NOT_CONFIGURED, "应用锁未配置", 400);
    }
    this.assertNotThrottled();
    if (!this.verifySecret(rec, secret)) {
      this.recordFailure();
      throw new HubError(ErrorCodes.APP_LOCK_DENIED, "PIN / 口令不正确", 401);
    }
    this.recordSuccess();
    return this.issueToken(rec);
  }

  change(oldSecret: string, newSecret: string): IssuedLockToken {
    const rec = this.record;
    if (!rec) {
      throw new HubError(ErrorCodes.APP_LOCK_NOT_CONFIGURED, "应用锁未配置", 400);
    }
    this.assertNotThrottled();
    if (!this.verifySecret(rec, oldSecret)) {
      this.recordFailure();
      throw new HubError(ErrorCodes.APP_LOCK_DENIED, "旧 PIN / 口令不正确", 401);
    }
    if (!isValidSecret(newSecret)) {
      throw new HubError(ErrorCodes.INVALID_REQUEST, secretRuleHint());
    }
    this.recordSuccess();
    const salt = makeSecretSalt();
    // 改密同时轮换令牌（旧令牌作废）
    return this.issueToken({
      ...rec,
      hash: hashSecret(salt, newSecret),
      salt,
      tokenHash: null,
      tokenExpiresAt: null,
    });
  }

  disable(oldSecret: string): void {
    const rec = this.record;
    if (!rec) {
      throw new HubError(ErrorCodes.APP_LOCK_NOT_CONFIGURED, "应用锁未配置", 400);
    }
    this.assertNotThrottled();
    if (!this.verifySecret(rec, oldSecret)) {
      this.recordFailure();
      throw new HubError(ErrorCodes.APP_LOCK_DENIED, "旧 PIN / 口令不正确", 401);
    }
    this.recordSuccess();
    this.record = null;
    // 关闭 = 记录整体作废：文件只留禁用审计壳，不保留任何凭据/哈希（同样 0600）
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify({ version: 1, disabled: true, updatedAt: this.now() }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(this.file, 0o600);
  }

  verifyToken(token: string): { ok: boolean; expiresAt: number | null } {
    const rec = this.record;
    if (!rec || typeof token !== "string" || token === "") return { ok: false, expiresAt: null };
    if (rec.tokenHash === null || rec.tokenExpiresAt === null) return { ok: false, expiresAt: null };
    const now = this.now();
    if (rec.tokenExpiresAt <= now) return { ok: false, expiresAt: null };
    if (!secretEquals(hashToken(token), rec.tokenHash)) return { ok: false, expiresAt: null };
    // 滑动过期：活动续期（节流写盘，距上次续期 ≥ TOKEN_RENEW_INTERVAL_MS 才落盘）
    if (rec.tokenExpiresAt < now + LOCK_TOKEN_TTL_MS - TOKEN_RENEW_INTERVAL_MS) {
      const expiresAt = now + LOCK_TOKEN_TTL_MS;
      this.save({ ...rec, tokenExpiresAt: expiresAt, updatedAt: now });
      return { ok: true, expiresAt };
    }
    return { ok: true, expiresAt: rec.tokenExpiresAt };
  }

  /* ---------- WebAuthn ---------- */

  createChallenge(kind: "create" | "get"): { challengeId: string; challenge: string } {
    const challenge = randomBytes(32).toString("base64url");
    const challengeId = randomBytes(16).toString("base64url");
    this.challenges.set(challengeId, { challenge, kind, expiresAt: this.now() + CHALLENGE_TTL_MS });
    // 顺手清理过期挑战（Map 很小）
    for (const [id, c] of this.challenges) {
      if (c.expiresAt <= this.now()) this.challenges.delete(id);
    }
    return { challengeId, challenge };
  }

  consumeChallenge(challengeId: string, kind: "create" | "get"): string | null {
    const found = this.challenges.get(challengeId);
    this.challenges.delete(challengeId);
    if (!found || found.kind !== kind || found.expiresAt <= this.now()) return null;
    return found.challenge;
  }

  registerWebAuthn(input: {
    credentialId: string;
    publicKey: string;
    clientDataJSON: string;
    challenge: string;
    rpId: string;
  }): void {
    const rec = this.record;
    if (!rec) {
      throw new HubError(ErrorCodes.APP_LOCK_NOT_CONFIGURED, "应用锁未配置", 400);
    }
    const check = checkWebAuthnClientData({
      clientDataJSON: input.clientDataJSON,
      challenge: input.challenge,
      type: "webauthn.create",
      rpId: input.rpId,
    });
    if (!check.ok) {
      throw new HubError(ErrorCodes.APP_LOCK_DENIED, `注册校验失败：${check.reason}`, 401);
    }
    if (typeof input.credentialId !== "string" || input.credentialId === "") {
      throw new HubError(ErrorCodes.INVALID_REQUEST, "credentialId 非法");
    }
    if (!isValidSpkiPublicKey(input.publicKey)) {
      throw new HubError(ErrorCodes.INVALID_REQUEST, "公钥非法（SPKI DER）");
    }
    this.save({
      ...rec,
      webauthn: { credentialId: input.credentialId, publicKey: input.publicKey, signCount: 0 },
      updatedAt: this.now(),
    });
  }

  loginWebAuthn(input: {
    credentialId: string;
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    challenge: string;
    rpId: string;
  }): IssuedLockToken {
    const rec = this.record;
    if (!rec) {
      throw new HubError(ErrorCodes.APP_LOCK_NOT_CONFIGURED, "应用锁未配置", 400);
    }
    if (!rec.webauthn) {
      throw new HubError(ErrorCodes.APP_LOCK_DENIED, "未启用生物识别解锁", 401);
    }
    this.assertNotThrottled();
    const result = checkWebAuthnAssertion(
      {
        credentialId: input.credentialId,
        clientDataJSON: input.clientDataJSON,
        authenticatorData: input.authenticatorData,
        signature: input.signature,
      },
      { challenge: input.challenge, rpId: input.rpId, stored: rec.webauthn },
    );
    if (!result.ok) {
      this.recordFailure();
      throw new HubError(ErrorCodes.APP_LOCK_DENIED, `生物识别校验失败：${result.reason}`, 401);
    }
    this.recordSuccess();
    this.save({
      ...rec,
      webauthn: { ...rec.webauthn, signCount: result.signCount },
      updatedAt: this.now(),
    });
    return this.issueToken(this.record as AppLockRecord);
  }
}

export function createAppLockStore(dataDir: string, now?: () => number): AppLockStore {
  return new AppLockStore(join(dataDir, APP_LOCK_FILE), now);
}
