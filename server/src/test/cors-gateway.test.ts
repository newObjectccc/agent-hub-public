/**
 * 网关安全测试（审计 P0/P2）：
 * 1. CORS 不反射任意 Origin：同源放行、跨域只认 config.allowOrigins 白名单（默认拒绝一切跨域）
 * 2. /api/live 收紧：token 非空必须 Bearer 匹配；无共享密钥仅限本机回环（防伪造消息注入）
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, type HubConfig } from "../config.js";
import { createApp } from "../index.js";
import type { LiveIngestLike } from "../live.js";
import type { SessionHubLike } from "../routes.js";
import type { MessageDto, SearchResultDto, SessionListItem, SessionTreeDto, SystemInfo } from "../types.js";
import { makeFakeDashboard } from "./fakeDashboard.js";
import { fakeUnlockedAppLock } from "./fakeAppLock.js";

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
  claude: { available: false, version: null },
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
    prompt: async () => ({ accepted: true, mode: "prompt" }),
    abort: async () => undefined,
    compact: async () => undefined,
  };
}

const fakeLive: LiveIngestLike = { ingest: () => ({ accepted: 1 }) };

async function makeApp(config: Partial<HubConfig> = {}) {
  return createApp({
    hub: makeFakeHub(),
    kpi: { getCards: () => [] },
    dashboard: makeFakeDashboard(),
    config: { ...DEFAULT_CONFIG, ...config } as HubConfig,
    systemInfo: async () => systemFixture,
    webRoot: null,
    appLock: fakeUnlockedAppLock(),
    live: fakeLive,
  });
}

describe("CORS：不反射任意 Origin（P0）", () => {
  it("同源请求放行并反射自身；无 Origin（curl/同源导航）正常", async () => {
    const app = await makeApp();
    try {
      const same = await app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: { host: "panel.local:7700", origin: "http://panel.local:7700" },
      });
      assert.equal(same.statusCode, 200);
      assert.equal(same.headers["access-control-allow-origin"], "http://panel.local:7700", "同源反射自身");

      const noOrigin = await app.inject({ method: "GET", url: "/api/sessions" });
      assert.equal(noOrigin.statusCode, 200);
    } finally {
      await app.close();
    }
  });

  it("跨域请求默认全部拒绝（403 信封 + 不发 ACAO），恶意网页读不了会话也发不了 prompt", async () => {
    const app = await makeApp();
    try {
      const read = await app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: { host: "panel.local:7700", origin: "https://evil.example" },
      });
      assert.equal(read.statusCode, 403);
      assert.equal((read.json() as { error: { code: string } }).error.code, "UNAUTHORIZED");
      assert.equal(read.headers["access-control-allow-origin"], undefined, "绝不反射恶意 Origin");

      const write = await app.inject({
        method: "POST",
        url: "/api/sessions/sess-1/prompt",
        headers: { host: "panel.local:7700", origin: "https://evil.example" },
        payload: { text: "exfiltrate everything" },
      });
      assert.equal(write.statusCode, 403, "跨域发 prompt 必须拒绝");

      // preflight 同样被拒（不发 ACAO，浏览器拦截）
      const preflight = await app.inject({
        method: "OPTIONS",
        url: "/api/sessions",
        headers: {
          host: "panel.local:7700",
          origin: "https://evil.example",
          "access-control-request-method": "GET",
        },
      });
      assert.notEqual(preflight.statusCode, 204, "恶意 preflight 不得按 CORS 放行");
      assert.equal(preflight.headers["access-control-allow-origin"], undefined);
    } finally {
      await app.close();
    }
  });

  it("config.allowOrigins 白名单精确放行（第三方契约消费），白名单外仍拒绝", async () => {
    const app = await makeApp({ allowOrigins: ["https://app.example.com"] });
    try {
      const allowed = await app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: { host: "panel.local:7700", origin: "https://app.example.com" },
      });
      assert.equal(allowed.statusCode, 200);
      assert.equal(allowed.headers["access-control-allow-origin"], "https://app.example.com");

      const preflight = await app.inject({
        method: "OPTIONS",
        url: "/api/sessions",
        headers: {
          host: "panel.local:7700",
          origin: "https://app.example.com",
          "access-control-request-method": "GET",
        },
      });
      assert.equal(preflight.statusCode, 204);
      assert.equal(preflight.headers["access-control-allow-origin"], "https://app.example.com");

      const other = await app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: { host: "panel.local:7700", origin: "https://other.example.com" },
      });
      assert.equal(other.statusCode, 403, "白名单外拒绝");
    } finally {
      await app.close();
    }
  });
});

describe("/api/live 收紧：无共享密钥不得注入伪造消息（P2）", () => {
  it("token 非空：必须 Bearer 匹配（401 否则）", async () => {
    const app = await makeApp({ auth: { enabled: false, token: "s3cret" } });
    try {
      const noAuth = await app.inject({ method: "POST", url: "/api/live/sess-1", payload: {} });
      assert.equal(noAuth.statusCode, 401);
      const wrong = await app.inject({
        method: "POST",
        url: "/api/live/sess-1",
        headers: { authorization: "Bearer wrong" },
        payload: {},
      });
      assert.equal(wrong.statusCode, 401);
      const ok = await app.inject({
        method: "POST",
        url: "/api/live/sess-1",
        headers: { authorization: "Bearer s3cret" },
        payload: {},
      });
      assert.equal(ok.statusCode, 202);
    } finally {
      await app.close();
    }
  });

  it("token 为空：仅限本机回环；非回环来源一律 401", async () => {
    const app = await makeApp();
    try {
      const loopback = await app.inject({
        method: "POST",
        url: "/api/live/sess-1",
        remoteAddress: "127.0.0.1",
        payload: {},
      });
      assert.equal(loopback.statusCode, 202, "本机 pi 扩展推送不受影响");

      const lan = await app.inject({
        method: "POST",
        url: "/api/live/sess-1",
        remoteAddress: "192.168.1.50",
        payload: {},
      });
      assert.equal(lan.statusCode, 401, "局域网来源不得注入伪造 live 消息");
    } finally {
      await app.close();
    }
  });
});

describe("CORS：回环反代（tailscale serve）场景（真机踩坑：HTTPS 面板全量 403）", () => {
  it("回环反代带 X-Forwarded-Proto: https → 同源放行（协议降级不再误判跨域）", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: {
          origin: "https://hub.example.ts.net",
          host: "hub.example.ts.net",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "hub.example.ts.net",
        },
        remoteAddress: "127.0.0.1",
      });
      assert.notEqual(res.statusCode, 403, "反代后的 HTTPS 同源请求不得被判跨域");
    } finally {
      await app.close();
    }
  });

  it("非回环对端伪造转发头 → 仍拒绝（转发头信任边界不松动）", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: {
          origin: "https://hub.example.ts.net",
          host: "127.0.0.1:7700",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "hub.example.ts.net",
        },
        remoteAddress: "203.0.113.5",
      });
      assert.equal(res.statusCode, 403, "外部对端的转发头不可信，跨域防线保持");
    } finally {
      await app.close();
    }
  });
});

describe("CORS：转发头伪造防线（X-Forwarded-Host 不可信）", () => {
  it("恶意页伪造 X-Forwarded-Host 试图冒充同源 → 仍 403（Host 头才是信任根）", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: {
          origin: "https://evil.example.com",
          host: "127.0.0.1:7700",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "evil.example.com",
        },
        remoteAddress: "127.0.0.1",
      });
      assert.equal(res.statusCode, 403, "转发头不参与同源判定，伪造无效");
    } finally {
      await app.close();
    }
  });

  it("allowOrigins 的 hostname 进入 Host 白名单（自定义域名/隧道域名部署路径）", async () => {
    const app = await makeApp({ allowOrigins: ["https://tunnel.example.com"] });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: { origin: "https://tunnel.example.com", host: "tunnel.example.com" },
      });
      assert.notEqual(res.statusCode, 403, "显式信任的域名放行");
    } finally {
      await app.close();
    }
  });
});
