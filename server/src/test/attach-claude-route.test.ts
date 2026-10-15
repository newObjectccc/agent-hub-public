/**
 * claude hub 驱动接管路由测试（docs/CLAUDE_DRIVER.md，契约 §12）：
 * - POST /attach：claude 分流 driver.attach、codex 仍 400、未启用 claudeDriver 400
 * - POST /detach、/message：按 source 分流（响应形状与 pi 通道一致）
 * - host-requests：bridge 机器通道（回环+token、挂起等应答）+ 手机通道（列表/应答/404/409）
 * - rejectIfAttached 并集：claude 接管期间 parallel /prompt 409
 * - abort：attached 走 driver.abortTurn
 * 仿 attach-route.test.ts：createApp + fake hub + fake driver + app.inject。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { AgentCommandHub } from "../agents.js";
import { createApp } from "../index.js";
import { makeFakeDashboard } from "./fakeDashboard.js";
import { DEFAULT_CONFIG, type HubConfig } from "../config.js";
import type { MessageDto, PromptImageAttachment, SearchResultDto, SessionListItem, SessionTreeDto, SystemInfo } from "../types.js";
import type { SessionHubLike } from "../routes.js";
import type { ClaudeDriverLinkLike, DriverCommand, HostRequestDecision } from "../adapters/claude-driver.js";
import type { BridgeHostRequestBody } from "../adapters/claude-host-protocol.js";

const claudeFixture: SessionListItem = {
  id: "sess-c1",
  source: "claude",
  name: null,
  cwd: "/tmp/demo",
  updatedAt: "2026-02-18T12:00:00.000Z",
  messageCount: 0,
  status: "running",
  lastUserMessage: null,
  lastAssistantMessage: null,
  sessionFile: "/tmp/demo-c1.jsonl",
  isSubAgent: false,
};

const codexFixture: SessionListItem = { ...claudeFixture, id: "sess-x1", source: "codex", sessionFile: "/tmp/demo-x1.jsonl" };

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
    listSessions: async () => [claudeFixture, codexFixture],
    findSession: async (id: string) =>
      id === "sess-c1" ? claudeFixture : id === "sess-x1" ? codexFixture : null,
    loadMessages: async (): Promise<MessageDto[]> => [],
    search: async (): Promise<SearchResultDto[]> => [],
    loadTree: async (): Promise<SessionTreeDto | null> => ({ entries: [], activePath: [] }),
    createSession: async () => claudeFixture,
    forkSession: async () => claudeFixture,
    prompt: async (_id: string, text: unknown, _m: unknown, _i?: PromptImageAttachment[]) => {
      promptCalls.push(String(text));
      return { accepted: true, mode: "prompt" as const };
    },
    abort: async () => undefined,
    compact: async () => undefined,
  };
}

/** fake driver：记录调用，host request 挂起直到 respond */
function makeFakeDriver() {
  const calls = {
    attach: [] as string[],
    detach: [] as string[],
    send: [] as Array<{ id: string; text: unknown; mode?: unknown }>,
    abortTurn: [] as string[],
  };
  let attached = false;
  const pending = new Map<string, { body: BridgeHostRequestBody; resolve: (d: HostRequestDecision) => void }>();
  /** 已决记忆（对齐 ClaudeDriverHub.isResolvedHostRequest：契约 §12 已决 → 409） */
  const resolved = new Set<string>();
  const driver: ClaudeDriverLinkLike = {
    attach: async (id: string) => {
      calls.attach.push(id);
      attached = true;
      return { attached: true, driver: "hub", mirror: true };
    },
    detach: (id: string) => {
      calls.detach.push(id);
      attached = false;
      return true;
    },
    isAttached: () => attached,
    send: (id: string, input: { text: unknown; mode?: unknown }) => {
      calls.send.push({ id, ...input });
      return { id: "cmd-1", mode: "followUp" } as DriverCommand;
    },
    abortTurn: (id: string) => {
      calls.abortTurn.push(id);
    },
    statusFor: () => ({ online: true, attached, driver: "hub" as const, mirror: false }),
    registerHostRequest: (body: BridgeHostRequestBody) =>
      new Promise<HostRequestDecision>((resolve) => {
        pending.set(body.requestId, { body, resolve });
      }),
    listHostRequests: () =>
      [...pending.values()].map((p) => ({
        id: p.body.requestId,
        sessionId: p.body.sessionId,
        kind: "permission" as const,
        title: "Bash: x",
        detail: null,
        createdAt: Date.now(),
        expiresAt: null,
      })),
    respondHostRequest: (id: string, requestId: string, decision: HostRequestDecision) => {
      const p = pending.get(requestId);
      if (!p) return false;
      pending.delete(requestId);
      resolved.add(requestId);
      p.resolve(decision);
      return true;
    },
    isResolvedHostRequest: (requestId: string) => resolved.has(requestId),
    startSweep: () => undefined,
    disposeAll: () => undefined,
  };
  return { driver, calls, pending, resolved };
}

