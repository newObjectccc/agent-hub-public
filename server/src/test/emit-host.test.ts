/**
 * P2 加固回归（server 稳健/安全批）：
 * 1. emit 同步链隔离（createEventEmitter）：通知聚合 / WS 广播 / 子代理路由单路抛错不影响其他路
 * 2. DNS rebinding 防护（isAllowedHostHeader + createApp onRequest / upgrade 把关，非法 Host 403）
 */
import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { DEFAULT_CONFIG } from "../config.js";
import { createApp, createEventEmitter, isAllowedHostHeader, serializeReqForLog } from "../index.js";
import type { SessionHubLike } from "../routes.js";
import type { MessageDto, ServerEvent, SessionListItem, SystemInfo } from "../types.js";
import { makeFakeDashboard } from "./fakeDashboard.js";
import { fakeUnlockedAppLock } from "./fakeAppLock.js";

const sessionFixture: SessionListItem = {
  id: "sess-1",
  name: null,
  cwd: "/tmp/demo",
  updatedAt: "2026-02-18T12:00:00.000Z",
  messageCount: 0,
  status: "idle",
  lastUserMessage: null,
  lastAssistantMessage: null,
  sessionFile: "/tmp/demo.jsonl",
  source: "pi",
  isSubAgent: false,
};

const systemFixture: SystemInfo = {
  platform: "darwin",
  pi: { available: true, version: "0.87.1" },
  tmux: { available: false, version: null },
  ttyd: { available: false, version: null },
  tailscale: { available: false, version: null, loggedIn: false, hostname: null },
  sessionDir: "/tmp/sessions",
  workspaceRoot: "/tmp/ws",
  claude: { available: false, version: null },
  metrics: null,
};

const fakeHub: SessionHubLike = {
  getStatus: () => "idle",
  listSessions: async () => [sessionFixture],
  findSession: async () => sessionFixture,
  loadMessages: async (): Promise<MessageDto[]> => [],
  createSession: async () => sessionFixture,
  forkSession: async () => sessionFixture,
  prompt: async () => ({ accepted: true, mode: "prompt" }),
  abort: async () => undefined,
  compact: async () => undefined,
  search: async () => [],
  loadTree: async () => null,
};

/* ============ 1. emit 同步链隔离 ============ */

describe("日志脱敏: serializeReqForLog（终端 token 不进访问日志）", () => {
  it("`?t=` / token 查询值替换为 [REDACTED]，其余字段保留", () => {
    const out = serializeReqForLog({
      method: "GET",
      url: "/terminal/?t=SECRETTOKEN&page=2",
      hostname: "localhost",
      ip: "127.0.0.1",
    });
    assert.equal(out.url, "/terminal/?t=[REDACTED]&page=2");
    assert.equal(JSON.stringify(out).includes("SECRETTOKEN"), false, "token 不得出现在日志序列化输出");
    assert.equal(out.method, "GET");
    assert.equal(out.hostname, "localhost");
    assert.equal(out.remoteAddress, "127.0.0.1");
  });
});

describe("emit: 同步链单路失败不影响其他路（P2）", () => {
  const statusEvent: ServerEvent = { type: "status", status: "running" };
  const textEvent: ServerEvent = { type: "agent_settled" };

  it("recordEvent 抛错：WS 广播 / 全局广播 / 子代理路由照常", () => {
    const calls: string[] = [];
    const emit = createEventEmitter(
      {
        recordEvent: () => {
          throw new Error("dashboard boom");
        },
        broadcast: (id) => calls.push(`broadcast:${id}`),
        broadcastGlobal: (ev) => calls.push(`global:${String(ev.type)}`),
        route: (id) => {
          calls.push(`route:${id}`);
          return null;
        },
      },
      (where) => calls.push(`err:${where}`),
    );
    emit("sess-1", statusEvent);
    assert.deepEqual(calls, [
      "err:recordEvent",
      "global:session_status",
      "broadcast:sess-1",
      "route:sess-1",
    ]);
  });

  it("broadcastGlobal / broadcast / route 各自抛错互不牵连，其余路照常", () => {
    const calls: string[] = [];
    const emit = createEventEmitter(
      {
        recordEvent: (id) => calls.push(`record:${id}`),
        broadcast: (id) => calls.push(`broadcast:${id}`),
        broadcastGlobal: () => {
          throw new Error("global boom");
        },
        route: () => {
          throw new Error("route boom");
        },
      },
      (where) => calls.push(`err:${where}`),
    );
    emit("sess-1", statusEvent);
    assert.deepEqual(calls, ["record:sess-1", "err:broadcastGlobal", "broadcast:sess-1", "err:route"]);
    // 非 status 事件不触发全局广播；路由成功时补投父会话通道
    calls.length = 0;
    const emit2 = createEventEmitter(
      {
        recordEvent: (id) => calls.push(`record:${id}`),
        broadcast: (id) => calls.push(`broadcast:${id}`),
        broadcastGlobal: () => calls.push("global"),
        route: (id) => {
          calls.push(`route:${id}`);
          return { parentSessionId: "parent-1", event: textEvent };
        },
      },
      (where) => calls.push(`err:${where}`),
    );
    emit2("sub-1", textEvent);
    assert.deepEqual(calls, ["record:sub-1", "broadcast:sub-1", "route:sub-1", "broadcast:parent-1"]);
  });
});

