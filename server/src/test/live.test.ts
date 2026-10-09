/**
 * POST /api/live/:sessionId（pi 扩展 live-feed 接入，契约 §6）测试：
 * 1. normalizeLiveEvents / coalesceDeltas 纯函数：事件映射、坏数据丢弃、delta 合并
 * 2. LiveIngest：节流、保序、onLive 回调、SDK 接管会话丢弃
 * 3. 路由 + fake WS：POST 的事件按契约广播到 /ws/sessions/:id 订阅者
 * 4. 共享密钥：auth.token 非空校验 Bearer，空则放行
 */
import { strict as assert } from "node:assert";
import { makeFakeDashboard } from "./fakeDashboard.js";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { WebSocket } from "ws";
import { DEFAULT_CONFIG } from "../config.js";
import { createApp } from "../index.js";
import { LiveIngest, coalesceDeltas, normalizeLiveEvents, type LiveIngestDeps } from "../live.js";
import type { SessionHubLike } from "../routes.js";
import type { SessionHub } from "../sessions/hub.js";
import type { MessageDto, ServerEvent, SessionListItem, SystemInfo } from "../types.js";
import { WsHub } from "../ws.js";
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

function makeFakeHub(): SessionHubLike {
  return {
    getStatus: () => "idle",
    listSessions: async () => [sessionFixture],
    findSession: async (id: string) => (id === "sess-1" ? sessionFixture : null),
    loadMessages: async (): Promise<MessageDto[]> => [],
    createSession: async () => sessionFixture,
    forkSession: async () => sessionFixture,
    prompt: async () => ({ accepted: true, mode: "prompt" as const }),
    abort: async () => undefined,
    compact: async () => undefined,
    search: async () => [],
    loadTree: async () => null,
  };
}

describe("live: normalizeLiveEvents 纯函数", () => {
  it("合法事件映射为契约 WS 事件（含 thinking_delta 与 message.thinking）", () => {
    const events = normalizeLiveEvents(
      {
        events: [
          { type: "message_start", message: { id: "live-1", role: "assistant", timestamp: 7 } },
          { type: "text_delta", messageId: "live-1", delta: "你好" },
          { type: "thinking_delta", messageId: "live-1", delta: "嗯…" },
          { type: "tool_start", messageId: "live-1", toolCall: { name: "bash", summary: "ls" } },
          {
            type: "tool_end",
            messageId: "live-1",
            toolCall: { name: "bash", summary: "ls", status: "done", resultPreview: "ok" },
          },
          {
            type: "message_end",
            message: { id: "live-1", role: "assistant", timestamp: 7, text: "你好", thinking: "嗯…", toolCalls: [] },
          },
          { type: "agent_settled" },
          { type: "status", status: "idle" },
        ],
      },
      123,
    );
    assert.equal(events.length, 8);
    assert.deepEqual(events[0], { type: "message_start", message: { id: "live-1", role: "assistant", timestamp: 7 } });
    assert.deepEqual(events[1], { type: "text_delta", messageId: "live-1", delta: "你好" });
    assert.deepEqual(events[2], { type: "thinking_delta", messageId: "live-1", delta: "嗯…" });
    assert.deepEqual(events[3], { type: "tool_start", messageId: "live-1", toolCall: { name: "bash", summary: "ls" } });
    assert.deepEqual(events[4], {
      type: "tool_end",
      messageId: "live-1",
      toolCall: { name: "bash", summary: "ls", status: "done", resultPreview: "ok" },
    });
    const end = events[5] as { type: string; message: Record<string, unknown> };
    assert.equal(end.type, "message_end");
    assert.equal(end.message.thinking, "嗯…");
    assert.deepEqual(events[6], { type: "agent_settled" });
    assert.deepEqual(events[7], { type: "status", status: "idle" });
  });

  it("坏数据静默丢弃：未知 type、缺字段、非法枚举、非数组形态", () => {
    const events = normalizeLiveEvents([
      { type: "evil_type" },
      { type: "text_delta", messageId: "m", delta: 42 },
      { type: "text_delta", delta: "x" },
      { type: "tool_end", messageId: "m", toolCall: { summary: "x" } },
      { type: "status", status: "weird" },
      { type: "message_end", message: { role: "assistant" } },
      null,
      "not-an-object",
    ]);
    assert.deepEqual(events, []);
    // 非事件数组/对象形态：不抛错、返回空
    assert.deepEqual(normalizeLiveEvents({ hello: "world" }), []);
    assert.deepEqual(normalizeLiveEvents("garbage"), []);
    // 单事件对象形态
    assert.deepEqual(normalizeLiveEvents({ type: "agent_settled" }), [{ type: "agent_settled" }]);
  });

  it("tool_end/tool_start 的 toolCall 字段补默认值（status 缺省 done、preview 缺省 null）", () => {
    const events = normalizeLiveEvents([{ type: "tool_end", messageId: "m", toolCall: { name: "read" } }]);
    assert.deepEqual(events, [
      { type: "tool_end", messageId: "m", toolCall: { name: "read", summary: "", status: "done", resultPreview: null } },
    ]);
  });
});