function fakeUnlockedAppLock() {
  return {
    status: () => ({ configured: false }),
    verifyToken: () => ({ ok: true }),
    setPin: () => ({ ok: true }),
    clearPin: () => ({ ok: true }),
  } as never;
}

describe("claude 接管路由：attach/detach/message 分流", () => {
  let app: FastifyInstance;
  const promptCalls: string[] = [];
  const { driver, calls } = makeFakeDriver();

  before(async () => {
    app = await createApp({
      hub: makeFakeHub(promptCalls),
      dashboard: makeFakeDashboard(),
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG } as HubConfig,
      systemInfo: async () => systemFixture,
      webRoot: null,
      appLock: fakeUnlockedAppLock(),
      claudeDriver: driver,
    });
  });

  after(async () => {
    await app.close();
  });

  it("POST /attach claude → 202 driver.attach；codex → 400", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions/sess-c1/attach" });
    assert.equal(res.statusCode, 202);
    assert.equal(res.json().agent.driver, "hub");
    assert.deepEqual(calls.attach, ["sess-c1"]);
    const x = await app.inject({ method: "POST", url: "/api/sessions/sess-x1/attach" });
    assert.equal(x.statusCode, 400);
    assert.match(x.json().error.message, /仅 pi \/ claude/);
  });

  it("GET /api/sessions stampTerminal：claude 带 terminal（driver=hub）", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    const c1 = res.json().sessions.find((s: { id: string }) => s.id === "sess-c1");
    assert.equal(c1.terminal.driver, "hub");
    assert.equal(c1.terminal.attached, true);
    const x1 = res.json().sessions.find((s: { id: string }) => s.id === "sess-x1");
    assert.equal(x1.terminal, undefined);
  });

  it("POST /message claude → driver.send（响应形状与 pi 一致）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-c1/message",
      payload: { text: "hello", mode: "steer" },
    });
    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.json(), {
      accepted: true,
      channel: "attach",
      commandId: "cmd-1",
      mode: "followUp",
    });
    assert.equal(calls.send.at(-1)?.text, "hello");
    assert.equal(calls.send.at(-1)?.mode, "steer");
  });

  it("接管期间 parallel /prompt → 409 ATTACH_ACTIVE（driver 并集）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-c1/prompt",
      payload: { text: "double write?" },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "ATTACH_ACTIVE");
    assert.deepEqual(promptCalls, []);
  });

  it("POST /abort 接管中 → driver.abortTurn", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions/sess-c1/abort" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls.abortTurn, ["sess-c1"]);
  });

  it("POST /detach claude → driver.detach", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions/sess-c1/detach" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls.detach, ["sess-c1"]);
  });

  it("stampTerminal：claudeDriver 未注入 → 无 terminal 字段", async () => {
    const bare = await createApp({
      hub: makeFakeHub(promptCalls),
      dashboard: makeFakeDashboard(),
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG } as HubConfig,
      systemInfo: async () => systemFixture,
      webRoot: null,
      appLock: fakeUnlockedAppLock(),
    });
    const res = await bare.inject({ method: "GET", url: "/api/sessions" });
    const c1 = res.json().sessions.find((s: { id: string }) => s.id === "sess-c1");
    assert.equal(c1.terminal, undefined);
    await bare.close();
  });

  it("claudeDriver 未注入（enabled=false 不装配 driver）：POST /attach claude → 400（前端回落 parallel）", async () => {
    const bare = await createApp({
      hub: makeFakeHub(promptCalls),
      dashboard: makeFakeDashboard(),
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG, claudeDriver: { ...DEFAULT_CONFIG.claudeDriver, enabled: false } } as HubConfig,
      systemInfo: async () => systemFixture,
      webRoot: null,
      appLock: fakeUnlockedAppLock(),
    });
    const res = await bare.inject({ method: "POST", url: "/api/sessions/sess-c1/attach" });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "INVALID_REQUEST");
    assert.match(res.json().error.message, /接管未启用/);
    await bare.close();
  });
});

