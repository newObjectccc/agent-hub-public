/**
 * WS 鉴权生产装配回归（修复：WS 鉴权未接线）：
 * 走 attachSessionWs（startHub 唯一 WS 挂载路径）+ createApp，验证 config.auth 派生的
 * upgrade 鉴权真的接上——auth.enabled 时无/错 token 401 断连，正确 token（Authorization / ?token=）可连。
 * 严禁绕过 attachSessionWs 直接 new WsHub().attach 传 auth（那测不出生产装配断裂——原 bug 即第 5 参漏传）。
 */
import { strict as assert } from "node:assert";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { WebSocket } from "ws";
import { DEFAULT_CONFIG, type HubConfig } from "../config.js";
import { emptySourceStats } from "../dashboard.js";
import type { DashboardServiceLike } from "../dashboard.js";
import { attachSessionWs, createApp } from "../index.js";
import type { SessionHubLike } from "../routes.js";
import type { MessageDto, SearchResultDto, SessionListItem, SessionTreeDto, SystemInfo } from "../types.js";
import { WsHub, type WsSessionHub } from "../ws.js";
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
    prompt: async () => ({ accepted: true, mode: "prompt" as const }),
    abort: async () => undefined,
    compact: async () => undefined,
  };
}

/** WS 侧 hub 结构（attachSessionWs 第 2 参）：会话存在即可连，不需要业务行为 */
const wsHubFixture: WsSessionHub = {
  isLive: () => false,
  findSession: async (id: string) => (id === "sess-1" ? sessionFixture : null),
  prompt: async () => ({ accepted: true, mode: "prompt" }),
  abort: async () => undefined,
};

function makeFakeDashboard(): DashboardServiceLike {
  return {
    getStats: async () => ({
      working: 0,
      needAttention: 0,
      todayDone: 0,
      todayMessages: 0,
      weekCommits: 0,
      streak: 0,
      weekMessages: 0,
      weekDone: 0,
      todayDoneSessions: [],
      workingSessions: [],
      attentionSessions: [],
      bySource: emptySourceStats(),
    }),
    listNotifications: async () => ({ notifications: [], unreadCount: 0 }),
    markAllRead: async () => undefined,
    markRead: async () => 0,
  };
}

/** 走生产装配函数挂载的 auth.enabled 服务：auth 即 config.auth（与 startHub 同源） */
async function startAuthedServer() {
  const config: HubConfig = { ...DEFAULT_CONFIG, auth: { enabled: true, token: "s3cret" } };
  const app = await createApp({
    hub: makeFakeHub(),
    kpi: { getCards: () => [] },
    dashboard: makeFakeDashboard(),
    config,
    systemInfo: async () => systemFixture,
    webRoot: null,
    appLock: fakeUnlockedAppLock(),
    logger: false,
  });
  const wshub = new WsHub();
  // 生产唯一挂载路径：promptGuard + upgrade 鉴权全部由 attachSessionWs 从 config/appLock 派生
  attachSessionWs(app.server, wsHubFixture, {
    wshub,
    config,
    appLock: fakeUnlockedAppLock(),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return { app, wshub, base: `ws://127.0.0.1:${port}` };
}

interface UpgradeResult {
  outcome: "open" | "denied" | "timeout";
  /** 拒连时服务端回的状态码（unexpected-response 到达时可见） */
  status?: number;
}

function tryOpen(url: string, opts?: { headers?: Record<string, string> }): Promise<UpgradeResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, opts);
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ outcome: "timeout" });
    }, 2000);
    ws.on("open", () => {
      clearTimeout(timer);
      ws.terminate();
      resolve({ outcome: "open" });
    });
    ws.on("error", () => {
      clearTimeout(timer);
      resolve({ outcome: "denied" });
    });
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      ws.terminate();
      resolve({ outcome: "denied", status: res.statusCode });
    });
  });
}

