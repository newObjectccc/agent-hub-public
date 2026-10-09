/**
 * 契约级测试（前端补充需求）：
 * 1. SPA history fallback：非 /api、/ws 的 GET 未命中静态 → index.html（/s/:id 刷新不 404）
 * 2. 409 错误体严格 {error:{code:"SESSION_BUSY",message}}
 * 3. WS 事件 type 集合与字段名严格按 docs/API_CONTRACT.md §4 表格
 */
import { makeFakeDashboard } from "./fakeDashboard.js";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DEFAULT_CONFIG, type HubConfig } from "../config.js";
import type { DashboardServiceLike } from "../dashboard.js";
import { createApp } from "../index.js";
import type { SessionHubLike } from "../routes.js";
import { SessionHub } from "../sessions/hub.js";
import type { PromptResult } from "../sessions/hub.js";
import type { MessageDto, SearchResultDto, ServerEvent, SessionListItem, SessionSource, SessionTreeDto, SystemInfo } from "../types.js";
import { ErrorCodes, HubError } from "../errors.js";
import { toSessionDto } from "../routes.js";
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

function makeFakeHub(promptResult: PromptResult, overrides: Partial<SessionHubLike> = {}): SessionHubLike {
  return {
    getStatus: () => "idle",
    listSessions: async () => [sessionFixture],
    findSession: async (id: string) => (id === "sess-1" ? sessionFixture : null),
    loadMessages: async (): Promise<MessageDto[]> => [],
    search: async (): Promise<SearchResultDto[]> => [],
    loadTree: async (): Promise<SessionTreeDto | null> => ({ entries: [], activePath: [] }),
    createSession: async () => sessionFixture,
    forkSession: async () => sessionFixture,
    renameSession: async () => sessionFixture,
    prompt: async () => promptResult,
    abort: async () => undefined,
    compact: async () => undefined,
    ...overrides,
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
      dashboard: makeFakeDashboard(),
      kpi: { getCards: () => [] },
      config,
      systemInfo: async () => systemFixture,
      webRoot,
      appLock: fakeUnlockedAppLock(),
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

describe("contract: GET /api/search 与 GET /api/sessions/:id/tree", () => {
  const searchFixture: SearchResultDto[] = [
    {
      sessionId: "sess-1",
      sessionName: "pi-demo",
      messageId: "e2",
      role: "assistant",
      snippet: "先查 [[KPI]] 口径",
      timestamp: 1733234402000,
    },
  ];
  const treeFixture: SessionTreeDto = {
    entries: [
      { id: "e1", parentId: null, role: "user", text: "帮我检查 KPI", timestamp: 1733234401000, hasChildren: true },
      { id: "e2", parentId: "e1", role: "assistant", text: "好的", timestamp: 1733234402000, hasChildren: false },
    ],
    activePath: ["e1", "e2"],
  };

  async function makeApp(hub: SessionHubLike): Promise<Awaited<ReturnType<typeof createApp>>> {
    return createApp({
      hub,
      dashboard: makeFakeDashboard(),
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      webRoot: null, appLock: fakeUnlockedAppLock(),
    });
  }

  it("GET /api/search 返回 {results:[...]}，字段名严格按契约", async () => {
    const app = await makeApp(makeFakeHub({ accepted: true, mode: "prompt" }, { search: async () => searchFixture }));
    const res = await app.inject({ method: "GET", url: "/api/search?q=KPI" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { results: SearchResultDto[] };
    assert.deepEqual(Object.keys(body), ["results"]);
    assert.equal(body.results.length, 1);
    assert.deepEqual(Object.keys(body.results[0]).sort(), ["messageId", "role", "sessionId", "sessionName", "snippet", "timestamp"]);
    await app.close();
  });

  it("GET /api/search 缺 q / 空 q → 400 INVALID_REQUEST", async () => {
    const app = await makeApp(makeFakeHub({ accepted: true, mode: "prompt" }));
    for (const url of ["/api/search", "/api/search?q=%20%20"]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 400, url);
      const body = res.json() as { error: { code: string } };
      assert.equal(body.error.code, "INVALID_REQUEST");
    }
    await app.close();
  });

  it("GET /api/search limit 透传（非数字回退默认）", async () => {
    const calls: Array<{ query: string; limit: number | undefined }> = [];
    const app = await makeApp(
      makeFakeHub(
        { accepted: true, mode: "prompt" },
        {
          search: async (query: string, limit?: number) => {
            calls.push({ query, limit });
            return [];
          },
        },
      ),
    );
    assert.equal((await app.inject({ method: "GET", url: "/api/search?q=a&limit=5" })).statusCode, 200);
    assert.deepEqual(calls[0], { query: "a", limit: 5 });
    assert.equal((await app.inject({ method: "GET", url: "/api/search?q=a&limit=oops" })).statusCode, 200);
    assert.deepEqual(calls[1], { query: "a", limit: undefined });
    await app.close();
  });

  it("GET /api/sessions/:id/tree 返回 {entries,activePath}", async () => {
    const app = await makeApp(makeFakeHub({ accepted: true, mode: "prompt" }, { loadTree: async () => treeFixture }));
    const res = await app.inject({ method: "GET", url: "/api/sessions/sess-1/tree" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), treeFixture);
    await app.close();
  });

  it("GET /api/sessions/:id/tree 会话不存在 → 404 SESSION_NOT_FOUND", async () => {
    const app = await makeApp(makeFakeHub({ accepted: true, mode: "prompt" }, { loadTree: async () => null }));
    const res = await app.inject({ method: "GET", url: "/api/sessions/nope/tree" });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, "SESSION_NOT_FOUND");
    await app.close();
  });
});

describe("contract: POST /api/sessions（source 分发）与 POST /api/sessions/:id/fork", () => {
  async function makeApp(hub: SessionHubLike): Promise<Awaited<ReturnType<typeof createApp>>> {
    return createApp({
      hub,
      dashboard: makeFakeDashboard(),
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      webRoot: null, appLock: fakeUnlockedAppLock(),
    });
  }

  it("缺省 source → pi；显式 pi/claude 原样透传到 hub.createSession", async () => {
    const calls: Array<{ cwd: string; name?: string; source?: SessionSource }> = [];
    const app = await makeApp(
      makeFakeHub(
        { accepted: true, mode: "prompt" },
        {
          createSession: async (cwd: string, name?: string, source?: SessionSource) => {
            calls.push({ cwd, name, source });
            return sessionFixture;
          },
        },
      ),
    );
    const r1 = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: "/tmp/demo" } });
    assert.equal(r1.statusCode, 201);
    // 出参为 SessionDto：剥离内部路径 sessionFile（响应瘦身，前端零使用）
    assert.deepEqual(r1.json(), { session: toSessionDto(sessionFixture) });
    assert.equal("sessionFile" in r1.json().session, false, "出参不泄漏服务端内部路径");

    const r2 = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { cwd: "/tmp/demo", name: "新会话", source: "claude" },
    });
    assert.equal(r2.statusCode, 201);
    assert.deepEqual(calls, [
      { cwd: "/tmp/demo", name: undefined, source: "pi" },
      { cwd: "/tmp/demo", name: "新会话", source: "claude" },
    ]);
    await app.close();
  });

  it("非法 source → 400 INVALID_REQUEST（不落任何会话）", async () => {
    const calls: unknown[] = [];
    const app = await makeApp(
      makeFakeHub(
        { accepted: true, mode: "prompt" },
        {
          createSession: async (cwd: string, name?: string, source?: SessionSource) => {
            calls.push({ cwd, name, source });
            return sessionFixture;
          },
        },
      ),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { cwd: "/tmp/demo", source: "gpt" },
    });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { error: { code: string } }).error.code, "INVALID_REQUEST");
    assert.equal(calls.length, 0);
    await app.close();
  });

  it("cwd 非绝对路径 → 400 INVALID_CWD", async () => {
    const app = await makeApp(makeFakeHub({ accepted: true, mode: "prompt" }));
    const res = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: "relative/path" } });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { error: { code: string } }).error.code, "INVALID_CWD");
    await app.close();
  });

  it("POST /api/sessions/:id/fork → 201 {session}", async () => {
    const calls: string[] = [];
    const app = await makeApp(
      makeFakeHub(
        { accepted: true, mode: "prompt" },
        {
          forkSession: async (id: string) => {
            calls.push(id);
            return { ...sessionFixture, id: "sess-1-fork" };
          },
        },
      ),
    );
    const res = await app.inject({ method: "POST", url: "/api/sessions/sess-1/fork" });
    assert.equal(res.statusCode, 201);
    assert.deepEqual((res.json() as { session: SessionListItem }).session.id, "sess-1-fork");
    assert.deepEqual(calls, ["sess-1"]);
    await app.close();
  });

  it("fork 会话不存在 → 404 SESSION_NOT_FOUND", async () => {
    const app = await makeApp(
      makeFakeHub(
        { accepted: true, mode: "prompt" },
        {
          forkSession: async (id: string) => {
            throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${id}`, 404);
          },
        },
      ),
    );
    const res = await app.inject({ method: "POST", url: "/api/sessions/nope/fork" });
    assert.equal(res.statusCode, 404);
    assert.equal((res.json() as { error: { code: string } }).error.code, "SESSION_NOT_FOUND");
    await app.close();
  });
});

describe("contract: POST /api/sessions/:id/rename（body.name 空串=清空）", () => {
  async function makeApp(hub: SessionHubLike): Promise<Awaited<ReturnType<typeof createApp>>> {
    return createApp({
      hub,
      dashboard: makeFakeDashboard(),
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      webRoot: null, appLock: fakeUnlockedAppLock(),
    });
  }

  it("POST /api/sessions/:id/rename → 200 {session}，name 原样透传", async () => {
    const calls: Array<{ id: string; name: string }> = [];
    const app = await makeApp(
      makeFakeHub(
        { accepted: true, mode: "prompt" },
        {
          renameSession: async (id: string, name: string) => {
            calls.push({ id, name });
            return { ...sessionFixture, name };
          },
        },
      ),
    );
    const res = await app.inject({ method: "POST", url: "/api/sessions/sess-1/rename", payload: { name: "新名字" } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.json() as { session: SessionListItem }).session.name, "新名字");
    assert.deepEqual(calls, [{ id: "sess-1", name: "新名字" }]);
    await app.close();
  });

  it("name 空串 = 清空名字（原样透传，不当缺省）", async () => {
    const calls: string[] = [];
    const app = await makeApp(
      makeFakeHub(
        { accepted: true, mode: "prompt" },
        {
          renameSession: async (id: string, name: string) => {
            calls.push(name);
            return { ...sessionFixture, name: null };
          },
        },
      ),
    );
    const res = await app.inject({ method: "POST", url: "/api/sessions/sess-1/rename", payload: { name: "" } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, [""]);
    assert.equal((res.json() as { session: SessionListItem }).session.name, null);
    await app.close();
  });

  it("name 非字符串 / 缺失 / 超长 → 400 INVALID_REQUEST（不调 rename）", async () => {
    const calls: unknown[] = [];
    const app = await makeApp(
      makeFakeHub(
        { accepted: true, mode: "prompt" },
        {
          renameSession: async (id: string, name: string) => {
            calls.push({ id, name });
            return sessionFixture;
          },
        },
      ),
    );
    for (const payload of [{}, { name: 42 }, { name: "x".repeat(201) }]) {
      const res = await app.inject({ method: "POST", url: "/api/sessions/sess-1/rename", payload });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.equal((res.json() as { error: { code: string } }).error.code, "INVALID_REQUEST");
    }
    assert.equal(calls.length, 0);
    await app.close();
  });

  it("rename 会话不存在 → 404 SESSION_NOT_FOUND", async () => {
    const app = await makeApp(
      makeFakeHub(
        { accepted: true, mode: "prompt" },
        {
          renameSession: async (id: string) => {
            throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${id}`, 404);
          },
        },
      ),
    );
    const res = await app.inject({ method: "POST", url: "/api/sessions/nope/rename", payload: { name: "x" } });
    assert.equal(res.statusCode, 404);
    assert.equal((res.json() as { error: { code: string } }).error.code, "SESSION_NOT_FOUND");
    await app.close();
  });

  it("hub 不支持 renameSession → 501（明确报错，不静默假装成功）", async () => {
    const fake = makeFakeHub({ accepted: true, mode: "prompt" });
    delete (fake as Partial<SessionHubLike>).renameSession;
    const app = await makeApp(fake);
    const res = await app.inject({ method: "POST", url: "/api/sessions/sess-1/rename", payload: { name: "x" } });
    assert.equal(res.statusCode, 501);
    assert.equal((res.json() as { error: { code: string } }).error.code, "INVALID_REQUEST");
    await app.close();
  });
});

