/**
 * GET /api/sessions/:id/agents 路由（反馈轮 3 #4）：
 * 只聚合 pi-subagents 派生子代理（isSubAgent + parentSessionId 匹配），
 * fork 分支（带 parentSessionId 但非子代理）与无关会话不进面板。
 */
import { makeFakeDashboard } from "./fakeDashboard.js";
import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { DEFAULT_CONFIG } from "../config.js";
import { createApp } from "../index.js";
import type { SessionHubLike } from "../routes.js";
import type { MessageDto, SearchResultDto, SessionListItem, SessionTreeDto, SystemInfo } from "../types.js";
import type { PromptResult } from "../sessions/hub.js";
import { fakeUnlockedAppLock } from "./fakeAppLock.js";

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

function session(over: Partial<SessionListItem>): SessionListItem {
  return {
    id: "parent-1",
    source: "pi",
    name: "主会话",
    cwd: "/tmp/ws",
    updatedAt: "2026-02-18T12:00:00.000Z",
    messageCount: 1,
    status: "idle",
    lastUserMessage: null,
    lastAssistantMessage: null,
    sessionFile: "/tmp/parent.jsonl",
    isSubAgent: false,
    parentSessionId: null,
    ...over,
  };
}

const sub1 = session({
  id: "sub-1",
  name: "developer#abc123",
  isSubAgent: true,
  parentSessionId: "parent-1",
  status: "running",
});
const sub2 = session({
  id: "sub-2",
  name: "tester#def456",
  isSubAgent: true,
  parentSessionId: "parent-1",
  status: "idle",
  lastAssistantMessage: "全部测试通过",
});
/** fork 分支：带 parentSessionId 但不是子代理 → 不进面板 */
const forked = session({ id: "fork-1", name: "主会话(副本)", isSubAgent: false, parentSessionId: "parent-1" });
/** 其他会话的子代理 → 不进本父会话面板 */
const otherSub = session({ id: "sub-x", name: "developer#zzz", isSubAgent: true, parentSessionId: "other-parent" });

const messagesById: Record<string, MessageDto[]> = {
  "sub-1": [
    {
      id: "m1",
      role: "assistant",
      timestamp: 1000,
      text: "正在分析",
      toolCalls: [{ name: "bash", summary: "grep -n foo", status: "running", resultPreview: null }],
    },
  ],
  "sub-2": [{ id: "m2", role: "assistant", timestamp: 2000, text: "全部测试通过", toolCalls: [] }],
};

function makeFakeHub(): SessionHubLike {
  const promptResult: PromptResult = { accepted: true, mode: "prompt" };
  return {
    getStatus: () => "idle",
    listSessions: async () => [session({}), sub1, sub2, forked, otherSub],
    findSession: async (id: string) =>
      [session({}), sub1, sub2, forked, otherSub].find((s) => s.id === id) ?? null,
    loadMessages: async (id: string): Promise<MessageDto[]> => messagesById[id] ?? [],
    search: async (): Promise<SearchResultDto[]> => [],
    loadTree: async (): Promise<SessionTreeDto | null> => null,
    createSession: async () => session({}),
    forkSession: async () => session({}),
    prompt: async () => promptResult,
    abort: async () => undefined,
    compact: async () => undefined,
  };
}

describe("GET /api/sessions/:id/agents（子代理活动快照）", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await createApp({
      hub: makeFakeHub(),
      kpi: { getCards: () => [] },
      dashboard: makeFakeDashboard(),
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      webRoot: null, appLock: fakeUnlockedAppLock(),
      logger: false,
    });
  });
  after(async () => {
    await app.close();
  });

  it("返回父会话的子代理活动（fork 分支/无关子代理不混入）", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/parent-1/agents" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { agents: Array<{ sessionId: string; name: string; done: boolean; currentTool: string | null }> };
    assert.equal(body.agents.length, 2);
    const ids = body.agents.map((a) => a.sessionId).sort();
    assert.deepEqual(ids, ["sub-1", "sub-2"]);

    const running = body.agents.find((a) => a.sessionId === "sub-1");
    assert.equal(running?.name, "developer#abc123");
    assert.equal(running?.done, false);
    assert.equal(running?.currentTool, "grep -n foo");

    const done = body.agents.find((a) => a.sessionId === "sub-2");
    assert.equal(done?.done, true);
  });

  it("无子代理的会话返回空列表（面板不渲染）", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/sub-1/agents" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { agents: [] });
  });
});