describe("ws 鉴权生产装配：attachSessionWs 派生 config.auth（回归：第 5 参漏传绕过鉴权）", () => {
  it("无 token / 错 token：会话与全局通道一律 401 断连", async () => {
    const { app, wshub, base } = await startAuthedServer();
    try {
      const cases: Array<[string, string]> = [
        [`${base}/ws/sessions/sess-1`, "会话通道无 token"],
        [`${base}/ws/sessions/sess-1?token=wrong`, "会话通道错 token"],
        [`${base}/ws/events`, "全局通道无 token"],
        [`${base}/ws/events?token=wrong`, "全局通道错 token"],
      ];
      for (const [url, label] of cases) {
        const r = await tryOpen(url);
        assert.equal(r.outcome, "denied", `${label} 必须拒连`);
        assert.ok(r.status === undefined || r.status === 401, `${label} 应 401 断连，实际 status=${String(r.status)}`);
      }
      const headerWrong = await tryOpen(`${base}/ws/sessions/sess-1`, { headers: { authorization: "Bearer wrong" } });
      assert.equal(headerWrong.outcome, "denied", "Authorization 错 token 必须拒连");
    } finally {
      wshub.closeAll();
      await app.close();
    }
  });

  it("正确 token：Authorization / ?token= 任一通道可连（握手确认可达）", async () => {
    const { app, wshub, base } = await startAuthedServer();
    try {
      assert.deepEqual(await tryOpen(`${base}/ws/sessions/sess-1?token=s3cret`), { outcome: "open" }, "query ?token= 放行");
      assert.deepEqual(
        await tryOpen(`${base}/ws/sessions/sess-1`, { headers: { authorization: "Bearer s3cret" } }),
        { outcome: "open" },
        "Authorization: Bearer 放行",
      );
      assert.deepEqual(await tryOpen(`${base}/ws/events?token=s3cret`), { outcome: "open" }, "全局通道带 token 放行");
    } finally {
      wshub.closeAll();
      await app.close();
    }
  });

  it("auth 未启用（enabled:false 显式传入）：无 token 照常连接（默认行为不变）", async () => {
    const config: HubConfig = { ...DEFAULT_CONFIG, auth: { enabled: false, token: "" } };
    const app = await createApp({
      hub: makeFakeHub(),
      kpi: { getCards: () => [] },
      dashboard: makeFakeDashboard(),
      config,
      systemInfo: async () => systemFixture,
      webRoot: null,
      appLock: fakeUnlockedAppLock(),
      logger: false,
    });
    const wshub = new WsHub();
    attachSessionWs(app.server, wsHubFixture, { wshub, config, appLock: fakeUnlockedAppLock() });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    try {
      assert.deepEqual(await tryOpen(`ws://127.0.0.1:${port}/ws/sessions/sess-1`), { outcome: "open" });
    } finally {
      wshub.closeAll();
      await app.close();
    }
  });
});

