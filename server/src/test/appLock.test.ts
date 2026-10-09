/**
 * 应用锁（F1）单元测试：
 * - 密钥合法性（4-6 位数字 PIN / 8-128 字符口令）
 * - 哈希落盘：绝不存明文（data/app-lock.json 只有 salt + sha256(salt:secret)）
 * - setup / unlock / change / disable 全生命周期 + 令牌7 天过期与轮换
 * - WebAuthn 断言验签（合成 EC P-256 密钥）：挑战/origin/rpIdHash/标志位/计数器/签名
 */
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  AppLockStore,
  bufToB64url,
  checkWebAuthnAssertion,
  checkWebAuthnClientData,
  hashSecret,
  isValidSecret,
  LOCK_TOKEN_TTL_MS,
  newLockToken,
  parseAppLockRecord,
  serializeAppLockRecord,
} from "../appLock.js";
import { HubError } from "../errors.js";

function tmpStore(now?: () => number): { store: AppLockStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "app-lock-"));
  const file = join(dir, "app-lock.json");
  return { store: new AppLockStore(file, now), file };
}

describe("appLock: 密钥合法性与哈希（绝不落明文）", () => {
  it("PIN 4-6 位数字合法；3 位/7 位/带字母非法", () => {
    assert.equal(isValidSecret("1234"), true);
    assert.equal(isValidSecret("123456"), true);
    assert.equal(isValidSecret("123"), false);
    assert.equal(isValidSecret("1234567"), false);
    assert.equal(isValidSecret("12a4"), false);
  });

  it("口令 8-128 字符合法；过短/超长非法", () => {
    assert.equal(isValidSecret("open-sesame"), true);
    assert.equal(isValidSecret("口令也要够长才行"), true);
    assert.equal(isValidSecret("short7c"), false);
    assert.equal(isValidSecret("x".repeat(129)), false);
    assert.equal(isValidSecret(1234), false);
    assert.equal(isValidSecret(null), false);
  });

  it("hashSecret(salt, secret) 稳定且不同盐不同值", () => {
    assert.equal(hashSecret("s1", "1234"), hashSecret("s1", "1234"));
    assert.notEqual(hashSecret("s1", "1234"), hashSecret("s2", "1234"));
    assert.notEqual(hashSecret("s1", "1234"), hashSecret("s1", "1235"));
  });

  it("持久化文件不含明文 PIN（只出现盐与哈希）", () => {
    const { store, file } = tmpStore();
    store.setup("482613");
    const raw = readFileSync(file, "utf8");
    assert.equal(raw.includes("482613"), false);
    const rec = parseAppLockRecord(raw);
    assert.ok(rec);
    assert.equal(rec!.hash.length, 64);
    assert.equal(rec!.hash, hashSecret(rec!.salt, "482613"));
    // 令牌也不落盘（只存 sha256(token)）
    assert.equal(rec!.tokenHash?.length, 64);
  });

  it("parse/serialize 往返稳定；损坏 JSON / 缺字段回 null", () => {
    const rec = {
      version: 1 as const,
      hash: "a".repeat(64),
      salt: "salt",
      tokenHash: null,
      tokenExpiresAt: null,
      webauthn: null,
      createdAt: 1,
      updatedAt: 2,
    };
    assert.deepEqual(parseAppLockRecord(serializeAppLockRecord(rec)), rec);
    assert.equal(parseAppLockRecord("not json"), null);
    assert.equal(parseAppLockRecord(JSON.stringify({ version: 2, hash: "a".repeat(64), salt: "s" })), null);
    assert.equal(parseAppLockRecord(JSON.stringify({ version: 1, hash: "short", salt: "s" })), null);
    assert.equal(parseAppLockRecord(JSON.stringify({ version: 1, hash: "a".repeat(64), salt: "" })), null);
  });

  it("newLockToken：7 天 TTL，tokenHash = sha256(token)", () => {
    const t = newLockToken(1_000);
    assert.equal(t.expiresAt, 1_000 + LOCK_TOKEN_TTL_MS);
    assert.equal(t.tokenHash, createHash("sha256").update(t.token).digest("hex"));
  });
});