describe("live: coalesceDeltas 合并相邻 delta", () => {
  it("同 messageId 的相邻 delta 合并，不同 messageId / 非 delta 事件不合并", () => {
    const merged = coalesceDeltas([
      { type: "text_delta", messageId: "a", delta: "你" },
      { type: "text_delta", messageId: "a", delta: "好" },
      { type: "thinking_delta", messageId: "a", delta: "…" },
      { type: "text_delta", messageId: "b", delta: "x" },
      { type: "message_end", message: { id: "b", role: "assistant", timestamp: 1, text: "x", thinking: null, toolCalls: [] } },
      { type: "text_delta", messageId: "b", delta: "y" },
    ]);
    assert.deepEqual(merged, [
      { type: "text_delta", messageId: "a", delta: "你好" },
      { type: "thinking_delta", messageId: "a", delta: "…" },
      { type: "text_delta", messageId: "b", delta: "x" },
      { type: "message_end", message: { id: "b", role: "assistant", timestamp: 1, text: "x", thinking: null, toolCalls: [] } },
      { type: "text_delta", messageId: "b", delta: "y" },
    ]);
  });
});

describe("live: LiveIngest 节流与回调", () => {
  it("delta 节流合并广播；生命周期事件即时冲刷且保序；onLive 每批回调", () => {
    const emitted: Array<{ sessionId: string; event: ServerEvent }> = [];
    const liveCalls: string[] = [];
    const ingest = new LiveIngest({
      emit: (sessionId, event) => emitted.push({ sessionId, event }),
      onLive: (id) => liveCalls.push(id),
      throttleMs: 10_000, // 不依赖定时器：显式 flushSession 验证
    });

    ingest.ingest("s1", [
      { type: "message_start", message: { id: "live-1", role: "assistant", timestamp: 1 } },
      { type: "text_delta", messageId: "live-1", delta: "a" },
      { type: "text_delta", messageId: "live-1", delta: "b" },
    ]);
    // message_start 即时广播；两个 delta 还在节流窗口内（未广播）
    assert.equal(emitted.length, 1);
    assert.deepEqual(liveCalls, ["s1"]);

    ingest.flushSession("s1");
    assert.equal(emitted.length, 2);
    assert.deepEqual(emitted[1].event, { type: "text_delta", messageId: "live-1", delta: "ab" });

    // 后续批次：message_end 立即冲刷并保序（delta 在 message_end 前）
    ingest.ingest("s1", [
      { type: "text_delta", messageId: "live-1", delta: "c" },
      { type: "message_end", message: { id: "live-1", role: "assistant", timestamp: 1, text: "abc", thinking: null, toolCalls: [] } },
      { type: "agent_settled" },
    ]);
    assert.deepEqual(
      emitted.slice(2).map((e) => e.event.type),
      ["text_delta", "message_end", "agent_settled"],
    );
    assert.equal((emitted[2].event as { delta: string }).delta, "c");
    assert.deepEqual(liveCalls, ["s1", "s1"]);
  });

  it("SDK 接管中的会话丢弃 live 事件（防双推送）", () => {
    const emitted: ServerEvent[] = [];
    const ingest = new LiveIngest({
      emit: (_sid, event) => emitted.push(event),
      isSdkLive: (id) => id === "sdk-owned",
    });
    assert.deepEqual(ingest.ingest("sdk-owned", [{ type: "agent_settled" }]), { accepted: 0 });
    assert.equal(emitted.length, 0);
    assert.equal(ingest.ingest("other", [{ type: "agent_settled" }]).accepted, 1);
    assert.equal(emitted.length, 1);
  });
});

