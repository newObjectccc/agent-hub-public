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
import { createApp } from "../index.js";
import type { SessionHub } from "../sessions/hub.js";
import type { SessionHubLike } from "../routes.js";
import type { MessageDto, SessionListItem, SystemInfo } from "../types.js";
import { WsHub } from "../ws.js";

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
};

const systemFixture: SystemInfo = {
  platform: "darwin",
  pi: { available: true, version: "0.87.1" },
  tmux: { available: false, version: null },
  ttyd: { available: false, version: null },
  tailscale: { available: false, version: null, loggedIn: false, hostname: null },
  sessionDir: "/tmp/sessions",
  workspaceRoot: "/tmp/ws",
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
    createSession: async () => sessionFixture,
    prompt: async (_id: string, text: unknown, mode: unknown) => {
      promptCalls.push({ text, mode });
      return { accepted: true, mode: "prompt" };
    },
    abort: async () => undefined,
    compact: async () => undefined,
  };
}

async function startServer(promptCalls: PromptCall[]) {
  const app = await createApp({
    hub: makeFakeHub(promptCalls),
    kpi: { getCards: () => [] },
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