describe("appLock: setup / unlock / change / disable 生命周期", () => {
  it("setup → unlock 正确 PIN 发令牌；错误 PIN 401 APP_LOCK_DENIED", () => {
    const { store } = tmpStore();
    const issued = store.setup("1234");
    assert.ok(issued.token.length > 20);
    assert.equal(store.status().configured, true);
    const unlocked = store.unlock("1234");
    assert.ok(unlocked.token.length > 20);
    assert.throws(() => store.unlock("9999"), (err: unknown) => err instanceof HubError && err.code === "APP_LOCK_DENIED" && err.statusCode === 401);
  });

  it("已配置再 setup → 409 APP_LOCK_EXISTS；非法密钥 → 400", () => {
    const { store } = tmpStore();
    store.setup("1234");
    assert.throws(() => store.setup("5678"), (err: unknown) => err instanceof HubError && err.code === "APP_LOCK_EXISTS");
    const { store: fresh } = tmpStore();
    assert.throws(() => fresh.setup("12"), (err: unknown) => err instanceof HubError && err.code === "INVALID_REQUEST");
  });

  it("change 需旧 PIN：错误旧 PIN 401；正确则换新且旧令牌作废", () => {
    let now = 1_000_000;
    const { store } = tmpStore(() => now);
    const first = store.setup("1234");
    assert.throws(() => store.change("0000", "567890"), (err: unknown) => err instanceof HubError && err.code === "APP_LOCK_DENIED");
    const second = store.change("1234", "567890");
    assert.notEqual(second.token, first.token);
    assert.equal(store.verifyToken(first.token).ok, false, "改密后旧令牌必须作废");
    assert.equal(store.verifyToken(second.token).ok, true);
    assert.ok(store.unlock("567890").token.length > 20);
    assert.throws(() => store.unlock("1234"), (err: unknown) => err instanceof HubError && err.code === "APP_LOCK_DENIED");
  });

  it("disable 需旧 PIN：成功后重新变为未配置（可重新 setup）", () => {
    const { store, file } = tmpStore();
    store.setup("1234");
    assert.throws(() => store.disable("0000"), (err: unknown) => err instanceof HubError && err.code === "APP_LOCK_DENIED");
    store.disable("1234");
    assert.equal(store.status().configured, false);
    assert.equal(readFileSync(file, "utf8").includes("1234"), false);
    // 关闭后可重新设置
    store.setup("654321");
    assert.equal(store.status().configured, true);
  });

  it("令牌校验：滑动过期（活动续期）、闲置超 7 天过期、伪造令牌无效", () => {
    let now = 0;
    const { store } = tmpStore(() => now);
    const { token } = store.setup("1234");
    assert.equal(store.verifyToken(token).ok, true);
    assert.equal(store.verifyToken("forged-token").ok, false);
    assert.equal(store.verifyToken("").ok, false);
    // 活动续期：6 天后仍活跃 → 过期时间前移（总存活 > 7 天）
    now = 6 * 24 * 60 * 60 * 1000;
    assert.equal(store.verifyToken(token).ok, true, "活动续期内不过期");
    now += 6 * 24 * 60 * 60 * 1000;
    const renewed = store.verifyToken(token);
    assert.equal(renewed.ok, true, "滑动过期：活跃期间持续有效");
    assert.ok((renewed.expiresAt ?? 0) > LOCK_TOKEN_TTL_MS, "过期时间已滑动前移");

    // 闲置过期：全程不活动 → 超 7 天必须过期
    let idleNow = 0;
    const { store: idle } = tmpStore(() => idleNow);
    const idleToken = idle.setup("1234").token;
    idleNow = LOCK_TOKEN_TTL_MS + 1;
    assert.equal(idle.verifyToken(idleToken).ok, false, "闲置超过 7 天必须过期");
  });

  it("PIN 失败限速：连错 5 次锁 30s（429），指数退避翻倍，成功解锁清零", () => {
    let now = 1_000_000;
    const { store } = tmpStore(() => now);
    store.setup("1234");
    for (let i = 0; i < 5; i += 1) {
      assert.throws(
        () => store.unlock("0000"),
        (err: unknown) => err instanceof HubError && err.code === "APP_LOCK_DENIED" && err.statusCode === 401,
        `第 ${i + 1} 次错误 PIN 应 401`,
      );
    }
    // 锁定期内：正确 PIN 也拒绝（429 + 剩余秒数）
    assert.throws(
      () => store.unlock("1234"),
      (err: unknown) => err instanceof HubError && err.statusCode === 429 && /秒后重试/.test(err.message),
    );
    // 30s 后解锁锁定；再错一次 → 锁定翻倍到 60s（指数退避）
    now += 31_000;
    assert.throws(
      () => store.unlock("0000"),
      (err: unknown) => err instanceof HubError && err.statusCode === 401,
    );
    assert.throws(
      () => store.unlock("1234"),
      (err: unknown) => err instanceof HubError && err.statusCode === 429,
    );
    // 60s 后正确 PIN 解锁成功并清零计数：后续 4 次错误不再受限
    now += 61_000;
    assert.ok(store.unlock("1234").token.length > 20);
    for (let i = 0; i < 4; i += 1) {
      assert.throws(
        () => store.unlock("0000"),
        (err: unknown) => err instanceof HubError && err.statusCode === 401,
      );
    }
    assert.ok(store.unlock("1234").token.length > 20, "4 次错误未达阈值，不受限");
  });

  it("凭据文件 chmod 0600（save / disable 均收紧）", () => {
    const { store, file } = tmpStore();
    store.setup("1234");
    assert.equal(statSync(file).mode & 0o777, 0o600, "setup 落盘 0600");
    // 人为放宽后再次写盘（滑动续期）应重新收紧
    chmodSync(file, 0o644);
    assert.equal(store.verifyToken(store.unlock("1234").token).ok, true);
    assert.equal(statSync(file).mode & 0o777, 0o600, "写盘即收紧");
    store.disable("1234");
    assert.equal(statSync(file).mode & 0o777, 0o600, "disable 落盘同样 0600");
  });

  it("未配置时 unlock/change/disable → APP_LOCK_NOT_CONFIGURED", () => {
    const { store } = tmpStore();
    assert.throws(() => store.unlock("1234"), (err: unknown) => err instanceof HubError && err.code === "APP_LOCK_NOT_CONFIGURED");
    assert.throws(() => store.change("1234", "5678"), (err: unknown) => err instanceof HubError && err.code === "APP_LOCK_NOT_CONFIGURED");
    assert.throws(() => store.disable("1234"), (err: unknown) => err instanceof HubError && err.code === "APP_LOCK_NOT_CONFIGURED");
  });

  it("挑战一次性消费：重复/未知/类型不符返回 null", () => {
    const { store } = tmpStore();
    const { challengeId, challenge } = store.createChallenge("get");
    assert.equal(store.consumeChallenge(challengeId, "get"), challenge);
    assert.equal(store.consumeChallenge(challengeId, "get"), null, "一次性：二次消费失败");
    const c2 = store.createChallenge("create");
    assert.equal(store.consumeChallenge(c2.challengeId, "get"), null, "类型不符失败");
  });
});

