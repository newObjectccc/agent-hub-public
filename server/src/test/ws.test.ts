/**
 * WS 运行期缺陷回归测试：
 * 1. 握手竞态：连接后立即发送的消息（ping/prompt）不得静默丢失（pending 队列兜底）
 * 2. 关闭不挂起：有活跃 WS 客户端时 closeAll + app.close 快速返回（SIGINT 场景）
 */
import { strict as assert } from "node:assert";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { WebSocket } from "ws";
import { DEFAULT_CONFIG } from "../config.js";
import type { DashboardServiceLike } from "../dashboard.js";
import { createApp } from "../index.js";
import type { SessionHub } from "../sessions/hub.js";
import type { SessionTailManager } from "../sessions/tail.js";
import type { SessionHubLike } from "../routes.js";
import type { MessageDto, SearchResultDto, SessionListItem, SessionTreeDto, SystemInfo } from "../types.js";
import { WsHub } from "../ws.js";

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

interface PromptCall {
  text: unknown;
  mode: unknown;
}

function makeFakeHub(promptCalls: PromptCall[]): SessionHubLike {
  return {
    getStatus: () => "idle",
    listSessions: async () => [sessionFixture],
    findSession: async (id: string) => (id === "sess-1" ? sessionFixture : null),
    loadMessages: async (): Promise<MessageDto[]> => [],
    search: async (): Promise<SearchResultDto[]> => [],
    loadTree: async (): Promise<SessionTreeDto | null> => ({ entries: [], activePath: [] }),
    createSession: async () => sessionFixture,
    forkSession: async () => sessionFixture,
    prompt: async (_id: string, text: unknown, mode: unknown) => {
      promptCalls.push({ text, mode });
      return { accepted: true, mode: "prompt" };
    },
    abort: async () => undefined,
    compact: async () => undefined,
  };
}

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

async function startServer(promptCalls: PromptCall[]) {
  const app = await createApp({
    hub: makeFakeHub(promptCalls),
    kpi: { getCards: () => [] },
    dashboard: makeFakeDashboard(),
    config: { ...DEFAULT_CONFIG },
    systemInfo: async () => systemFixture,
    webRoot: null,
    logger: false,
  });
  const wshub = new WsHub();
  wshub.attach(app.server, makeFakeHub(promptCalls) as unknown as SessionHub);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return { app, wshub, url: `ws://127.0.0.1:${port}/ws/sessions/sess-1` };
}

describe("ws: 握手竞态——连接即发的消息不丢", () => {
  it("open 后立即发 ping 必收 pong，立即发 prompt 不被丢弃", async () => {
    const promptCalls: PromptCall[] = [];
    const { app, wshub, url } = await startServer(promptCalls);
    const ws = new WebSocket(url);
    try {
      // 不等握手事件缓冲，open 后立刻连发两条（复现验收实测的丢消息时序）
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "ping" }));
        ws.send(JSON.stringify({ type: "prompt", text: "hello", mode: "prompt" }));
      });
      const events: Array<{ type?: string }> = [];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("5s 内未收到 pong（消息被丢弃）")), 5000);
        ws.on("message", (raw: Buffer) => {
          const ev = JSON.parse(raw.toString()) as { type?: string };
          events.push(ev);
          if (ev.type === "pong") {
            clearTimeout(timer);
            resolve();
          }
        });
        ws.on("error", reject);
      });
      // ping 的 pong 必达
      assert.ok(events.some((e) => e.type === "pong"));
      // prompt 也必须被处理（pending 队列消费）——给 handleClientMessage 一拍
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(promptCalls.length, 1);
      assert.equal(promptCalls[0].text, "hello");
    } finally {
      ws.terminate();
      wshub.closeAll();
      await app.close();
    }
  });
});

describe("ws: 关闭不挂起（SIGINT 场景）", () => {
  it("有活跃 WS 客户端时 closeAll + app.close 在 2 秒内完成", async () => {
    const promptCalls: PromptCall[] = [];
    const { app, wshub, url } = await startServer(promptCalls);
    const ws = new WebSocket(url);
    try {
      // 等握手完成、连接进入 clients map（证明是“活跃连接”）
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      await new Promise((r) => setTimeout(r, 100));
      const startedAt = Date.now();
      wshub.closeAll();
      await app.close();
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 2000, `关闭耗时 ${elapsed}ms，超过 2000ms 上限`);
    } finally {
      ws.terminate();
    }
  });
});

describe("ws: 子代理 childTails acquire/release 严格配对（AC8 回归）", () => {
  it("子会话消失 release 一次；连接关闭不二次 release（不误减其它连接同 id tail 的 ref）", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const childA: SessionListItem = { ...sessionFixture, id: "child-a", sessionFile: "/tmp/child-a.jsonl" };
    const childB: SessionListItem = { ...sessionFixture, id: "child-b", sessionFile: "/tmp/child-b.jsonl" };
    let children: SessionListItem[] = [childA];
    const acquires = new Map<string, number>();
    const releases = new Map<string, number>();
    const count = (m: Map<string, number>, id: string): void => {
      m.set(id, (m.get(id) ?? 0) + 1);
    };
    const fakeTails = {
      acquire: (id: string) => count(acquires, id),
      release: (id: string) => count(releases, id),
      detach: () => undefined,
      stopAll: () => undefined,
    };
    const hub = {
      ...makeFakeHub([]),
      isLive: () => false,
      listChildren: async () => children,
    };
    const app = await createApp({
      hub: hub as unknown as SessionHubLike,
      kpi: { getCards: () => [] },
      dashboard: makeFakeDashboard(),
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      webRoot: null,
      logger: false,
    });
    const wshub = new WsHub();
    wshub.childScanMs = 50; // 测试注入短扫描间隔
    wshub.attach(app.server, hub as unknown as SessionHub, fakeTails as unknown as SessionTailManager);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/sess-1`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      await sleep(250); // 首轮 syncChildren：发现 child-a
      assert.equal(acquires.get("child-a"), 1, "发现子会话即 acquire");

      children = []; // 子会话消失 → release 一次（同步移除追踪）
      await sleep(250);
      assert.equal(releases.get("child-a") ?? 0, 1, "消失时 release 恰一次");

      children = [childB]; // 新子会话 → 重新 acquire
      await sleep(250);
      assert.equal(acquires.get("child-b"), 1);

      ws.terminate(); // 连接关闭：cleanup 只 release 仍在追踪的
      await sleep(250);
      assert.equal(releases.get("child-a"), 1, "child-a 消失时已 release，cleanup 不得二次 release（误减其它连接的 ref）");
      assert.equal(releases.get("child-b"), 1, "仍在追踪的 child-b 由 cleanup 释放");
      assert.equal(releases.get("sess-1"), 1, "父会话 tail 释放");
      for (const id of ["child-a", "child-b", "sess-1"]) {
        assert.equal(acquires.get(id), releases.get(id), `${id} acquire/release 严格配对`);
      }
    } finally {
      ws.terminate();
      wshub.closeAll();
      await app.close();
    }
  });
});