describe("host-requests：bridge 机器通道 + 手机应答", () => {
  let app: FastifyInstance;
  const promptCalls: string[] = [];
  const { driver, pending } = makeFakeDriver();

  before(async () => {
    app = await createApp({
      hub: makeFakeHub(promptCalls),
      dashboard: makeFakeDashboard(),
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG, auth: { enabled: true, token: "secret-token" } } as HubConfig,
      systemInfo: async () => systemFixture,
      webRoot: null,
      appLock: fakeUnlockedAppLock(),
      claudeDriver: driver,
    });
  });

  after(async () => {
    await app.close();
  });

  it("POST /api/agents/host-requests（回环+token）挂起 → 手机 allow 后返回 behavior", async () => {
    const bridgePromise = app.inject({
      method: "POST",
      url: "/api/agents/host-requests",
      headers: { authorization: "Bearer secret-token" },
      payload: {
        sessionId: "sess-c1",
        requestId: "call_1",
        toolName: "Bash",
        toolUseId: "call_1",
        input: { command: "ls" },
      },
    });
    // 等 bridge 注册完成（挂起）
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(pending.has("call_1"), true);

    const list = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-c1/host-requests",
      headers: { authorization: "Bearer secret-token" },
    });
    assert.equal(list.json().requests.length, 1);
    assert.equal(list.json().requests[0].id, "call_1");

    const respond = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-c1/host-requests/call_1",
      headers: { authorization: "Bearer secret-token" },
      payload: { outcome: "allow" },
    });
    assert.equal(respond.statusCode, 200);
    const bridge = await bridgePromise;
    assert.equal(bridge.statusCode, 200);
    assert.equal(bridge.json().behavior, "allow");
  });

  it("应答成功后再次应答同一 id → 409 HOST_REQUEST_RESOLVED（双重应答/幂等回放）", async () => {
    // 注册新请求 call_replay，首答成功后再答同一 id 必须 409（契约 §12「已决 → 409」，修复后可达）
    const bridgePromise = app.inject({
      method: "POST",
      url: "/api/agents/host-requests",
      headers: { authorization: "Bearer secret-token" },
      payload: {
        sessionId: "sess-c1",
        requestId: "call_replay",
        toolName: "Bash",
        toolUseId: "call_replay",
        input: { command: "ls" },
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const first = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-c1/host-requests/call_replay",
      headers: { authorization: "Bearer secret-token" },
      payload: { outcome: "allow" },
    });
    assert.equal(first.statusCode, 200);
    await bridgePromise; // bridge 挂起随首答应答结束

    const replay = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-c1/host-requests/call_replay",
      headers: { authorization: "Bearer secret-token" },
      payload: { outcome: "deny" },
    });
    assert.equal(replay.statusCode, 409);
    assert.equal(replay.json().error.code, "HOST_REQUEST_RESOLVED");
  });

  it("应答未知 id → 404 HOST_REQUEST_NOT_FOUND", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-c1/host-requests/nope",
      headers: { authorization: "Bearer secret-token" },
      payload: { outcome: "allow" },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, "HOST_REQUEST_NOT_FOUND");
  });

  it("非法 outcome → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-c1/host-requests/x",
      headers: { authorization: "Bearer secret-token" },
      payload: { outcome: "maybe" },
    });
    assert.equal(res.statusCode, 400);
  });

  it("bridge 缺 token → 401；非回环 → 401", async () => {
    const noToken = await app.inject({
      method: "POST",
      url: "/api/agents/host-requests",
      payload: { sessionId: "s", requestId: "r", toolName: "t", toolUseId: "r", input: null },
    });
    assert.equal(noToken.statusCode, 401);
    const remote = await app.inject({
      method: "POST",
      url: "/api/agents/host-requests",
      headers: { authorization: "Bearer secret-token" },
      remoteAddress: "192.168.1.9",
      payload: { sessionId: "s", requestId: "r", toolName: "t", toolUseId: "r", input: null },
    });
    assert.equal(remote.statusCode, 401);
  });
});