describe("contract: POST prompt 409 SESSION_BUSY", () => {
  let app: Awaited<ReturnType<typeof createApp>>;

  before(async () => {
    app = await createApp({
      hub: makeFakeHub({ accepted: false, mode: "prompt", busy: true }),
      kpi: { getCards: () => [] },
      dashboard: makeFakeDashboard(),
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      webRoot: null, appLock: fakeUnlockedAppLock(),
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
      dashboard: makeFakeDashboard(),
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      webRoot: null, appLock: fakeUnlockedAppLock(),
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
    "thinking_delta",
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

    // message_end: {message:{id, role, timestamp, text, thinking, toolCalls}}
    const ends = byType.get("message_end") ?? [];
    assert.equal(ends.length, 2);
    for (const e of ends) {
      const ev = e as { type: string; message: Record<string, unknown> };
      assert.deepEqual(Object.keys(ev), ["type", "message"]);
      assert.deepEqual(Object.keys(ev.message).sort(), ["id", "role", "text", "thinking", "timestamp", "toolCalls"]);
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
      dashboard: makeFakeDashboard(),
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      webRoot: null, appLock: fakeUnlockedAppLock(),
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

describe("contract: GET /api/sessions/:id 消息分页（?before=&limit=）", () => {
  const pageMessages: MessageDto[] = Array.from({ length: 5 }, (_, i) => ({
    id: `m${i + 1}`,
    role: i % 2 === 0 ? "user" : "assistant",
    timestamp: 1000 + i,
    text: `t${i + 1}`,
    toolCalls: [],
  }));

  let app: Awaited<ReturnType<typeof createApp>>;

  before(async () => {
    const base = makeFakeHub({ accepted: true, mode: "prompt" });
    app = await createApp({
      hub: { ...base, loadMessages: async () => pageMessages } as SessionHubLike,
      dashboard: makeFakeDashboard(),
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      webRoot: null, appLock: fakeUnlockedAppLock(),
    });
  });

  after(async () => {
    await app.close();
  });

  it("不带查询参数：v0 全量行为 + hasMore:false/nextBefore:null", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/sess-1" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { messages: MessageDto[]; hasMore: boolean; nextBefore: string | null };
    assert.equal(body.messages.length, 5);
    assert.equal(body.hasMore, false);
    assert.equal(body.nextBefore, null);
  });

  it("?limit=2 返回尾部窗口与游标", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/sess-1?limit=2" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { messages: MessageDto[]; hasMore: boolean; nextBefore: string | null };
    assert.deepEqual(body.messages.map((m) => m.id), ["m4", "m5"]);
    assert.equal(body.hasMore, true);
    assert.equal(body.nextBefore, "m4");
  });

  it("?before=&limit= 返回更早一页", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/sess-1?before=m4&limit=2" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { messages: MessageDto[]; hasMore: boolean; nextBefore: string | null };
    assert.deepEqual(body.messages.map((m) => m.id), ["m2", "m3"]);
    assert.equal(body.hasMore, true);
    assert.equal(body.nextBefore, "m2");
  });

  it("非法 limit 返回 400 INVALID_REQUEST", async () => {
    for (const url of ["/api/sessions/sess-1?limit=0", "/api/sessions/sess-1?limit=abc", "/api/sessions/sess-1?limit=9999"]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 400, url);
      const body = res.json() as { error: { code: string } };
      assert.equal(body.error.code, "INVALID_REQUEST", url);
    }
  });
});

describe("contract: GET /api/commands 与 GET /api/fs/tree（§8/§9）", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let fsRoot: string;

  before(async () => {
    fsRoot = await mkdtemp(join(tmpdir(), "agent-hub-fstree-"));
    await mkdir(join(fsRoot, "src"), { recursive: true });
    await mkdir(join(fsRoot, ".git"), { recursive: true });
    await writeFile(join(fsRoot, "README.md"), "# hi");
    app = await createApp({
      appLock: fakeUnlockedAppLock(),
      hub: makeFakeHub({ accepted: true, mode: "prompt" }),
      dashboard: makeFakeDashboard(),
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      commands: {
        list: async (source) => ({
          source,
          commands:
            source === "pi"
              ? [{ name: "/name", description: "设置会话显示名", builtin: true, terminalOnly: false }]
              : [
                  { name: "/clear", description: "清空上下文", builtin: true, terminalOnly: true },
                  { name: "/probe", description: "自定义命令", builtin: false, terminalOnly: false },
                ],
        }),
      },
    });
  });

  after(async () => {
    await app.close();
    await rm(fsRoot, { recursive: true, force: true });
  });

  it("GET /api/commands?source=pi|claude 返回契约结构", async () => {
    const pi = await app.inject({ method: "GET", url: "/api/commands?source=pi" });
    assert.equal(pi.statusCode, 200);
    const piBody = pi.json() as { source: string; commands: Array<{ name: string; description: string; builtin: boolean; terminalOnly: boolean }> };
    assert.equal(piBody.source, "pi");
    assert.equal(piBody.commands[0].name, "/name");
    assert.equal(piBody.commands[0].terminalOnly, false);
    const claude = await app.inject({ method: "GET", url: "/api/commands?source=claude" });
    const claudeBody = claude.json() as typeof piBody;
    assert.equal(claudeBody.commands.length, 2);
    assert.equal(claudeBody.commands[0].terminalOnly, true, "claude 内置命令必须标注仅终端可用");
    assert.equal(claudeBody.commands[1].builtin, false);
  });

  it("pi 会话 /compact [指令] → 转发 SDK session.compact()（202 handled=compact）", async () => {
    const calls: Array<string | undefined> = [];
    const compactApp = await createApp({
      appLock: fakeUnlockedAppLock(),
      hub: makeFakeHub({ accepted: true, mode: "prompt" }, {
        compact: async (_id: string, instructions?: string) => {
          calls.push(instructions);
        },
      }),
      dashboard: makeFakeDashboard(),
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
    });
    const res = await compactApp.inject({
      method: "POST",
      url: "/api/sessions/sess-1/prompt",
      payload: { text: "/compact 保留 KPI 结论" },
    });
    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.json(), { accepted: true, mode: "prompt", handled: "compact" });
    assert.deepEqual(calls, ["保留 KPI 结论"]);

    // 非命令文本不走 compact 通道
    const plain = await compactApp.inject({
      method: "POST",
      url: "/api/sessions/sess-1/prompt",
      payload: { text: "继续分析" },
    });
    assert.equal(plain.statusCode, 202);
    assert.deepEqual(calls, ["保留 KPI 结论"]);
    await compactApp.close();
  });

  it("compact 语义错误（Nothing to compact）→ 400 而非 500", async () => {
    const compactApp = await createApp({
      appLock: fakeUnlockedAppLock(),
      hub: makeFakeHub({ accepted: true, mode: "prompt" }, {
        compact: async () => {
          throw new Error("Nothing to compact (session too small)");
        },
      }),
      dashboard: makeFakeDashboard(),
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
    });
    const res = await compactApp.inject({
      method: "POST",
      url: "/api/sessions/sess-1/prompt",
      payload: { text: "/compact" },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, "INVALID_REQUEST");
    assert.match(body.error.message, /Nothing to compact/);
    await compactApp.close();
  });

  it("source 缺失/非法 → 400 INVALID_REQUEST 错误信封", async () => {
    for (const url of ["/api/commands", "/api/commands?source=openai"]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 400, url);
      const body = res.json() as { error: { code: string; message: string } };
      assert.equal(body.error.code, "INVALID_REQUEST", url);
      assert.equal(typeof body.error.message, "string");
    }
  });

  it("GET /api/fs/tree 列目录：隐藏默认、hidden=1 展开、q 过滤", async () => {
    const res = await app.inject({ method: "GET", url: `/api/fs/tree?cwd=${encodeURIComponent(fsRoot)}` });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { cwd: string; path: string; parent: string | null; entries: Array<{ name: string; type: string }>; truncated: boolean };
    assert.equal(body.path, "");
    assert.equal(body.parent, null);
    assert.deepEqual(body.entries.map((e) => e.name), ["src", "README.md"]);
    const hidden = await app.inject({ method: "GET", url: `/api/fs/tree?cwd=${encodeURIComponent(fsRoot)}&hidden=1` });
    assert.ok((hidden.json() as typeof body).entries.some((e) => e.name === ".git"));
    const q = await app.inject({ method: "GET", url: `/api/fs/tree?cwd=${encodeURIComponent(fsRoot)}&q=readme` });
    assert.deepEqual((q.json() as typeof body).entries.map((e) => e.name), ["README.md"]);
  });

  it("防路径穿越：path=../.. → 400 INVALID_PATH 信封", async () => {
    const res = await app.inject({ method: "GET", url: `/api/fs/tree?cwd=${encodeURIComponent(fsRoot)}&path=..%2F..` });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error: { code: string } };
    assert.equal(body.error.code, "INVALID_PATH");
  });

  it("cwd 非法/不存在 → INVALID_CWD 400 / FILE_NOT_FOUND 404", async () => {
    const rel = await app.inject({ method: "GET", url: "/api/fs/tree?cwd=relative" });
    assert.equal(rel.statusCode, 400);
    assert.equal((rel.json() as { error: { code: string } }).error.code, "INVALID_CWD");
    const missing = await app.inject({ method: "GET", url: "/api/fs/tree?cwd=%2Fno%2Fsuch%2Fdir" });
    assert.equal(missing.statusCode, 404);
    assert.equal((missing.json() as { error: { code: string } }).error.code, "FILE_NOT_FOUND");
  });
});

