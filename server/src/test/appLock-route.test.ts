/**
 * 应用锁路由测试（契约 §13）：
 * - GET /api/app-lock/status：只回状态，绝不泄漏哈希/盐/令牌
 * - setup / unlock / change / disable 生命周期与错误码（409/401/400）
 * - 解锁令牌只认 `X-App-Lock-Token` 头（不进 URL），7 天过期、改密轮换
 * - WebAuthn 注册/登录：注册需已解锁；登录验签通过发令牌（合成 EC P-256 断言）
 */
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { AppLockStore, bufToB64url } from "../appLock.js";
import { DEFAULT_CONFIG, type HubConfig } from "../config.js";
import { createApp } from "../index.js";
import type { SessionHubLike } from "../routes.js";
import type { PromptResult } from "../sessions/hub.js";
import type { MessageDto, SearchResultDto, SessionListItem, SessionTreeDto, SystemInfo } from "../types.js";
import { makeFakeDashboard } from "./fakeDashboard.js";

const sessionFixture: SessionListItem = {
  id: "sess-1",
  source: "pi",
  name: null,
  cwd: "/tmp/demo",
  updatedAt: "2026-02-18T12:00:00.000Z",
  messageCount: 0,
  status: "idle",
  lastUserMessage: null,
  lastAssistantMessage: null,
  sessionFile: "/tmp/demo.jsonl",
  isSubAgent: false,
};

const systemFixture: SystemInfo = {
  platform: "darwin",
  pi: { available: true, version: "0.87.1" },
  claude: { available: true, version: "2.1.267" },
  tmux: { available: false, version: null },
  ttyd: { available: false, version: null },
  tailscale: { available: false, version: null, loggedIn: false, hostname: null },
  sessionDir: "/tmp/sessions",
  workspaceRoot: "/tmp/ws",
  metrics: null,
};

function makeFakeHub(): SessionHubLike {
  return {
    getStatus: () => "idle",
    listSessions: async () => [sessionFixture],
    findSession: async (id: string) => (id === "sess-1" ? sessionFixture : null),
    loadMessages: async (): Promise<MessageDto[]> => [],
    search: async (): Promise<SearchResultDto[]> => [],
    loadTree: async (): Promise<SessionTreeDto | null> => ({ entries: [], activePath: [] }),
    createSession: async () => sessionFixture,
    forkSession: async () => sessionFixture,
    prompt: async (): Promise<PromptResult> => ({ accepted: true, mode: "prompt" }),
    abort: async () => undefined,
    compact: async () => undefined,
  };
}