describe("live: POST /api/live/:sessionId → WS 广播（fake WS 断言）", () => {
  async function startLiveServer(deps: Partial<LiveIngestDeps>, token = "") {
    const wshub = new WsHub();
    const ingest = new LiveIngest({ emit: (sid, ev) => wshub.broadcast(sid, ev), ...deps });
    const app = await createApp({
      dashboard: makeFakeDashboard(),
      hub: makeFakeHub(),
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG, auth: { enabled: false, token } },
      systemInfo: async () => systemFixture,
      live: ingest,
      webRoot: null, appLock: fakeUnlockedAppLock(),
      logger: false,
    });
    wshub.attach(app.server, makeFakeHub() as unknown as SessionHub);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    return {
      app,
      wshub,
      ingest,
      base: `http://127.0.0.1:${port}`,
      wsUrl: `ws://127.0.0.1:${port}/ws/sessions/sess-1`,
    };
  }

  it("POST 事件按契约广播到 WS 订阅者（delta 合并、message.thinking 透传）", async () => {
    const liveCalls: string[] = [];
    const { app, wshub, base, wsUrl } = await startLiveServer({ onLive: (id) => liveCalls.push(id) });
    const ws = new WebSocket(wsUrl);
    const received: ServerEvent[] = [];
    try {
      // 先挂 message 监听再等 open：否则会漏掉握手 session 帧导致索引错位
      ws.on("message", (raw: Buffer) => {
        received.push(JSON.parse(raw.toString()) as ServerEvent);
      });
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });

      const res = await fetch(`${base}/api/live/sess-1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [
            { type: "message_start", message: { id: "live-1", role: "assistant", timestamp: 1 } },
            { type: "thinking_delta", messageId: "live-1", delta: "先" },
            { type: "thinking_delta", messageId: "live-1", delta: "想想" },
            { type: "text_delta", messageId: "live-1", delta: "答" },
            { type: "text_delta", messageId: "live-1", delta: "案" },
            {
              type: "message_end",
              message: { id: "live-1", role: "assistant", timestamp: 1, text: "答案", thinking: "先想想", toolCalls: [] },
            },
            { type: "agent_settled" },
          ],
        }),
      });
      assert.equal(res.status, 202);
      assert.deepEqual(await res.json(), { accepted: 7 });

      // 等广播到达（含握手 session 帧）
      await new Promise((r) => setTimeout(r, 300));
      const types = received.map((e) => e.type).filter((t) => t !== "session");
      assert.deepEqual(types, ["message_start", "thinking_delta", "text_delta", "message_end", "agent_settled"]);
      assert.deepEqual(received[2], { type: "thinking_delta", messageId: "live-1", delta: "先想想" });
      assert.deepEqual(received[3], { type: "text_delta", messageId: "live-1", delta: "答案" });
      const end = received[4] as unknown as { message: { thinking: string | null } };
      assert.equal(end.message.thinking, "先想想");
      // 首个 live 事件触发 onLive（停文件 tail 防双推送）
      assert.deepEqual(liveCalls, ["sess-1"]);
    } finally {
      ws.terminate();
      wshub.closeAll();
      await app.close();
    }
  });

  it("共享密钥：auth.token 非空校验 Bearer；空则放行", async () => {
    const locked = await startLiveServer({}, "s3cret");
    try {
      const noAuth = await fetch(`${locked.base}/api/live/sess-1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "agent_settled" }),
      });
      assert.equal(noAuth.status, 401);
      const bad = await fetch(`${locked.base}/api/live/sess-1`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer wrong" },
        body: JSON.stringify({ type: "agent_settled" }),
      });
      assert.equal(bad.status, 401);
      const ok = await fetch(`${locked.base}/api/live/sess-1`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer s3cret" },
        body: JSON.stringify({ type: "agent_settled" }),
      });
      assert.equal(ok.status, 202);
    } finally {
      locked.wshub.closeAll();
      await locked.app.close();
    }

    const open = await startLiveServer({});
    try {
      const anonymous = await fetch(`${open.base}/api/live/sess-1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "agent_settled" }),
      });
      assert.equal(anonymous.status, 202);
    } finally {
      open.wshub.closeAll();
      await open.app.close();
    }
  });
});

describe("live: 大量 delta 合并（OOM 审计 AC6）", () => {
  it("7 万段相邻 delta 分片收集后一次性 join：不栈溢出、不反复拷贝、结果一致", () => {
    const n = 70_000;
    const events: ServerEvent[] = [];
    for (let i = 0; i < n; i += 1) events.push({ type: "text_delta", messageId: "m1", delta: "x" });
    const merged = coalesceDeltas(events);
    assert.equal(merged.length, 1, "全部合并为一条");
    assert.equal((merged[0] as unknown as { delta: string }).delta.length, n, "拼接结果完整（7 万段一段不少）");
  });

  it("多组交替合并：分片 join 不改变合并语义（与逐段拼接逐字一致）", () => {
    const events: ServerEvent[] = [];
    for (let i = 0; i < 500; i += 1) {
      events.push({ type: "text_delta", messageId: "a", delta: String(i % 10) });
      if (i % 100 === 99) events.push({ type: "thinking_delta", messageId: "a", delta: "|" });
    }
    const merged = coalesceDeltas(events);
    assert.equal(merged.length, 10, "5 组 text + 5 条 thinking 交替：只有相邻同类型同 messageId 才合并");
    const group = Array.from({ length: 100 }, (_, i) => String(i % 10)).join("");
    assert.equal((merged[0] as unknown as { delta: string }).delta, group, "首组拼接逐字一致");
    assert.equal((merged[1] as unknown as { type: string }).type, "thinking_delta");
    assert.equal((merged[9] as unknown as { type: string }).type, "thinking_delta", "末条不与前组跨类型合并");
  });
});
