/**
 * prompt 幂等键回归（审计 P1）：body.clientMessageId 按 (sessionId + clientMessageId) 去重，
 * TTL 10min；弱网重发只执行一次并重放首次受理响应；失败释放占位允许重试。
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, type HubConfig } from "../config.js";
import { createApp } from "../index.js";
import { PromptIdempotencyStore, type SessionHubLike } from "../routes.js";
import type { MessageDto, SearchResultDto, SessionListItem, SessionTreeDto, SystemInfo } from "../types.js";
import { makeFakeDashboard } from "./fakeDashboard.js";
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

interface PromptCall {
  id: string;
  text: unknown;
}

function makeHub(calls: PromptCall[], opts: { busy?: boolean; fail?: boolean } = {}): SessionHubLike {
  return {
    getStatus: () => "idle",
    listSessions: async () => [sessionFixture],
    findSession: async (id: string) => (id === "sess-1" ? sessionFixture : null),
    loadMessages: async (): Promise<MessageDto[]> => [],
    search: async (): Promise<SearchResultDto[]> => [],
    loadTree: async (): Promise<SessionTreeDto | null> => ({ entries: [], activePath: [] }),
    createSession: async () => sessionFixture,
    forkSession: async () => sessionFixture,
    prompt: async (id: string, text: unknown) => {
      calls.push({ id, text });
      if (opts.fail) throw new Error("boom");
      return { accepted: !opts.busy, mode: "prompt", busy: opts.busy };
    },
    abort: async () => undefined,
    compact: async () => undefined,
  };
}

async function makeApp(calls: PromptCall[], opts: { busy?: boolean; fail?: boolean } = {}) {
  return createApp({
    hub: makeHub(calls, opts),
    kpi: { getCards: () => [] },
    dashboard: makeFakeDashboard(),
    config: { ...DEFAULT_CONFIG } as HubConfig,
    systemInfo: async () => systemFixture,
    webRoot: null,
    appLock: fakeUnlockedAppLock(),
  });
}

describe("prompt 幂等键：PromptIdempotencyStore（TTL 10min）", () => {
  it("首次占位、重复命中、失败释放、TTL 过期后可重放", () => {
    let now = 0;
    const store = new PromptIdempotencyStore(10 * 60 * 1000, () => now);
    assert.equal(store.begin("sess-1:msg-1"), false, "首次可执行");
    assert.equal(store.begin("sess-1:msg-1"), true, "处理中重复命中");
    assert.equal(store.begin("sess-1:msg-2"), false, "不同 clientMessageId 互不影响");
    assert.equal(store.begin("sess-2:msg-1"), false, "同 clientMessageId 不同会话互不影响");

    store.complete("sess-1:msg-1", "steer");
    assert.equal(store.modeOf("sess-1:msg-1"), "steer", "重放取首次受理 mode");

    store.release("sess-1:msg-2");
    assert.equal(store.begin("sess-1:msg-2"), false, "失败释放后允许重试");

    now = 10 * 60 * 1000 + 1;
    assert.equal(store.begin("sess-1:msg-1"), false, "TTL 过期后重新执行");
  });
});

describe("prompt 幂等键：POST /api/sessions/:id/prompt 路由去重", () => {
  it("同 clientMessageId 重发只执行一次并重放 202；不同 id 各执行", async () => {
    const calls: PromptCall[] = [];
    const app = await makeApp(calls);
    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/sessions/sess-1/prompt",
        payload: { text: "hello", clientMessageId: "c-1" },
      });
      assert.equal(first.statusCode, 202);
      assert.deepEqual(first.json(), { accepted: true, mode: "prompt" });

      const resend = await app.inject({
        method: "POST",
        url: "/api/sessions/sess-1/prompt",
        payload: { text: "hello", clientMessageId: "c-1" },
      });
      assert.equal(resend.statusCode, 202);
      assert.deepEqual(resend.json(), { accepted: true, mode: "prompt", deduplicated: true }, "重发重放首次响应");
      assert.equal(calls.length, 1, "重发不得双执行");

      const other = await app.inject({
        method: "POST",
        url: "/api/sessions/sess-1/prompt",
        payload: { text: "hello", clientMessageId: "c-2" },
      });
      assert.equal(other.statusCode, 202);
      assert.equal(calls.length, 2, "不同 clientMessageId 正常执行");

      // 不带键保持原行为（每次都执行）
      const noKey = await app.inject({ method: "POST", url: "/api/sessions/sess-1/prompt", payload: { text: "hello" } });
      assert.equal(noKey.statusCode, 202);
      assert.equal(calls.length, 3);
    } finally {
      await app.close();
    }
  });

  it("/compact 指令同样受幂等保护；失败（409 busy）释放占位允许重试", async () => {
    const compactCalls: PromptCall[] = [];
    const app = await createApp({
      hub: {
        ...makeHub([]),
        compact: async (id: string) => {
          compactCalls.push({ id, text: "compact" });
        },
      } as SessionHubLike,
      kpi: { getCards: () => [] },
      dashboard: makeFakeDashboard(),
      config: { ...DEFAULT_CONFIG } as HubConfig,
      systemInfo: async () => systemFixture,
      webRoot: null,
      appLock: fakeUnlockedAppLock(),
    });
    try {
      const payload = { text: "/compact", clientMessageId: "c-compact" };
      const first = await app.inject({ method: "POST", url: "/api/sessions/sess-1/prompt", payload });
      assert.equal(first.statusCode, 202);
      assert.deepEqual(first.json(), { accepted: true, mode: "prompt", handled: "compact" });
      const resend = await app.inject({ method: "POST", url: "/api/sessions/sess-1/prompt", payload });
      assert.equal((resend.json() as { deduplicated?: boolean }).deduplicated, true);
      assert.equal(compactCalls.length, 1, "compact 重发不得双执行");
    } finally {
      await app.close();
    }

    const busyCalls: PromptCall[] = [];
    const busyApp = await makeApp(busyCalls, { busy: true });
    try {
      const payload = { text: "hello", clientMessageId: "c-busy" };
      const busy = await busyApp.inject({ method: "POST", url: "/api/sessions/sess-1/prompt", payload });
      assert.equal(busy.statusCode, 409, "首次 busy 报 409");
      const retry = await busyApp.inject({ method: "POST", url: "/api/sessions/sess-1/prompt", payload });
      assert.equal(retry.statusCode, 409, "失败不缓存：同键可重试（仍走 hub）");
      assert.equal(busyCalls.length, 2);
    } finally {
      await busyApp.close();
    }
  });
});