function makeClientData(type: "webauthn.get" | "webauthn.create", challenge: string, origin: string): string {
  return bufToB64url(Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8"));
}

describe("app-lock 路由：状态 / setup / unlock / change / disable", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let store: AppLockStore;

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "app-lock-route-"));
    store = new AppLockStore(join(dir, "app-lock.json"));
    app = await createApp({
      hub: makeFakeHub(),
      dashboard: makeFakeDashboard(),
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG } as HubConfig,
      systemInfo: async () => systemFixture,
      webRoot: null,
      appLock: store,
    });
  });

  after(async () => {
    await app.close();
  });

  it("初始 status：未配置 / 未解锁，且响应不含 hash/salt/token 字段", async () => {
    const res = await app.inject({ method: "GET", url: "/api/app-lock/status" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as Record<string, unknown>;
    assert.deepEqual(body, { configured: false, webauthn: false, unlocked: false, expiresAt: null });
    const raw = res.body;
    assert.equal(raw.includes("hash"), false);
    assert.equal(raw.includes("salt"), false);
    assert.equal(raw.includes("token"), false);
  });

  it("setup：201 发令牌；非法密钥 400；重复 setup 409", async () => {
    const bad = await app.inject({ method: "POST", url: "/api/app-lock/setup", payload: { secret: "12" } });
    assert.equal(bad.statusCode, 400);
    assert.equal((bad.json() as { error: { code: string } }).error.code, "INVALID_REQUEST");

    const ok = await app.inject({ method: "POST", url: "/api/app-lock/setup", payload: { secret: "246810" } });
    assert.equal(ok.statusCode, 201);
    const created = ok.json() as { token: string; expiresAt: number };
    assert.ok(created.token.length > 20);
    assert.ok(created.expiresAt > Date.now());

    const again = await app.inject({ method: "POST", url: "/api/app-lock/setup", payload: { secret: "135790" } });
    assert.equal(again.statusCode, 409);
    assert.equal((again.json() as { error: { code: string } }).error.code, "APP_LOCK_EXISTS");

    // 令牌不进 URL：GET ?token= 无效，只有 X-App-Lock-Token 头有效
    const viaHeader = await app.inject({
      method: "GET",
      url: "/api/app-lock/status",
      headers: { "x-app-lock-token": created.token },
    });
    assert.equal((viaHeader.json() as { unlocked: boolean }).unlocked, true);
    const viaQuery = await app.inject({ method: "GET", url: `/api/app-lock/status?token=${created.token}` });
    assert.equal((viaQuery.json() as { unlocked: boolean }).unlocked, false);
  });

  it("unlock：错误 PIN 401 APP_LOCK_DENIED；正确 PIN 发新令牌", async () => {
    const wrong = await app.inject({ method: "POST", url: "/api/app-lock/unlock", payload: { secret: "000000" } });
    assert.equal(wrong.statusCode, 401);
    assert.equal((wrong.json() as { error: { code: string } }).error.code, "APP_LOCK_DENIED");
    const ok = await app.inject({ method: "POST", url: "/api/app-lock/unlock", payload: { secret: "246810" } });
    assert.equal(ok.statusCode, 200);
    assert.ok((ok.json() as { token: string }).token.length > 20);
  });

  it("change：需旧 PIN；成功后旧令牌作废、新令牌有效", async () => {
    const wrongOld = await app.inject({
      method: "POST",
      url: "/api/app-lock/change",
      payload: { oldSecret: "999999", newSecret: "112233" },
    });
    assert.equal(wrongOld.statusCode, 401);

    const before = await app.inject({ method: "POST", url: "/api/app-lock/unlock", payload: { secret: "246810" } });
    const oldToken = (before.json() as { token: string }).token;

    const changed = await app.inject({
      method: "POST",
      url: "/api/app-lock/change",
      payload: { oldSecret: "246810", newSecret: "112233" },
    });
    assert.equal(changed.statusCode, 200);
    const newToken = (changed.json() as { token: string }).token;

    const oldCheck = await app.inject({
      method: "GET",
      url: "/api/app-lock/status",
      headers: { "x-app-lock-token": oldToken },
    });
    assert.equal((oldCheck.json() as { unlocked: boolean }).unlocked, false, "改密后旧令牌必须作废");
    const newCheck = await app.inject({
      method: "GET",
      url: "/api/app-lock/status",
      headers: { "x-app-lock-token": newToken },
    });
    assert.equal((newCheck.json() as { unlocked: boolean }).unlocked, true);

    const oldPin = await app.inject({ method: "POST", url: "/api/app-lock/unlock", payload: { secret: "246810" } });
    assert.equal(oldPin.statusCode, 401);
  });

  it("webauthn register：未解锁 401；解锁后 start/finish 登记公钥", async () => {
    const noToken = await app.inject({ method: "POST", url: "/api/app-lock/webauthn/register/start", payload: {} });
    assert.equal(noToken.statusCode, 401);

    const unlocked = await app.inject({ method: "POST", url: "/api/app-lock/unlock", payload: { secret: "112233" } });
    const token = (unlocked.json() as { token: string }).token;
    const headers = { "x-app-lock-token": token };

    const start = await app.inject({ method: "POST", url: "/api/app-lock/webauthn/register/start", headers, payload: {} });
    assert.equal(start.statusCode, 200);
    const startBody = start.json() as {
      challengeId: string;
      options: { publicKey: { challenge: string; rp: { id: string } } };
    };
    assert.ok(startBody.challengeId.length > 10);
    assert.ok(startBody.options.publicKey.challenge.length > 10);

    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const clientDataJSON = makeClientData(
      "webauthn.create",
      startBody.options.publicKey.challenge,
      `http://${startBody.options.publicKey.rp.id}:7700`,
    );
    const finish = await app.inject({
      method: "POST",
      url: "/api/app-lock/webauthn/register/finish",
      headers,
      payload: {
        challengeId: startBody.challengeId,
        credential: {
          id: bufToB64url(Buffer.from("cred-route-1")),
          publicKey: bufToB64url(publicKey.export({ type: "spki", format: "der" })),
          clientDataJSON,
        },
      },
    });
    assert.equal(finish.statusCode, 200);

    const status = await app.inject({ method: "GET", url: "/api/app-lock/status", headers });
    assert.equal((status.json() as { webauthn: boolean }).webauthn, true);
  });

  it("webauthn login：start 发挑战，finish 合成断言验签通过发令牌；伪造签名 401", async () => {
    const start = await app.inject({ method: "POST", url: "/api/app-lock/webauthn/login/start", payload: {} });
    assert.equal(start.statusCode, 200);
    const startBody = start.json() as { challengeId: string; options: { publicKey: { challenge: string; rpId: string } } };
    const challenge = startBody.options.publicKey.challenge;
    const rpId = startBody.options.publicKey.rpId;

    // 上一个用例登记的私钥在这里重新生成不行——重新注册一把可控私钥
    const unlocked = await app.inject({ method: "POST", url: "/api/app-lock/unlock", payload: { secret: "112233" } });
    const token = (unlocked.json() as { token: string }).token;
    const headers = { "x-app-lock-token": token };
    const reg = await app.inject({ method: "POST", url: "/api/app-lock/webauthn/register/start", headers, payload: {} });
    const regBody = reg.json() as { challengeId: string; options: { publicKey: { challenge: string } } };
    const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const regClientData = makeClientData("webauthn.create", regBody.options.publicKey.challenge, `http://${rpId}:7700`);
    await app.inject({
      method: "POST",
      url: "/api/app-lock/webauthn/register/finish",
      headers,
      payload: {
        challengeId: regBody.challengeId,
        credential: {
          id: bufToB64url(Buffer.from("cred-route-2")),
          publicKey: bufToB64url(keys.publicKey.export({ type: "spki", format: "der" })),
          clientDataJSON: regClientData,
        },
      },
    });

    const login = await app.inject({ method: "POST", url: "/api/app-lock/webauthn/login/start", payload: {} });
    const loginBody = login.json() as { challengeId: string; options: { publicKey: { challenge: string; rpId: string } } };
    const loginChallenge = loginBody.options.publicKey.challenge;

    const clientDataJSON = makeClientData("webauthn.get", loginChallenge, `http://${rpId}:7700`);
    const authData = Buffer.alloc(37);
    createHash("sha256").update(rpId).digest().copy(authData, 0);
    authData[32] = 0x05;
    authData.writeUInt32BE(1, 33);
    const signed = Buffer.concat([authData, createHash("sha256").update(Buffer.from(clientDataJSON, "base64url")).digest()]);
    const signature = bufToB64url(cryptoSign("sha256", signed, keys.privateKey));

    // 伪造签名 401
    const forged = await app.inject({
      method: "POST",
      url: "/api/app-lock/webauthn/login/finish",
      payload: {
        challengeId: loginBody.challengeId,
        credential: {
          id: bufToB64url(Buffer.from("cred-route-2")),
          clientDataJSON,
          authenticatorData: bufToB64url(authData),
          signature: bufToB64url(Buffer.from("bad-signature")),
        },
      },
    });
    assert.equal(forged.statusCode, 401);

    // 合法断言 → 发解锁令牌
    const login2 = await app.inject({ method: "POST", url: "/api/app-lock/webauthn/login/start", payload: {} });
    const loginBody2 = login2.json() as { challengeId: string; options: { publicKey: { challenge: string } } };
    const clientDataJSON2 = makeClientData("webauthn.get", loginBody2.options.publicKey.challenge, `http://${rpId}:7700`);
    const signed2 = Buffer.concat([authData, createHash("sha256").update(Buffer.from(clientDataJSON2, "base64url")).digest()]);
    const signature2 = bufToB64url(cryptoSign("sha256", signed2, keys.privateKey));
    const okRes = await app.inject({
      method: "POST",
      url: "/api/app-lock/webauthn/login/finish",
      payload: {
        challengeId: loginBody2.challengeId,
        credential: {
          id: bufToB64url(Buffer.from("cred-route-2")),
          clientDataJSON: clientDataJSON2,
          authenticatorData: bufToB64url(authData),
          signature: signature2,
        },
      },
    });
    assert.equal(okRes.statusCode, 200);
    const bioToken = (okRes.json() as { token: string }).token;
    const check = await app.inject({
      method: "GET",
      url: "/api/app-lock/status",
      headers: { "x-app-lock-token": bioToken },
    });
    assert.equal((check.json() as { unlocked: boolean }).unlocked, true);
  });

  it("disable：需旧 PIN；关闭后 status 回未配置", async () => {
    const wrongOld = await app.inject({ method: "POST", url: "/api/app-lock/disable", payload: { oldSecret: "000000" } });
    assert.equal(wrongOld.statusCode, 401);
    const ok = await app.inject({ method: "POST", url: "/api/app-lock/disable", payload: { oldSecret: "112233" } });
    assert.equal(ok.statusCode, 200);
    const status = await app.inject({ method: "GET", url: "/api/app-lock/status" });
    assert.equal((status.json() as { configured: boolean }).configured, false);
  });
});