describe("defaultPolicy 下发：terminal.defaultPolicy 与 config 一致（pi/claude 双通道）", () => {
  const piFixture: SessionListItem = { ...claudeFixture, id: "sess-p1", source: "pi", sessionFile: "/tmp/demo-p1.jsonl" };

  function makePolicyHub(): SessionHubLike {
    return {
      ...makeFakeHub([]),
      listSessions: async () => [piFixture, claudeFixture, codexFixture],
      findSession: async (id: string) =>
        id === "sess-p1" ? piFixture : id === "sess-c1" ? claudeFixture : id === "sess-x1" ? codexFixture : null,
    };
  }

  async function startWithPolicy(policy: "active-only" | "always" | "never") {
    const { driver } = makeFakeDriver();
    const agents = new AgentCommandHub();
    const app = await createApp({
      hub: makePolicyHub(),
      dashboard: makeFakeDashboard(),
      kpi: { getCards: () => [] },
      config: { ...DEFAULT_CONFIG, claudeDriver: { ...DEFAULT_CONFIG.claudeDriver, defaultPolicy: policy } } as HubConfig,
      systemInfo: async () => systemFixture,
      webRoot: null,
      appLock: fakeUnlockedAppLock(),
      agents,
      claudeDriver: driver,
    });
    return { app, agents };
  }

  for (const policy of ["always", "never", "active-only"] as const) {
    it(`GET /api/sessions 列表与详情：pi/claude terminal.defaultPolicy === "${policy}"（codex 不下发）`, async () => {
      const { app, agents } = await startWithPolicy(policy);
      try {
        const list = await app.inject({ method: "GET", url: "/api/sessions" });
        const items = list.json().sessions as Array<{ id: string; terminal?: { defaultPolicy?: string } | null }>;
        // pi 走 agents.statusFor、claude 走 claudeDriver.statusFor：两路结果都要带 defaultPolicy
        assert.equal(
          items.find((s) => s.id === "sess-p1")?.terminal?.defaultPolicy,
          policy,
          "pi 会话 terminal.defaultPolicy 必须与 config 一致",
        );
        assert.equal(
          items.find((s) => s.id === "sess-c1")?.terminal?.defaultPolicy,
          policy,
          "claude 会话 terminal.defaultPolicy 必须与 config 一致",
        );
        assert.equal(items.find((s) => s.id === "sess-x1")?.terminal, undefined, "codex 无 terminal，不下发");

        for (const id of ["sess-p1", "sess-c1"]) {
          const detail = await app.inject({ method: "GET", url: `/api/sessions/${id}` });
          assert.equal(detail.json().session.terminal.defaultPolicy, policy, `${id} 详情 terminal.defaultPolicy 必须与 config 一致`);
        }
      } finally {
        agents.close();
        await app.close();
      }
    });
  }
});