describe("perf: 弱 ETag 协商缓存（慢链路二次打开秒开）", () => {
  async function makeApp(hub: SessionHubLike): Promise<Awaited<ReturnType<typeof createApp>>> {
    return createApp({
      hub,
      dashboard: makeFakeDashboard(),
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      webRoot: null, appLock: fakeUnlockedAppLock(),
    });
  }

  it("GET 首访发 ETag + no-cache；If-None-Match 命中 → 304 零字节体；列表出参剥离内部路径", async () => {
    const app = await makeApp(makeFakeHub({ accepted: true, mode: "prompt" }));
    const r1 = await app.inject({ method: "GET", url: "/api/sessions" });
    assert.equal(r1.statusCode, 200);
    const etag = r1.headers.etag;
    assert.equal(typeof etag, "string", "JSON GET 响应带弱 ETag");
    assert.equal(r1.headers["cache-control"], "no-cache", "可缓存但必须回源校验");
    assert.equal("sessionFile" in (r1.json() as { sessions: Array<Record<string, unknown>> }).sessions[0], false,
      "出参剥离服务端内部路径 sessionFile");

    const r2 = await app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { "if-none-match": String(etag) },
    });
    assert.equal(r2.statusCode, 304, "ETag 命中回 304");
    assert.equal(r2.body, "", "304 无响应体");
    await app.close();
  });
});