/* ====================== WebAuthn 验签（合成密钥） ====================== */

interface SyntheticKey {
  privateKey: KeyObject;
  publicKeyB64url: string;
}

function makeKey(): SyntheticKey {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKey,
    publicKeyB64url: bufToB64url(publicKey.export({ type: "spki", format: "der" })),
  };
}

function makeClientData(type: "webauthn.get" | "webauthn.create", challenge: string, origin: string): string {
  return bufToB64url(Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8"));
}

function makeAuthData(rpId: string, flags: number, counter: number): Buffer {
  const buf = Buffer.alloc(37);
  createHash("sha256").update(rpId).digest().copy(buf, 0);
  buf[32] = flags;
  buf.writeUInt32BE(counter, 33);
  return buf;
}

function makeAssertion(
  key: SyntheticKey,
  opts: { challenge: string; rpId: string; origin?: string; flags?: number; counter?: number; type?: "webauthn.get" | "webauthn.create" },
) {
  const origin = opts.origin ?? `http://${opts.rpId}:5173`;
  const clientDataJSON = makeClientData(opts.type ?? "webauthn.get", opts.challenge, origin);
  const authData = makeAuthData(opts.rpId, opts.flags ?? 0x05, opts.counter ?? 1);
  const signed = Buffer.concat([authData, createHash("sha256").update(Buffer.from(clientDataJSON, "base64url")).digest()]);
  const signature = bufToB64url(cryptoSign("sha256", signed, key.privateKey));
  return {
    credentialId: bufToB64url(Buffer.from("cred-1")),
    clientDataJSON,
    authenticatorData: bufToB64url(authData),
    signature,
    challenge: opts.challenge,
  };
}

describe("appLock: WebAuthn 断言验签", () => {
  const challenge = bufToB64url(Buffer.from("challenge-bytes"));

  it("合法断言通过并返回计数器", () => {
    const key = makeKey();
    const stored = { credentialId: bufToB64url(Buffer.from("cred-1")), publicKey: key.publicKeyB64url, signCount: 0 };
    const assertion = makeAssertion(key, { challenge, rpId: "localhost", counter: 3 });
    const result = checkWebAuthnAssertion(assertion, { challenge, rpId: "localhost", stored });
    assert.deepEqual(result, { ok: true, signCount: 3 });
  });

  it("错误挑战 / 错误 origin / 错误 credentialId 一律拒绝", () => {
    const key = makeKey();
    const stored = { credentialId: bufToB64url(Buffer.from("cred-1")), publicKey: key.publicKeyB64url, signCount: 0 };
    const bad = makeAssertion(key, { challenge: bufToB64url(Buffer.from("other")), rpId: "localhost" });
    assert.equal(checkWebAuthnAssertion(bad, { challenge, rpId: "localhost", stored }).ok, false);
    const badOrigin = makeAssertion(key, { challenge, rpId: "localhost", origin: "http://evil.example.com" });
    assert.equal(checkWebAuthnAssertion(badOrigin, { challenge, rpId: "localhost", stored }).ok, false);
    const badId = makeAssertion(key, { challenge, rpId: "localhost" });
    badId.credentialId = bufToB64url(Buffer.from("cred-2"));
    assert.equal(checkWebAuthnAssertion(badId, { challenge, rpId: "localhost", stored }).ok, false);
  });

  it("rpIdHash 不匹配 / userVerified 未置位 / 计数器回退 / 签名伪造 一律拒绝", () => {
    const key = makeKey();
    const stored = { credentialId: bufToB64url(Buffer.from("cred-1")), publicKey: key.publicKeyB64url, signCount: 5 };
    // rpIdHash 不匹配（authenticatorData 用别的 rpId 签）
    const wrongRp = makeAssertion(key, { challenge, rpId: "other-host" });
    assert.equal(checkWebAuthnAssertion(wrongRp, { challenge, rpId: "localhost", stored }).ok, false);
    // flags 只有 UP 无 UV
    const noUv = makeAssertion(key, { challenge, rpId: "localhost", flags: 0x01, counter: 6 });
    assert.equal(checkWebAuthnAssertion(noUv, { challenge, rpId: "localhost", stored }).ok, false);
    // 计数器回退
    const stale = makeAssertion(key, { challenge, rpId: "localhost", counter: 5 });
    assert.equal(checkWebAuthnAssertion(stale, { challenge, rpId: "localhost", stored }).ok, false);
    // 签名伪造
    const forged = makeAssertion(key, { challenge, rpId: "localhost", counter: 6 });
    forged.signature = bufToB64url(Buffer.from("not-a-signature"));
    assert.equal(checkWebAuthnAssertion(forged, { challenge, rpId: "localhost", stored }).ok, false);
    // 一切合法 → 通过（计数器 6 > 5）
    const good = makeAssertion(key, { challenge, rpId: "localhost", counter: 6 });
    assert.equal(checkWebAuthnAssertion(good, { challenge, rpId: "localhost", stored }).ok, true);
  });

  it("checkWebAuthnClientData：type/challenge/origin hostname 三重校验", () => {
    const good = makeClientData("webauthn.get", challenge, "http://127.0.0.1:7700");
    assert.equal(checkWebAuthnClientData({ clientDataJSON: good, challenge, type: "webauthn.get", rpId: "127.0.0.1" }).ok, true);
    const wrongType = makeClientData("webauthn.create", challenge, "http://127.0.0.1:7700");
    assert.equal(checkWebAuthnClientData({ clientDataJSON: wrongType, challenge, type: "webauthn.get", rpId: "127.0.0.1" }).ok, false);
    const wrongChallenge = makeClientData("webauthn.get", "other", "http://127.0.0.1:7700");
    assert.equal(checkWebAuthnClientData({ clientDataJSON: wrongChallenge, challenge, type: "webauthn.get", rpId: "127.0.0.1" }).ok, false);
    const wrongOrigin = makeClientData("webauthn.get", challenge, "http://evil.example.com");
    assert.equal(checkWebAuthnClientData({ clientDataJSON: wrongOrigin, challenge, type: "webauthn.get", rpId: "127.0.0.1" }).ok, false);
    assert.equal(checkWebAuthnClientData({ clientDataJSON: "!!!", challenge, type: "webauthn.get", rpId: "127.0.0.1" }).ok, false);
  });

  it("store.registerWebAuthn + loginWebAuthn 全流程：注册校验、验签发令牌、计数器持久化", () => {
    let now = 1_000_000;
    const { store } = tmpStore(() => now);
    store.setup("1234");
    const key = makeKey();
    const credentialId = bufToB64url(Buffer.from("cred-1"));
    // 注册：挑战 + clientData 绑定
    const reg = store.createChallenge("create");
    const regClientData = makeClientData("webauthn.create", reg.challenge, "http://localhost:5173");
    assert.throws(
      () =>
        store.registerWebAuthn({
          credentialId,
          publicKey: key.publicKeyB64url,
          clientDataJSON: regClientData,
          challenge: "wrong-challenge",
          rpId: "localhost",
        }),
      (err: unknown) => err instanceof HubError && err.code === "APP_LOCK_DENIED",
    );
    store.registerWebAuthn({
      credentialId,
      publicKey: key.publicKeyB64url,
      clientDataJSON: regClientData,
      challenge: reg.challenge,
      rpId: "localhost",
    });
    assert.equal(store.status().webauthn, true);
    // 登录：验签发令牌（与 PIN 解锁同语义）
    const login = store.createChallenge("get");
    const assertion = makeAssertion(key, { challenge: login.challenge, rpId: "localhost", counter: 1 });
    const issued = store.loginWebAuthn({ ...assertion, challenge: login.challenge, rpId: "localhost" });
    assert.equal(store.verifyToken(issued.token).ok, true);
    // 计数器已持久化：同计数器重放拒绝
    const replay = store.createChallenge("get");
    const replayAssertion = makeAssertion(key, { challenge: replay.challenge, rpId: "localhost", counter: 1 });
    assert.throws(
      () => store.loginWebAuthn({ ...replayAssertion, challenge: replay.challenge, rpId: "localhost" }),
      (err: unknown) => err instanceof HubError && err.code === "APP_LOCK_DENIED",
    );
  });
});
