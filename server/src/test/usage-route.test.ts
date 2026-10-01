/**
 * GET /api/usage 契约级测试（docs/API_CONTRACT.md §15）：
 * 全局汇总 / 单会话汇总 / ?days= 自定义窗 的信封与字段名；
 * 错误走 HubError 信封（INVALID_REQUEST / SESSION_NOT_FOUND）。
 * 全部用构造的 JSONL fixture（临时目录），不依赖本机真实数据。
 */
import { makeFakeDashboard } from "./fakeDashboard.js";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DEFAULT_CONFIG, type HubConfig } from "../config.js";
import { createApp } from "../index.js";
import type { SessionHubLike } from "../routes.js";
import { UsageService } from "../usage.js";
import type { MessageDto, SearchResultDto, SessionListItem, SessionTreeDto, SystemInfo, UsageOverviewDto, UsageSessionDto } from "../types.js";

const NOW = Date.now();
const sessionFixture: SessionListItem = {
  id: "sess-usage-1",
  source: "pi",
  name: null,
  cwd: "/tmp/demo",
  updatedAt: new Date(NOW).toISOString(),
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
    sampledAt: new Date(NOW).toISOString(),
  },
};

function makeFakeHub(): SessionHubLike {
  return {
    getStatus: () => "idle",
    listSessions: async () => [sessionFixture],
    findSession: async (id: string) => (id === "sess-usage-1" ? sessionFixture : null),
    loadMessages: async (): Promise<MessageDto[]> => [],
    search: async (): Promise<SearchResultDto[]> => [],
    loadTree: async (): Promise<SessionTreeDto | null> => ({ entries: [], activePath: [] }),
    createSession: async () => sessionFixture,
    forkSession: async () => sessionFixture,
    prompt: async () => ({ accepted: true, mode: "prompt" }),
    abort: async () => undefined,
    compact: async () => undefined,
  };
}

describe("contract: GET /api/usage", () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  const config: HubConfig = { ...DEFAULT_CONFIG };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-hub-usage-route-"));
    // 会话 1：今日一条 usage（时间贴近真实 now，落在「今日」窗内）
    await writeFile(join(dir, "2026-02-18T08-00-00-000Z_sess-usage-1.jsonl"), [
      JSON.stringify({ type: "session", id: "sess-usage-1", timestamp: new Date(NOW).toISOString(), cwd: "/tmp/demo" }),
      JSON.stringify({
        type: "message",
        id: "a1",
        timestamp: new Date(NOW - 60_000).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "好" }],
          timestamp: NOW - 60_000,
          usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, reasoning: 7, totalTokens: 162, cost: { total: 3 } },
        },
      }),
    ].join("\n"));
    app = await createApp({
      hub: makeFakeHub(),
      dashboard: makeFakeDashboard(),
      usage: new UsageService({ sessionDir: dir }),
      kpi: { getCards: () => [] },
      config,
      systemInfo: async () => systemFixture,
      webRoot: null,
    });
  });

  after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("全局汇总：信封 {windows, sessions}，窗口字段名严格按契约", async () => {
    const res = await app.inject({ method: "GET", url: "/api/usage" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as UsageOverviewDto;
    assert.deepEqual(Object.keys(body).sort(), ["sessions", "windows"]);
    assert.deepEqual(Object.keys(body.windows).sort(), ["all", "last7Days", "today"]);
    assert.deepEqual(Object.keys(body.windows.today).sort(), [
      "cacheRead", "cacheWrite", "costTotal", "input", "output", "reasoning", "totalTokens",
    ]);
    assert.equal(body.windows.today.totalTokens, 162);
    assert.equal(body.windows.today.costTotal, 3);
    assert.equal(body.sessions.length, 1);
    assert.deepEqual(Object.keys(body.sessions[0]).sort(), ["name", "sessionId", "updatedAt", "usage"]);
    assert.equal(body.sessions[0].sessionId, "sess-usage-1");
  });

  it("?days= 自定义窗：返回 range {days, usage}", async () => {
    const res = await app.inject({ method: "GET", url: "/api/usage?days=7" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as UsageOverviewDto;
    assert.deepEqual(Object.keys(body).sort(), ["range", "sessions", "windows"]);
    assert.equal(body.range?.days, 7);
    assert.equal(body.range?.usage.totalTokens, 162);
  });

  it("?days= 非法 → 400 INVALID_REQUEST 错误信封", async () => {
    for (const url of ["/api/usage?days=abc", "/api/usage?days=0", "/api/usage?days=-3"]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 400, url);
      const body = res.json() as { error: { code: string; message: string } };
      assert.equal(body.error.code, "INVALID_REQUEST", url);
      assert.equal(typeof body.error.message, "string");
    }
  });

  it("单会话汇总：?sessionId= 命中返回 {sessionId, name, updatedAt, windows[, range]}", async () => {
    const res = await app.inject({ method: "GET", url: "/api/usage?sessionId=sess-usage-1&days=1" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as UsageSessionDto;
    assert.deepEqual(Object.keys(body).sort(), ["name", "range", "sessionId", "updatedAt", "windows"]);
    assert.equal(body.sessionId, "sess-usage-1");
    assert.equal(body.windows.today.totalTokens, 162);
    assert.equal(body.windows.all.totalTokens, 162);
    assert.equal(body.range?.usage.totalTokens, 162);
  });

  it("单会话汇总：sessionId 不存在 → 404 SESSION_NOT_FOUND 信封", async () => {
    const res = await app.inject({ method: "GET", url: "/api/usage?sessionId=nope" });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, "SESSION_NOT_FOUND");
  });
});
