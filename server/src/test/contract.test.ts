/**
 * 契约级测试（前端补充需求）：
 * 1. SPA history fallback：非 /api、/ws 的 GET 未命中静态 → index.html（/s/:id 刷新不 404）
 * 2. 409 错误体严格 {error:{code:"SESSION_BUSY",message}}
 * 3. WS 事件 type 集合与字段名严格按 docs/API_CONTRACT.md §4 表格
 */
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DEFAULT_CONFIG, type HubConfig } from "../config.js";
import { createApp } from "../index.js";
import type { SessionHubLike } from "../routes.js";
import { SessionHub } from "../sessions/hub.js";
import type { PromptResult } from "../sessions/hub.js";
import type { MessageDto, ServerEvent, SessionListItem, SystemInfo } from "../types.js";

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
};

function makeFakeHub(promptResult: PromptResult): SessionHubLike {
  return {
    getStatus: () => "idle",
    listSessions: async () => [sessionFixture],
    findSession: async (id: string) => (id === "sess-1" ? sessionFixture : null),
    loadMessages: async (): Promise<MessageDto[]> => [],
    createSession: async () => sessionFixture,
    prompt: async () => promptResult,
    abort: async () => undefined,
    compact: async () => undefined,
  };
}

describe("contract: SPA history fallback", () => {
  let webRoot: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  const config: HubConfig = { ...DEFAULT_CONFIG };

  before(async () => {
    webRoot = await mkdtemp(join(tmpdir(), "agent-hub-web-"));
    await writeFile(join(webRoot, "index.html"), "<!doctype html><html><body>agent-hub</body></html>");
    await mkdir(join(webRoot, "assets"), { recursive: true });
    await writeFile(join(webRoot, "assets", "app.js"), "console.log(1)");
    app = await createApp({
      hub: makeFakeHub({ accepted: true, mode: "prompt" }),
      kpi: { getCards: () => [] },
      config,
      systemInfo: async () => systemFixture,
      webRoot,
    });
  });

  after(async () => {
    await app.close();
    await rm(webRoot, { recursive: true, force: true });
  });

  it("GET /s/:id 直接刷新回退 index.html（不 404）", async () => {
    const res = await app.inject({ method: "GET", url: "/s/sess-1" });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] as string, /text\/html/);
    assert.match(res.body, /agent-hub/);
  });

  it("任意未命中静态文件的 GET 都回退 index.html", async () => {
    for (const url of ["/", "/deep/nested/route", "/nope.js"]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 200, url);
      assert.match(res.body, /agent-hub/, url);
    }
  });

  it("命中的静态文件照常服务", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/app.js" });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /console\.log/);
  });

  it("GET /api/* 不回退：404 错误信封", async () => {
    const res = await app.inject({ method: "GET", url: "/api/unknown" });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, "NOT_FOUND");
    assert.equal(typeof body.error.message, "string");
  });

  it("GET /api/kpi 信封 {cards:[...]}", async () => {
    const res = await app.inject({ method: "GET", url: "/api/kpi" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { cards: [] });
  });
});

describe("contract: POST prompt 409 SESSION_BUSY", () => {
  let app: Awaited<ReturnType<typeof createApp>>;

  before(async () => {
    app = await createApp({
      hub: makeFakeHub({ accepted: false, mode: "prompt", busy: true }),
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      webRoot: null,
    });
  });

  after(async () => {
    await app.close();
  });

  it("正忙时返回 409 且体为 {error:{code:\"SESSION_BUSY\",message}}", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-1/prompt",
      payload: { text: "hello", mode: "prompt" },
    });
    assert.equal(res.statusCode, 409);
    const body = res.json() as { error: { code: string; message: string } };
    assert.deepEqual(Object.keys(body), ["error"]);
    assert.deepEqual(Object.keys(body.error).sort(), ["code", "message"]);
    assert.equal(body.error.code, "SESSION_BUSY");
    assert.equal(typeof body.error.message, "string");
    assert.ok(body.error.message.length > 0);
  });

  it("接受时返回 202 {accepted:true,mode}", async () => {
    const okApp = await createApp({
      hub: makeFakeHub({ accepted: true, mode: "steer" }),
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      webRoot: null,
    });
    const res = await okApp.inject({
      method: "POST",
      url: "/api/sessions/sess-1/prompt",
      payload: { text: "hello", mode: "steer" },
    });
    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.json(), { accepted: true, mode: "steer" });
    await okApp.close();
  });
});