describe("app-lock 全局锁屏门禁（onRequest）", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let store: AppLockStore;
  let token: string;

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "app-lock-gate-"));
    store = new AppLockStore(join(dir, "app-lock.json"));
    app = await createApp({
      hub: makeFakeHub(),
      dashboard: makeFakeDashboard(),
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG } as HubConfig,
      systemInfo: async () => systemFixture,
      webRoot: null,
      appLock: store,
    });
    token = store.setup("246810").token;
  });

  after(async () => {
    await app.close();
  });

  it("锁屏 + 无令牌：全部业务 API 拒绝 423 APP_LOCKED（统一错误信封）", async () => {
    for (const url of ["/api/sessions", "/api/kpi", "/api/system", "/api/dashboard/stats"]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 423, url);
      const body = res.json() as { error: { code: string; message: string } };
      assert.deepEqual(Object.keys(body), ["error"]);
      assert.equal(body.error.code, "APP_LOCKED");
    }
    const post = await app.inject({ method: "POST", url: "/api/sessions/sess-1/prompt", payload: { text: "hi" } });
    assert.equal(post.statusCode, 423, "锁屏下不得驱动 agent");
  });

  it("错令牌 401 APP_LOCK_DENIED；有效令牌放行 200", async () => {
    const wrong = await app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { "x-app-lock-token": "forged" },
    });
    assert.equal(wrong.statusCode, 401);
    assert.equal((wrong.json() as { error: { code: string } }).error.code, "APP_LOCK_DENIED");

    const ok = await app.inject({ method: "GET", url: "/api/sessions", headers: { "x-app-lock-token": token } });
    assert.equal(ok.statusCode, 200);
  });

  it("解锁/设置/登录端点豁免门禁（可从锁屏态进入解锁流程），静态资源不受影响", async () => {
    const status = await app.inject({ method: "GET", url: "/api/app-lock/status" });
    assert.equal(status.statusCode, 200, "status 可查（前端显示锁屏）");
    assert.equal((status.json() as { unlocked: boolean }).unlocked, false);

    const unlock = await app.inject({ method: "POST", url: "/api/app-lock/unlock", payload: { secret: "wrong-pin" } });
    assert.equal(unlock.statusCode, 401, "unlock 可达（验证 PIN 失败是 401，不是 423 门禁）");

    const login = await app.inject({ method: "POST", url: "/api/app-lock/webauthn/login/start", payload: {} });
    assert.notEqual(login.statusCode, 423, "生物识别登录流程可达");

    const setup = await app.inject({ method: "POST", url: "/api/app-lock/setup", payload: { secret: "112233" } });
    assert.equal(setup.statusCode, 409, "setup 可达（已配置 409，不是 423 门禁）");

    // 静态资源 / SPA fallback / 未知路径不走 API 门禁
    const page = await app.inject({ method: "GET", url: "/no/such/page" });
    assert.equal(page.statusCode, 404, "非 API 路径不受锁屏门禁");
  });
});
