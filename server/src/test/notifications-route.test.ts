/**
 * 通知 API 路由测试：POST /api/notifications/read 单条/多条已读（body.ids）与全部已读，
 * 以及 GET /api/notifications 的 unreadCount 语义透传。
 */
import { makeFakeDashboard } from "./fakeDashboard.js";
import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { DEFAULT_CONFIG } from "../config.js";
import { createApp } from "../index.js";
import type { SessionHubLike } from "../routes.js";
import type { MessageDto, NotificationItem, SearchResultDto, SessionListItem, SessionTreeDto, SystemInfo } from "../types.js";
import type { PromptResult } from "../sessions/hub.js";
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
  claude: { available: true, version: "2.1.267" },
  tmux: { available: false, version: null },
  ttyd: { available: false, version: null },
  tailscale: { available: false, version: null, loggedIn: false, hostname: null },
  sessionDir: "/tmp/sessions",
  workspaceRoot: "/tmp/ws",
  metrics: {
    cpu: { usagePercent: 12.5, cores: 8 },
    memory: { usedBytes: 1024, totalBytes: 2048, usagePercent: 50 },
    disk: { usedBytes: 100, totalBytes: 200, usagePercent: 50, mount: "/" },
    loadavg: [1, 1, 1],
    uptimeSeconds: 3600,
    sampledAt: "2026-02-18T12:00:00.000Z",
  },
};

function makeFakeHub(): SessionHubLike {
  const promptResult: PromptResult = { accepted: true, mode: "prompt" };
  return {
    getStatus: () => "idle",
    listSessions: async () => [sessionFixture],
    findSession: async (id: string) => (id === "sess-1" ? sessionFixture : null),
    loadMessages: async (): Promise<MessageDto[]> => [],
    search: async (): Promise<SearchResultDto[]> => [],
    loadTree: async (): Promise<SessionTreeDto | null> => null,
    createSession: async () => sessionFixture,
    forkSession: async () => sessionFixture,
    prompt: async () => promptResult,
    abort: async () => undefined,
    compact: async () => undefined,
  };
}

const notifFixture = (over: Partial<NotificationItem>): NotificationItem => ({
  id: "n-1",
  sessionId: "s-1",
  sessionName: null,
  kind: "settled",
  text: "已完成：修复构建",
  timestamp: "2026-02-18T11:00:00.000Z",
  read: false,
  ...over,
});

describe("POST /api/notifications/read（单条/多条/全部已读）", () => {
  let app: FastifyInstance;
  let markReadCalls: Array<string[] | undefined>;

  before(async () => {
    markReadCalls = [];
    app = await createApp({
      hub: makeFakeHub(),
      kpi: { getCards: () => [] },
      dashboard: makeFakeDashboard({
        listNotifications: async () => ({
          notifications: [notifFixture({ id: "n-1" }), notifFixture({ id: "n-2", read: true })],
          unreadCount: 1,
        }),
        markRead: async (ids?: string[]) => {
          markReadCalls.push(ids);
          return ids === undefined ? 0 : 1;
        },
      }),
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      webRoot: null, appLock: fakeUnlockedAppLock(),
      logger: false,
    });
  });
  after(async () => {
    await app.close();
  });

  it("body.ids 单条已读 → markRead([id])，返回剩余未读数", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/read",
      payload: { ids: ["n-1"] },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, unreadCount: 1 });
    assert.deepEqual(markReadCalls.at(-1), ["n-1"]);
  });

  it("body.ids 多条已读", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/read",
      payload: { ids: ["n-1", "n-2"] },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(markReadCalls.at(-1), ["n-1", "n-2"]);
  });

  it("空 body = 全部已读（向后兼容），未读清零", async () => {
    const res = await app.inject({ method: "POST", url: "/api/notifications/read", payload: {} });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, unreadCount: 0 });
    assert.equal(markReadCalls.at(-1), undefined);
  });

  it("ids 非法（非字符串数组）→ 400 统一错误信封", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/read",
      payload: { ids: "n-1" },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error: { code: string } };
    assert.equal(body.error.code, "INVALID_REQUEST");
  });

  it("GET /api/notifications 返回列表 + unreadCount", async () => {
    const res = await app.inject({ method: "GET", url: "/api/notifications" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { notifications: NotificationItem[]; unreadCount: number };
    assert.equal(body.notifications.length, 2);
    assert.equal(body.unreadCount, 1);
  });
});
