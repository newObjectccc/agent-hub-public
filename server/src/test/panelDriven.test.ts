/**
 * 会话驱动来源标注（心理预期管理）：
 * 1. panelDriven 纯函数：JSON 解析容错 / 稳定序列化 / drivenBy 判定
 * 2. PanelDrivenStore 持久化：mark → 落盘 → 新实例重启后仍记得（data/panel-driven.json）
 * 3. 路由：POST prompt 接受 → lastDrivenBy=panel；未驱动会话 → terminal；
 *    409 busy 未接受不标注；/compact 接受同样标注
 */
import { makeFakeDashboard } from "./fakeDashboard.js";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DEFAULT_CONFIG } from "../config.js";
import { createApp } from "../index.js";
import {
  createPanelDrivenStore,
  drivenByOf,
  parsePanelDriven,
  serializePanelDriven,
  type PanelDrivenStoreLike,
} from "../panelDriven.js";
import type { SessionHubLike } from "../routes.js";
import type { PromptResult } from "../sessions/hub.js";
import type { MessageDto, SearchResultDto, SessionListItem, SessionTreeDto, SystemInfo } from "../types.js";

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

function makeFakeHub(promptResult: PromptResult): SessionHubLike {
  return {
    getStatus: () => "idle",
    listSessions: async () => [sessionFixture],
    findSession: async (id: string) => (id === "sess-1" ? sessionFixture : null),
    loadMessages: async (): Promise<MessageDto[]> => [],
    search: async (): Promise<SearchResultDto[]> => [],
    loadTree: async (): Promise<SessionTreeDto | null> => ({ entries: [], activePath: [] }),
    createSession: async () => sessionFixture,
    forkSession: async () => sessionFixture,
    prompt: async () => promptResult,
    abort: async () => undefined,
    compact: async () => undefined,
  };
}

/** 内存 store（路由测试不写真实文件） */
function fakeStore(initial: string[] = []): PanelDrivenStoreLike & { marked: string[] } {
  const ids = new Set(initial);
  const marked: string[] = [];
  return {
    marked,
    has: (id: string) => ids.has(id),
    mark: async (id: string) => {
      ids.add(id);
      marked.push(id);
    },
  };
}

describe("panelDriven: 纯函数", () => {
  it("parsePanelDriven 容错：损坏 JSON / 非数组 / 空串过滤，一律安全返回", () => {
    assert.deepEqual([...parsePanelDriven("{ broken")], []);
    assert.deepEqual([...parsePanelDriven('{"version":1,"sessionIds":"nope"}')], []);
    assert.deepEqual([...parsePanelDriven("null")], []);
    assert.deepEqual([...parsePanelDriven('{"sessionIds":["a","","b",1]}')], ["a", "b"]);
    assert.deepEqual([...parsePanelDriven('{"sessionIds":["s2","s1"]}')], ["s2", "s1"]);
  });

  it("serializePanelDriven 稳定排序 + 版本号，round-trip 一致", () => {
    const raw = serializePanelDriven(["s2", "s1"]);
    assert.match(raw, /"version": 1/);
    assert.deepEqual([...parsePanelDriven(raw)], ["s1", "s2"]);
  });

  it("drivenByOf：面板驱动过 → panel，否则 terminal", () => {
    const store = fakeStore(["s-panel"]);
    assert.equal(drivenByOf(store, "s-panel"), "panel");
    assert.equal(drivenByOf(store, "s-terminal"), "terminal");
  });
});

describe("panelDriven: PanelDrivenStore 持久化", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-hub-panel-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("mark → 落盘 JSON → 新实例（模拟重启）仍记得", async () => {
    const store = createPanelDrivenStore(dir);
    await store.mark("sess-a");
    await store.mark("sess-b");
    const raw = await readFile(join(dir, "panel-driven.json"), "utf8");
    assert.deepEqual([...parsePanelDriven(raw)], ["sess-a", "sess-b"]);
    const restarted = createPanelDrivenStore(dir);
    assert.equal(restarted.has("sess-a"), true);
    assert.equal(restarted.has("sess-b"), true);
    assert.equal(restarted.has("sess-c"), false);
  });

  it("mark 幂等 + 空 id 不记", async () => {
    const dir2 = await mkdtemp(join(tmpdir(), "agent-hub-panel-"));
    const store = createPanelDrivenStore(dir2);
    await store.mark("sess-a");
    await store.mark("sess-a");
    await store.mark("");
    const raw = await readFile(join(dir2, "panel-driven.json"), "utf8");
    assert.deepEqual([...parsePanelDriven(raw)], ["sess-a"]);
    await rm(dir2, { recursive: true, force: true });
  });
});

describe("panelDriven 路由：lastDrivenBy 标注与提示契约", () => {
  it("GET /api/sessions / :id 未驱动 → terminal；POST prompt 接受 → panel（持久集合）", async () => {
    const store = fakeStore();
    const app = await createApp({
      hub: makeFakeHub({ accepted: true, mode: "prompt" }),
      kpi: { getCards: () => [] },
      dashboard: makeFakeDashboard(),
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      webRoot: null,
      panelDriven: store,
    });
    try {
      const before = await app.inject({ method: "GET", url: "/api/sessions" });
      const beforeList = before.json() as { sessions: SessionListItem[] };
      assert.equal(beforeList.sessions[0].lastDrivenBy, "terminal");

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/sess-1/prompt",
        payload: { text: "hello", mode: "prompt" },
      });
      assert.equal(res.statusCode, 202);
      assert.deepEqual(store.marked, ["sess-1"]);

      const list = await app.inject({ method: "GET", url: "/api/sessions" });
      assert.equal((list.json() as { sessions: SessionListItem[] }).sessions[0].lastDrivenBy, "panel");
      const detail = await app.inject({ method: "GET", url: "/api/sessions/sess-1" });
      assert.equal((detail.json() as { session: SessionListItem }).session.lastDrivenBy, "panel");
    } finally {
      await app.close();
    }
  });

  it("POST prompt 409 busy 未接受 → 不标注；/compact 接受 → 标注", async () => {
    const busyStore = fakeStore();
    const busyApp = await createApp({
      hub: makeFakeHub({ accepted: false, mode: "prompt", busy: true }),
      kpi: { getCards: () => [] },
      dashboard: makeFakeDashboard(),
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      webRoot: null,
      panelDriven: busyStore,
    });
    try {
      const res = await busyApp.inject({
        method: "POST",
        url: "/api/sessions/sess-1/prompt",
        payload: { text: "hello" },
      });
      assert.equal(res.statusCode, 409);
      assert.deepEqual(busyStore.marked, []);
    } finally {
      await busyApp.close();
    }

    const store = fakeStore();
    const app = await createApp({
      hub: makeFakeHub({ accepted: true, mode: "prompt" }),
      kpi: { getCards: () => [] },
      dashboard: makeFakeDashboard(),
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      webRoot: null,
      panelDriven: store,
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/sess-1/prompt",
        payload: { text: "/compact" },
      });
      assert.equal(res.statusCode, 202);
      assert.deepEqual((res.json() as { handled?: string }).handled, "compact");
      assert.deepEqual(store.marked, ["sess-1"]);
    } finally {
      await app.close();
    }
  });
});