/* ============ 2. DNS rebinding Host 校验 ============ */

describe("host gate: isAllowedHostHeader（DNS rebinding 防护）", () => {
  it("localhost / 回环 / 局域网 IP / IPv6 字面量放行（直连方式不受影响）", () => {
    assert.equal(isAllowedHostHeader("localhost:7700"), true);
    assert.equal(isAllowedHostHeader("LOCALHOST"), true);
    assert.equal(isAllowedHostHeader("sub.localhost:7700"), true);
    assert.equal(isAllowedHostHeader("127.0.0.1:7700"), true);
    assert.equal(isAllowedHostHeader("192.168.1.10:7700"), true);
    assert.equal(isAllowedHostHeader("10.0.0.5"), true);
    assert.equal(isAllowedHostHeader("[::1]:7700"), true);
    assert.equal(isAllowedHostHeader("[fe80::1]:7700"), true);
  });

  it("Tailscale ts.net / mDNS .local 域名放行（不破坏 MagicDNS / 局域网设备名访问）", () => {
    assert.equal(isAllowedHostHeader("my-mac.tailnet-1234.ts.net:7700"), true);
    assert.equal(isAllowedHostHeader("panel.local:7700"), true);
  });

  it("任意外部域名拒绝（rebinding 攻击面）；非法/缺失 Host 拒绝", () => {
    assert.equal(isAllowedHostHeader("evil.example:7700"), false);
    assert.equal(isAllowedHostHeader("attacker.com"), false);
    assert.equal(isAllowedHostHeader("evil.example@localhost:7700"), false);
    assert.equal(isAllowedHostHeader(""), false);
    assert.equal(isAllowedHostHeader(undefined), false);
    assert.equal(isAllowedHostHeader("::1:7700"), false, "裸 IPv6（无括号）非法 Host 头拒绝");
  });

  it("绑定主机名 / extraHosts（allowOrigins 提取的 hostname）显式信任", () => {
    assert.equal(isAllowedHostHeader("hub.example.com:7700", { bindHost: "hub.example.com" }), true);
    assert.equal(isAllowedHostHeader("app.example.com:7700", { extraHosts: ["app.example.com"] }), true);
    assert.equal(isAllowedHostHeader("evil.example:7700", { extraHosts: ["app.example.com"] }), false);
  });
});

describe("host gate: createApp 全局 Host 校验（P2）", () => {
  let app: Awaited<ReturnType<typeof createApp>>;

  before(async () => {
    app = await createApp({
      dashboard: makeFakeDashboard(),
      hub: fakeHub,
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      webRoot: null,
      appLock: fakeUnlockedAppLock(),
    });
  });

  after(async () => {
    await app.close();
  });

  it("非法 Host（evil.example）→ 403 错误信封，不进业务路由", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/kpi",
      headers: { host: "evil.example:7700" },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "UNAUTHORIZED");
  });

  it("localhost / IP 字面量 / ts.net Host 正常访问", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/api/kpi" })).statusCode, 200);
    const ts = await app.inject({
      method: "GET",
      url: "/api/kpi",
      headers: { host: "my-mac.tailnet-1234.ts.net:7700" },
    });
    assert.equal(ts.statusCode, 200);
    const ip = await app.inject({
      method: "GET",
      url: "/api/kpi",
      headers: { host: "192.168.1.10:7700" },
    });
    assert.equal(ip.statusCode, 200);
  });
});
