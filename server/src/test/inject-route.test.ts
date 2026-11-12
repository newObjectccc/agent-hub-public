/**
 * 终端注入接管路由测试（docs/TERMINAL_INJECT.md）：
 * - POST /attach 三态：TUI+宿主 → driver=inject；无 TUI → 落 driver 后台；TUI 无通道 → 409 防双写
 * - POST /message：注入发送；窗口中途关闭 → 自动降级 driver 后台发送（「不在窗口就后台」）
 * - rejectIfAttached 并集：注入接管期间 parallel /prompt 409
 * - GET /api/sessions：terminal.driver=inject（stampTerminal 事实源校正）
 * - POST /detach：清注入登记（幂等）
 * 用真实 InjectHub + fake 发现/注入（路由接线 + 注册表行为一起回归）。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createApp } from "../index.js";
import { makeFakeDashboard } from "./fakeDashboard.js";
import { DEFAULT_CONFIG, type HubConfig } from "../config.js";
import type { MessageDto, PromptImageAttachment, SearchResultDto, SessionListItem, SessionTreeDto, SystemInfo } from "../types.js";
import type { SessionHubLike } from "../routes.js";
import type { ClaudeDriverLinkLike, DriverCommand } from "../adapters/claude-driver.js";
import { InjectHub } from "../adapters/inject-hub.js";
import type { HostDiscovery } from "../adapters/terminal-host.js";

const claudeFixture: SessionListItem = {
  id: "sess-i1",
  source: "claude",
  name: null,
  cwd: "/tmp/demo",
  updatedAt: "2026-02-18T12:00:00.000Z",
  messageCount: 0,
  status: "running",
  lastUserMessage: null,
  lastAssistantMessage: null,
  sessionFile: "/tmp/demo-i1.jsonl",
  isSubAgent: false,
};

const systemFixture: SystemInfo = {
  platform: "darwin",
  pi: { available: true, version: "0.87.1" },
  claude: { available: true, version: "2.1.267" },
  tmux: { available: true, version: "3.7c" },
  ttyd: { available: false, version: null },
  tailscale: { available: false, version: null, loggedIn: false, hostname: null },
  sessionDir: "/tmp/sessions",
  workspaceRoot: "/tmp/ws",
  metrics: null,
};

function makeFakeHub(promptCalls: string[]): SessionHubLike {
  return {
    getStatus: () => "idle",
    listSessions: async () => [claudeFixture],
    findSession: async (id: string) => (id === "sess-i1" ? claudeFixture : null),
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

function makeFakeDriver() {
  const calls = { attach: [] as string[], send: [] as Array<{ id: string; text: unknown }> };
  let attached = false;
  const driver = {
    attach: async (id: string) => {
      calls.attach.push(id);
      attached = true;
      return { attached: true as const, driver: "hub" as const, mirror: false };
    },
    detach: (id: string) => {
      void id;
      attached = false;
      return true;
    },
    send: (id: string, input: { text: unknown }) => {
      calls.send.push({ id, text: input.text });
      return { id: `cmd-${calls.send.length}`, mode: "prompt" as const } as DriverCommand;
    },
    isAttached: () => attached,
    isAttaching: () => false,
    statusFor: () => ({ online: true, attached, driver: "hub" as const, mirror: false }),
    abortTurn: () => undefined,
    startSweep: () => undefined,
    disposeAll: () => undefined,
    runStatusFor: () => null,
    isResolvedHostRequest: () => false,
  } as unknown as ClaudeDriverLinkLike;
  return { driver, calls, set: (v: boolean) => { attached = v; } };
}

function fakeUnlockedAppLock() {
  return {
    status: () => ({ configured: false }),
    verifyToken: () => ({ ok: true }),
    setPin: () => ({ ok: true }),
    clearPin: () => ({ ok: true }),
  } as never;
}

describe("终端注入接管路由：attach 三态 / message 降级 / 冲突保护", () => {
  let app: FastifyInstance;
  const promptCalls: string[] = [];
  const { driver, calls } = makeFakeDriver();
  const injected: string[] = [];
  /** 发现结果队列（每次 discover 消费一个；用尽沿用最后一个） */
  const discoveries: Array<HostDiscovery | null> = [];
  const injectHub = new InjectHub({
    emit: () => undefined,
    discover: async () => discoveries.shift() ?? null,
    inject: async (_host, text) => {
      injected.push(text);
    },
  });

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
      injectHub,
    });
  });

  after(async () => {
    await app.close();
  });

  it("attach：TUI+可注入宿主 → 202 driver=inject（不启动后台 driver）", async () => {
    discoveries.push({ pid: 10, host: { kind: "kitty", socket: "unix:/k.sock", windowId: 3 }, ambiguous: false });
    const res = await app.inject({ method: "POST", url: "/api/sessions/sess-i1/attach" });
    assert.equal(res.statusCode, 202);
    assert.equal(res.json().agent.driver, "inject");
    assert.equal(res.json().agent.mirror, false);
    assert.deepEqual(calls.attach, [], "注入接管不启动 hub 后台 driver");
  });

  it("stampTerminal：注入接管中 GET /api/sessions 显示 driver=inject attached", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    const s = res.json().sessions.find((x: { id: string }) => x.id === "sess-i1");
    assert.equal(s.terminal.driver, "inject");
    assert.equal(s.terminal.attached, true);
  });

  it("message：注入发送（文本原样进 TUI）；parallel 发送 409 ATTACH_ACTIVE", async () => {
    discoveries.push({ pid: 10, host: { kind: "kitty", socket: "unix:/k.sock", windowId: 3 }, ambiguous: false }); // send 重发现
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-i1/message",
      payload: { text: "你好 \"world\"\n二行" },
    });
    assert.equal(res.statusCode, 202);
    assert.deepEqual(injected, ["你好 \"world\"\n二行"]);
    const p = await app.inject({ method: "POST", url: "/api/sessions/sess-i1/prompt", payload: { text: "x" } });
    assert.equal(p.statusCode, 409);
    assert.equal(p.json().error.code, "ATTACH_ACTIVE");
  });

  it("message：窗口中途关闭 → 自动降级后台 driver 发送（「不在窗口就后台」）", async () => {
    discoveries.push(null); // 重发现：无 TUI
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-i1/message",
      payload: { text: "降级这条" },
    });
    assert.equal(res.statusCode, 202);
    assert.deepEqual(calls.attach, ["sess-i1"], "降级时补 driver.attach");
    assert.deepEqual(calls.send.map((c) => c.text), ["降级这条"]);
  });

  it("attach：TUI 在但宿主无注入通道 → 409（防双写），不落 driver", async () => {
    discoveries.push({ pid: 11, host: null, ambiguous: false });
    const res = await app.inject({ method: "POST", url: "/api/sessions/sess-i1/attach" });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error.message, /没有注入通道/);
  });

  it("attach：无 TUI → 落 driver 后台接管（driver=hub）", async () => {
    discoveries.push(null);
    const res = await app.inject({ method: "POST", url: "/api/sessions/sess-i1/attach" });
    assert.equal(res.statusCode, 202);
    assert.equal(res.json().agent.driver, "hub");
  });

  it("detach：清注入登记后 parallel 恢复可用", async () => {
    discoveries.push({ pid: 12, host: { kind: "tmux", pane: "%1" }, ambiguous: false }); // attach probe
    await app.inject({ method: "POST", url: "/api/sessions/sess-i1/attach" });
    const d = await app.inject({ method: "POST", url: "/api/sessions/sess-i1/detach" });
    assert.equal(d.statusCode, 200);
    assert.equal(d.json().attached, false);
    const p = await app.inject({ method: "POST", url: "/api/sessions/sess-i1/prompt", payload: { text: "x" } });
    assert.equal(p.statusCode, 202, "detach 后平行通道恢复（/prompt 成功 202）");
  });
});
