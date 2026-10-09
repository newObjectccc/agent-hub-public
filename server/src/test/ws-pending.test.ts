/**
 * ws 连接建立期 pending 队列上限回归（OOM 审计 P2-5）：
 * findSession 解析完成前到达的消息进 pending——原实现无上界，握手前消息风暴可无限堆积。
 * 上限 WS_PENDING_MAX=100/连接，超出丢弃最旧（保最新，连接保持可用）。
 */
import { strict as assert } from "node:assert";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { WebSocket } from "ws";
import { DEFAULT_CONFIG } from "../config.js";
import type { DashboardServiceLike } from "../dashboard.js";
import { createApp } from "../index.js";
import type { SessionHub } from "../sessions/hub.js";
import type { SessionHubLike } from "../routes.js";
import type { MessageDto, SearchResultDto, SessionListItem, SessionTreeDto, SystemInfo } from "../types.js";
import { WsHub, WS_PENDING_MAX } from "../ws.js";
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
    }),
    listNotifications: async () => ({ notifications: [], unreadCount: 0 }),
    markAllRead: async () => undefined,
    markRead: async () => 0,
  };
}

interface PromptCall {
  text: unknown;
}

/** findSession 挂起（手放行）的 fake hub：复现「连接建立期」消息堆积窗口 */
async function startSlowServer() {
  const promptCalls: PromptCall[] = [];
  const resolvers: Array<(item: SessionListItem | null) => void> = [];
  const hub: SessionHubLike = {
    getStatus: () => "idle",
    listSessions: async () => [sessionFixture],
    findSession: () =>
      new Promise<SessionListItem | null>((resolve) => {
        resolvers.push(resolve);
      }),
    loadMessages: async (): Promise<MessageDto[]> => [],
    search: async (): Promise<SearchResultDto[]> => [],
    loadTree: async (): Promise<SessionTreeDto | null> => ({ entries: [], activePath: [] }),
    createSession: async () => sessionFixture,
    forkSession: async () => sessionFixture,
    prompt: async (_id: string, text: unknown) => {
      promptCalls.push({ text });
      return { accepted: true, mode: "prompt" };
    },
    abort: async () => undefined,
    compact: async () => undefined,
  };
  const app = await createApp({
    hub,
    kpi: { getCards: () => [] },
    dashboard: makeFakeDashboard(),
    config: { ...DEFAULT_CONFIG },
    systemInfo: async () => systemFixture,
    webRoot: null,
    appLock: fakeUnlockedAppLock(),
    logger: false,
  });
  const wshub = new WsHub();
  wshub.attach(app.server, hub as unknown as SessionHub);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return {
    app,
    wshub,
    promptCalls,
    url: `ws://127.0.0.1:${port}/ws/sessions/sess-1`,
    /** 放行最早的 findSession（握手完成） */
    releaseSession: () => {
      const resolve = resolvers.shift();
      resolve?.(sessionFixture);
    },
  };
}

describe("ws: 连接建立期 pending 队列上限（P2-5）", () => {
  it("握手前堆积超上限：只保留最近 WS_PENDING_MAX 条（丢最旧）", async () => {
    const srv = await startSlowServer();
    const ws = new WebSocket(srv.url);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      // findSession 未放行 → 全部进 pending；发 150 条（超上限 50%）
      const total = WS_PENDING_MAX + 50;
      for (let i = 0; i < total; i += 1) {
        ws.send(JSON.stringify({ type: "prompt", text: `m${i}`, mode: "prompt" }));
      }
      await new Promise((r) => setTimeout(r, 200)); // 确保服务端已全部收进 pending
      srv.releaseSession();
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(srv.promptCalls.length, WS_PENDING_MAX, `只处理 ${WS_PENDING_MAX} 条，实际 ${srv.promptCalls.length}`);
      // 丢最旧保最新：m50..m149
      assert.equal(srv.promptCalls[0].text, "m50", "最旧的被丢弃");
      assert.equal(srv.promptCalls[WS_PENDING_MAX - 1].text, `m${total - 1}`, "最新的保留");
    } finally {
      ws.terminate();
      srv.wshub.closeAll();
      await srv.app.close();
    }
  });

  it("边界：恰好 WS_PENDING_MAX 条一条不丢（上限只裁超出部分）", async () => {
    const srv = await startSlowServer();
    const ws = new WebSocket(srv.url);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      for (let i = 0; i < WS_PENDING_MAX; i += 1) {
        ws.send(JSON.stringify({ type: "prompt", text: `b${i}`, mode: "prompt" }));
      }
      await new Promise((r) => setTimeout(r, 200));
      srv.releaseSession();
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(srv.promptCalls.length, WS_PENDING_MAX, "恰好满队列不裁");
      assert.equal(srv.promptCalls[0].text, "b0", "队列内最旧的仍在");
    } finally {
      ws.terminate();
      srv.wshub.closeAll();
      await srv.app.close();
    }
  });

  it("边界：低于上限的正常握手消息照常全部处理（不误伤）", async () => {
    const srv = await startSlowServer();
    const ws = new WebSocket(srv.url);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      for (let i = 0; i < 3; i += 1) {
        ws.send(JSON.stringify({ type: "prompt", text: `c${i}`, mode: "prompt" }));
      }
      await new Promise((r) => setTimeout(r, 100));
      srv.releaseSession();
      await new Promise((r) => setTimeout(r, 300));
      assert.deepEqual(
        srv.promptCalls.map((c) => c.text),
        ["c0", "c1", "c2"],
      );
    } finally {
      ws.terminate();
      srv.wshub.closeAll();
      await srv.app.close();
    }
  });
});