describe("contract: WS 事件 type 集合与字段名（契约 §4 表格）", () => {
  const CONTRACT_TYPES = new Set([
    "session",
    "message_start",
    "text_delta",
    "tool_start",
    "tool_end",
    "message_end",
    "agent_settled",
    "status",
    "error",
    "pong", // ping 的契约响应
  ]);

  it("SDK 事件翻译产物严格匹配契约字段", async () => {
    const events: ServerEvent[] = [];
    const hub = new SessionHub("/nonexistent-sessions", (_id, event) => events.push(event));

    type HandleFn = (id: string, live: unknown, event: unknown) => void;
    const handle = (hub as unknown as { handleSdkEvent: HandleFn }).handleSdkEvent.bind(hub) as HandleFn;

    const fakeLive = {
      session: { sessionManager: { getEntries: () => [] } },
      currentMessageId: null as string | null,
      currentMessageStartTs: null as number | null,
      toolResults: new Map<string, { isError: boolean; text: string }>(),
      seq: 0,
    };

    handle("sess-1", fakeLive, { type: "agent_start" });
    handle("sess-1", fakeLive, {
      type: "message_start",
      message: { role: "user", content: "hi", timestamp: 1000 },
    });
    handle("sess-1", fakeLive, {
      type: "message_end",
      message: { role: "user", content: "hi", timestamp: 1000 },
    });
    handle("sess-1", fakeLive, {
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: 2000 },
    });
    handle("sess-1", fakeLive, {
      type: "message_update",
      message: { role: "assistant", content: [], timestamp: 2000 },
      assistantMessageEvent: { type: "text_delta", delta: "x" },
    });
    handle("sess-1", fakeLive, { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
    handle("sess-1", fakeLive, {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "ls" },
      result: { content: [{ type: "text", text: "ok" }] },
      isError: false,
    });
    handle("sess-1", fakeLive, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
        timestamp: 2000,
      },
    });
    handle("sess-1", fakeLive, { type: "agent_settled" });

    // message_end 经 setImmediate 延迟发出（等 SDK 落盘后解析 entry id）
    await new Promise<void>((resolve) => setImmediate(resolve));

    // 所有事件 type 均在契约集合内
    for (const event of events) {
      assert.ok(CONTRACT_TYPES.has(event.type), `未知事件 type: ${event.type}`);
    }

    const byType = new Map<string, ServerEvent[]>();
    for (const event of events) {
      const list = byType.get(event.type) ?? [];
      list.push(event);
      byType.set(event.type, list);
    }

    // status: {status}
    const statusEvents = byType.get("status") ?? [];
    assert.ok(statusEvents.length >= 2); // running + idle
    for (const e of statusEvents) {
      const ev = e as { type: string; status: string };
      assert.deepEqual(Object.keys(ev).sort(), ["status", "type"]);
      assert.ok(["idle", "running", "error"].includes(ev.status));
    }

    // message_start: {message:{id, role, timestamp}}
    const starts = byType.get("message_start") ?? [];
    assert.equal(starts.length, 2);
    for (const e of starts) {
      const ev = e as { type: string; message: Record<string, unknown> };
      assert.deepEqual(Object.keys(ev), ["type", "message"]);
      assert.deepEqual(Object.keys(ev.message).sort(), ["id", "role", "timestamp"]);
    }

    // text_delta: {messageId, delta}
    const deltas = byType.get("text_delta") ?? [];
    assert.equal(deltas.length, 1);
    assert.deepEqual(Object.keys(deltas[0] as object).sort(), ["delta", "messageId", "type"]);

    // tool_start: {messageId, toolCall:{name, summary}}
    const toolStarts = byType.get("tool_start") ?? [];
    assert.equal(toolStarts.length, 1);
    const ts = toolStarts[0] as { type: string; messageId: string; toolCall: Record<string, unknown> };
    assert.deepEqual(Object.keys(ts).sort(), ["messageId", "toolCall", "type"]);
    assert.deepEqual(Object.keys(ts.toolCall).sort(), ["name", "summary"]);

    // tool_end: {messageId, toolCall:{name, summary, status, resultPreview}}
    const toolEnds = byType.get("tool_end") ?? [];
    assert.equal(toolEnds.length, 1);
    const te = toolEnds[0] as { type: string; messageId: string; toolCall: Record<string, unknown> };
    assert.deepEqual(Object.keys(te).sort(), ["messageId", "toolCall", "type"]);
    assert.deepEqual(Object.keys(te.toolCall).sort(), ["name", "resultPreview", "status", "summary"]);
    assert.equal(te.toolCall.status, "done");
    assert.equal(te.toolCall.resultPreview, "ok");

    // message_end: {message:{id, role, timestamp, text, toolCalls}}
    const ends = byType.get("message_end") ?? [];
    assert.equal(ends.length, 2);
    for (const e of ends) {
      const ev = e as { type: string; message: Record<string, unknown> };
      assert.deepEqual(Object.keys(ev), ["type", "message"]);
      assert.deepEqual(Object.keys(ev.message).sort(), ["id", "role", "text", "timestamp", "toolCalls"]);
    }
    const assistantEnd = ends[1] as unknown as { message: { role: string; toolCalls: Array<Record<string, unknown>> } };
    assert.equal(assistantEnd.message.role, "assistant");
    assert.equal(assistantEnd.message.toolCalls.length, 1);
    assert.deepEqual(Object.keys(assistantEnd.message.toolCalls[0]).sort(), ["name", "resultPreview", "status", "summary"]);

    // agent_settled: 仅 {type}
    const settled = byType.get("agent_settled") ?? [];
    assert.equal(settled.length, 1);
    assert.deepEqual(Object.keys(settled[0] as object), ["type"]);

    // message_start 的 messageId 与 text_delta.messageId / tool_*.messageId 一致
    const assistantStart = starts[1] as { message: { id: string } };
    assert.equal((deltas[0] as { messageId: string }).messageId, assistantStart.message.id);
    assert.equal(ts.messageId, assistantStart.message.id);
    assert.equal(te.messageId, assistantStart.message.id);

    hub.disposeAll();
  });
});

describe("contract: 统一 404 错误信封（web/dist 缺失时也生效）", () => {
  let app: Awaited<ReturnType<typeof createApp>>;

  before(async () => {
    app = await createApp({
      hub: makeFakeHub({ accepted: true, mode: "prompt" }),
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      webRoot: null,
    });
  });

  after(async () => {
    await app.close();
  });

  it("GET /api/unknown 返回 {error:{code,message}} 而非 Fastify 默认 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/unknown" });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, "NOT_FOUND");
    assert.equal(typeof body.error.message, "string");
    assert.deepEqual(Object.keys(body), ["error"]);
  });

  it("任意未知路径同样返回统一信封", async () => {
    const res = await app.inject({ method: "GET", url: "/no/such/page" });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error: { code: string } };
    assert.equal(body.error.code, "NOT_FOUND");
  });
});