describe("ws Origin 跨站闸生产装配：attachSessionWs 从 config 派生（与 HTTP CORS 闸同源同逻辑）", () => {
  /** 生产装配服务：origin 闸由 attachSessionWs 用 config 派生（不许直连 attach 传回调——测不出装配断裂） */
  async function startOriginServer(overrides?: {
    allowOrigins?: string[];
    auth?: { enabled: boolean; token: string };
  }) {
    const config: HubConfig = {
      ...DEFAULT_CONFIG,
      allowOrigins: overrides?.allowOrigins ?? [],
      auth: overrides?.auth ?? { enabled: false, token: "" },
    };
    const app = await createApp({
      hub: makeFakeHub(),
      kpi: { getCards: () => [] },
      dashboard: makeFakeDashboard(),
      config,
      systemInfo: async () => systemFixture,
      webRoot: null,
      appLock: fakeUnlockedAppLock(),
      logger: false,
    });
    const wshub = new WsHub();
    attachSessionWs(app.server, wsHubFixture, { wshub, config, appLock: fakeUnlockedAppLock() });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    return { app, wshub, base: `ws://127.0.0.1:${port}`, httpBase: `http://127.0.0.1:${port}` };
  }

  function assertDenied(r: UpgradeResult, label: string, status: number = 403): void {
    assert.equal(r.outcome, "denied", `${label} 必须拒连`);
    // 闸写原始状态行 + destroy：客户端可能走 unexpected-response（带 status）或裸 error（无 status）
    assert.ok(r.status === undefined || r.status === status, `${label} 应 ${status} 断连，实际 status=${String(r.status)}`);
  }

  it("非法 Origin（恶意网页跨站）：会话与全局通道 upgrade 一律 403 断连（默认配置 auth 关闭也拦）", async () => {
    const { app, wshub, base } = await startOriginServer();
    try {
      for (const [url, label] of [
        [`${base}/ws/sessions/sess-1`, "会话通道"],
        [`${base}/ws/events`, "全局通道"],
      ] as Array<[string, string]>) {
        const r = await tryOpen(url, { headers: { origin: "https://evil.example" } });
        assertDenied(r, `${label} 非法 Origin`);
      }
    } finally {
      wshub.closeAll();
      await app.close();
    }
  });

  it("无 Origin 头（非浏览器客户端：node ws / curl / 自动化）：照常连接（维持 token 判定，不破坏自动化）", async () => {
    const { app, wshub, base } = await startOriginServer();
    try {
      assert.deepEqual(await tryOpen(`${base}/ws/sessions/sess-1`), { outcome: "open" }, "无 Origin 放行");
      assert.deepEqual(await tryOpen(`${base}/ws/events`), { outcome: "open" }, "全局通道无 Origin 放行");
    } finally {
      wshub.closeAll();
      await app.close();
    }
  });

  it("同源 Origin / allowOrigins 白名单 Origin：放行", async () => {
    const { app, wshub, base, httpBase } = await startOriginServer({ allowOrigins: ["https://app.example.com"] });
    try {
      assert.deepEqual(
        await tryOpen(`${base}/ws/sessions/sess-1`, { headers: { origin: httpBase } }),
        { outcome: "open" },
        "同源 Origin（面板与 API 同源部署）放行",
      );
      assert.deepEqual(
        await tryOpen(`${base}/ws/sessions/sess-1`, { headers: { origin: "https://app.example.com" } }),
        { outcome: "open" },
        "allowOrigins 白名单精确匹配放行",
      );
      assert.deepEqual(
        await tryOpen(`${base}/ws/events`, { headers: { origin: "https://app.example.com" } }),
        { outcome: "open" },
        "全局通道白名单 Origin 放行",
      );
      // 白名单外仍拒（白名单不等于反射任意 Origin）
      assertDenied(
        await tryOpen(`${base}/ws/sessions/sess-1`, { headers: { origin: "https://other.example.com" } }),
        "白名单外跨站 Origin",
      );
    } finally {
      wshub.closeAll();
      await app.close();
    }
  });

  it("鉴权与 Origin 是 AND 关系：token 合法但 Origin 非法仍拒；Origin 合法但 token 缺失仍拒", async () => {
    const { app, wshub, base, httpBase } = await startOriginServer({
      allowOrigins: ["https://app.example.com"],
      auth: { enabled: true, token: "s3cret" },
    });
    try {
      assertDenied(
        await tryOpen(`${base}/ws/sessions/sess-1?token=s3cret`, { headers: { origin: "https://evil.example" } }),
        "token 合法 + 非法 Origin",
      );
      assertDenied(
        await tryOpen(`${base}/ws/sessions/sess-1`, { headers: { origin: httpBase } }),
        "Origin 合法 + 无 token",
        401,
      );
      // 双条件都过才连（AND 全通过基线）
      assert.deepEqual(
        await tryOpen(`${base}/ws/sessions/sess-1?token=s3cret`, { headers: { origin: httpBase } }),
        { outcome: "open" },
        "token + 同源 Origin 双通过",
      );
      assert.deepEqual(
        await tryOpen(`${base}/ws/sessions/sess-1?token=s3cret`, { headers: { origin: "https://app.example.com" } }),
        { outcome: "open" },
        "token + 白名单 Origin 双通过",
      );
    } finally {
      wshub.closeAll();
      await app.close();
    }
  });
});
