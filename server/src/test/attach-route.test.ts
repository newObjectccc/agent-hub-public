/**
 * 终端接管 / 指令队列路由测试（E3 双模式，契约 §12）：
 * - POST /api/agents/heartbeat|ack、GET /api/agents/commands：仅本机回环 + token（防局域网伪造指令）
 * - POST /api/sessions/:id/attach|detach|message：接管生命周期与指令入队（clientMessageId 幂等）
 * - 冲突保护：attach 期间 parallel /prompt 409 ATTACH_ACTIVE
 * - 会话列表/详情注入 terminal 状态（会话列表徽章数据源）
 */
import { makeFakeDashboard } from "./fakeDashboard.js";
import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { AgentCommandHub } from "../agents.js";
import { DEFAULT_CONFIG, type HubConfig } from "../config.js";
import { createApp } from "../index.js";
import type { SessionHubLike } from "../routes.js";
import type { PromptResult } from "../sessions/hub.js";
import type {
  MessageDto,
  SearchResultDto,
  SessionListItem,
  SessionTreeDto,
  SystemInfo,
} from "../types.js";
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
  metrics: null,
};

function makeFakeHub(promptCalls: string[]): SessionHubLike {
  return {
    getStatus: () => "idle",
    listSessions: async () => [sessionFixture],
    findSession: async (id: string) => (id === "sess-1" ? sessionFixture : null),
    loadMessages: async (): Promise<MessageDto[]> => [],
    search: async (): Promise<SearchResultDto[]> => [],
    loadTree: async (): Promise<SessionTreeDto | null> => ({ entries: [], activePath: [] }),
    createSession: async () => sessionFixture,
    forkSession: async () => sessionFixture,
    prompt: async (_id: string, text: unknown): Promise<PromptResult> => {
      promptCalls.push(String(text));
      return { accepted: true, mode: "prompt" };
    },
    abort: async () => undefined,
    compact: async () => undefined,
  };
}

describe("attach 路由：指令通道安全（仅本机回环 + token）", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  const promptCalls: string[] = [];
  const agents = new AgentCommandHub();

  before(async () => {
    app = await createApp({
      hub: makeFakeHub(promptCalls),
      dashboard: makeFakeDashboard(),
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG, auth: { enabled: true, token: "secret-token" } } as HubConfig,
      systemInfo: async () => systemFixture,
      webRoot: null, appLock: fakeUnlockedAppLock(),
      agents,
    });
  });

  after(async () => {
    await app.close();
    agents.close();
  });

  it("非本机来源的 heartbeat/commands/ack 一律 401（防局域网伪造）", async () => {
    for (const [method, url] of [
      ["POST", "/api/agents/heartbeat"],
      ["GET", "/api/agents/commands?sessionId=sess-1"],
      ["POST", "/api/agents/ack"],
    ] as const) {
      const res = await app.inject({ method, url, remoteAddress: "192.168.1.9", payload: {} });
      assert.equal(res.statusCode, 401, url);
      assert.equal((res.json() as { error: { code: string } }).error.code, "UNAUTHORIZED");
    }
  });

  it("本机来源但缺/错 token 一律 401", async () => {
    const missing = await app.inject({ method: "POST", url: "/api/agents/heartbeat", payload: { sessionId: "s" } });
    assert.equal(missing.statusCode, 401);
    const wrong = await app.inject({
      method: "POST",
      url: "/api/agents/heartbeat",
      headers: { authorization: "Bearer nope" },
      payload: { sessionId: "s" },
    });
    assert.equal(wrong.statusCode, 401);
  });

  it("正确 token + 本机：heartbeat 202 并可投递/回执", async () => {
    const headers = { authorization: "Bearer secret-token" };
    const beat = await app.inject({
      method: "POST",
      url: "/api/agents/heartbeat",
      headers,
      payload: { sessionId: "sess-1", pid: 42, cwd: "/tmp/demo", capabilities: ["message"] },
    });
    assert.equal(beat.statusCode, 202);
    assert.deepEqual(beat.json(), { ok: true, ttlMs: 90_000 });

    const attach = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-1/attach",
      headers,
      payload: {},
    });
    assert.equal(attach.statusCode, 202);

    const sent = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-1/message",
      headers,
      payload: { text: "接管消息", mode: "steer" },
    });
    assert.equal(sent.statusCode, 202);
    const { commandId } = sent.json() as { commandId: string };

    const poll = await app.inject({
      method: "GET",
      url: `/api/agents/commands?sessionId=sess-1&wait=0`,
      headers,
    });
    assert.equal(poll.statusCode, 200);
    const commands = (poll.json() as { commands: Array<Record<string, unknown>> }).commands;
    assert.equal(commands.length, 1);
    assert.equal(commands[0].id, commandId);
    assert.equal(commands[0].text, "接管消息");
    assert.equal(commands[0].mode, "steer");
    assert.equal(commands[0].kind, "message");

    const ack = await app.inject({
      method: "POST",
      url: "/api/agents/ack",
      headers,
      payload: { sessionId: "sess-1", commandId, ok: true },
    });
    assert.equal(ack.statusCode, 202);
    assert.deepEqual(ack.json(), { ok: true, known: true });
  });
});

describe("attach 路由：生命周期 / 冲突保护 / terminal 状态注入", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  const promptCalls: string[] = [];
  const agents = new AgentCommandHub();

  before(async () => {
    app = await createApp({
      hub: makeFakeHub(promptCalls),
      dashboard: makeFakeDashboard(),
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG } as HubConfig,
      systemInfo: async () => systemFixture,
      webRoot: null, appLock: fakeUnlockedAppLock(),
      agents,
    });
  });

  after(async () => {
    await app.close();
    agents.close();
  });

  it("终端离线 attach → 409 ATTACH_UNAVAILABLE；message 未 attach → 409 ATTACH_REQUIRED", async () => {
    const unavailable = await app.inject({ method: "POST", url: "/api/sessions/sess-1/attach", payload: {} });
    assert.equal(unavailable.statusCode, 409);
    assert.equal((unavailable.json() as { error: { code: string } }).error.code, "ATTACH_UNAVAILABLE");

    const notAttached = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-1/message",
      payload: { text: "hi", mode: "steer" },
    });
    assert.equal(notAttached.statusCode, 409);
    assert.equal((notAttached.json() as { error: { code: string } }).error.code, "ATTACH_REQUIRED");
  });

  it("attach 期间 parallel /prompt 冲突保护 409 ATTACH_ACTIVE；detach 后恢复", async () => {
    await app.inject({ method: "POST", url: "/api/agents/heartbeat", payload: { sessionId: "sess-1" } });
    const attach = await app.inject({ method: "POST", url: "/api/sessions/sess-1/attach", payload: {} });
    assert.equal(attach.statusCode, 202);
    assert.equal((attach.json() as { attached: boolean }).attached, true);

    const blocked = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-1/prompt",
      payload: { text: "parallel 消息", mode: "prompt" },
    });
    assert.equal(blocked.statusCode, 409);
    assert.equal((blocked.json() as { error: { code: string } }).error.code, "ATTACH_ACTIVE");
    assert.deepEqual(promptCalls, [], "冲突期间绝不触达 SDK prompt");

    const detached = await app.inject({ method: "POST", url: "/api/sessions/sess-1/detach", payload: {} });
    assert.equal(detached.statusCode, 200);
    assert.deepEqual(detached.json(), { attached: false });

    const ok = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-1/prompt",
      payload: { text: "parallel 消息", mode: "prompt" },
    });
    assert.equal(ok.statusCode, 202);
    assert.deepEqual(promptCalls, ["parallel 消息"]);
  });

  it("clientMessageId 幂等：重复 POST /message 不重复入队", async () => {
    await app.inject({ method: "POST", url: "/api/agents/heartbeat", payload: { sessionId: "sess-1" } });
    await app.inject({ method: "POST", url: "/api/sessions/sess-1/attach", payload: {} });
    const first = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-1/message",
      payload: { text: "dup", mode: "followUp", clientMessageId: "cli-1" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-1/message",
      payload: { text: "dup", mode: "followUp", clientMessageId: "cli-1" },
    });
    assert.equal(first.statusCode, 202);
    assert.equal(second.statusCode, 202);
    const a = first.json() as { commandId: string };
    const b = second.json() as { commandId: string };
    assert.equal(a.commandId, b.commandId);

    const poll = await app.inject({ method: "GET", url: "/api/agents/commands?sessionId=sess-1&wait=0" });
    const commands = (poll.json() as { commands: unknown[] }).commands;
    assert.equal(commands.length, 1, "同 clientMessageId 只入队一条");
    await app.inject({ method: "POST", url: "/api/sessions/sess-1/detach", payload: {} });
  });

  it("会话列表 / 详情注入 terminal 状态（徽章数据源）", async () => {
    const list = await app.inject({ method: "GET", url: "/api/sessions" });
    const sessions = (list.json() as { sessions: SessionListItem[] }).sessions;
    // terminal 带 defaultPolicy（config.claudeDriver.defaultPolicy 下发，缺省 active-only）
    assert.deepEqual(sessions[0].terminal, { online: true, attached: false, defaultPolicy: "active-only" });

    await app.inject({ method: "POST", url: "/api/sessions/sess-1/attach", payload: {} });
    const detail = await app.inject({ method: "GET", url: "/api/sessions/sess-1" });
    assert.deepEqual((detail.json() as { session: SessionListItem }).session.terminal, {
      online: true,
      attached: true,
      defaultPolicy: "active-only",
    });
    await app.inject({ method: "POST", url: "/api/sessions/sess-1/detach", payload: {} });
  });

  it("message 文本/参数校验：缺 text 400、非法 mode 400", async () => {
    await app.inject({ method: "POST", url: "/api/agents/heartbeat", payload: { sessionId: "sess-1" } });
    await app.inject({ method: "POST", url: "/api/sessions/sess-1/attach", payload: {} });
    const noText = await app.inject({ method: "POST", url: "/api/sessions/sess-1/message", payload: { mode: "steer" } });
    assert.equal(noText.statusCode, 400);
    const badMode = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-1/message",
      payload: { text: "x", mode: "nextTurn" },
    });
    assert.equal(badMode.statusCode, 400);
    await app.inject({ method: "POST", url: "/api/sessions/sess-1/detach", payload: {} });
  });
});
