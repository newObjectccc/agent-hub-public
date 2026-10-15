/**
 * WS 运行期缺陷回归测试：
 * 1. 握手竞态：连接后立即发送的消息（ping/prompt）不得静默丢失（pending 队列兜底）
 * 2. 关闭不挂起：有活跃 WS 客户端时 closeAll + app.close 快速返回（SIGINT 场景）
 */
import { strict as assert } from "node:assert";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { WebSocket } from "ws";
import type { AppLockStoreLike } from "../appLock.js";
import { DEFAULT_CONFIG } from "../config.js";
import { emptySourceStats } from "../dashboard.js";
import type { DashboardServiceLike } from "../dashboard.js";
import { attachSessionWs, createApp } from "../index.js";
import type { SessionHub } from "../sessions/hub.js";
import type { SessionTailManager } from "../sessions/tail.js";
import type { SessionHubLike } from "../routes.js";
import type { MessageDto, SearchResultDto, SessionListItem, SessionTreeDto, SystemInfo } from "../types.js";
import { WsHub, type WsSessionHub } from "../ws.js";
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
  text: unknown;
  mode: unknown;
}

function makeFakeHub(promptCalls: PromptCall[]): SessionHubLike {
  return {
    getStatus: () => "idle",
    listSessions: async () => [sessionFixture],
    findSession: async (id: string) => (id === "sess-1" ? sessionFixture : null),
    loadMessages: async (): Promise<MessageDto[]> => [],
    search: async (): Promise<SearchResultDto[]> => [],
    loadTree: async (): Promise<SessionTreeDto | null> => ({ entries: [], activePath: [] }),
    createSession: async () => sessionFixture,
    forkSession: async () => sessionFixture,
    prompt: async (_id: string, text: unknown, mode: unknown) => {
      promptCalls.push({ text, mode });
      return { accepted: true, mode: "prompt" };
    },
    abort: async () => undefined,
    compact: async () => undefined,
  };
}

function makeFakeDashboard(): DashboardServiceLike {
  return {
    getStats: async () => ({
      working: 0,
      needAttention: 0,
      todayDone: 0,
      todayMessages: 0,
      weekCommits: 0,
      streak: 0,
      weekMessages: 0,
      weekDone: 0,
      todayDoneSessions: [],
      workingSessions: [],
      attentionSessions: [],
      bySource: emptySourceStats(),
    }),
    listNotifications: async () => ({ notifications: [], unreadCount: 0 }),
    markAllRead: async () => undefined,
    markRead: async () => 0,
  };
}

async function startServer(promptCalls: PromptCall[]) {
  const app = await createApp({
    hub: makeFakeHub(promptCalls),
    kpi: { getCards: () => [] },
    dashboard: makeFakeDashboard(),
    config: { ...DEFAULT_CONFIG },
    systemInfo: async () => systemFixture,
    webRoot: null, appLock: fakeUnlockedAppLock(),
    logger: false,
  });
  const wshub = new WsHub();
  wshub.attach(app.server, makeFakeHub(promptCalls) as unknown as SessionHub, { auth: { enabled: false, token: "" } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return { app, wshub, url: `ws://127.0.0.1:${port}/ws/sessions/sess-1` };
}

describe("ws: 握手竞态——连接即发的消息不丢", () => {
  it("open 后立即发 ping 必收 pong，立即发 prompt 不被丢弃", async () => {
    const promptCalls: PromptCall[] = [];
    const { app, wshub, url } = await startServer(promptCalls);
    const ws = new WebSocket(url);
    try {
      // 不等握手事件缓冲，open 后立刻连发两条（复现验收实测的丢消息时序）
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "ping" }));
        ws.send(JSON.stringify({ type: "prompt", text: "hello", mode: "prompt" }));
      });
      const events: Array<{ type?: string }> = [];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("5s 内未收到 pong（消息被丢弃）")), 5000);
        ws.on("message", (raw: Buffer) => {
          const ev = JSON.parse(raw.toString()) as { type?: string };
          events.push(ev);
          if (ev.type === "pong") {
            clearTimeout(timer);
            resolve();
          }
        });
        ws.on("error", reject);
      });
      // ping 的 pong 必达
      assert.ok(events.some((e) => e.type === "pong"));
      // prompt 也必须被处理（pending 队列消费）——给 handleClientMessage 一拍
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(promptCalls.length, 1);
      assert.equal(promptCalls[0].text, "hello");
    } finally {
      ws.terminate();
      wshub.closeAll();
      await app.close();
    }
  });
});

describe("ws: 关闭不挂起（SIGINT 场景）", () => {
  it("有活跃 WS 客户端时 closeAll + app.close 在 2 秒内完成", async () => {
    const promptCalls: PromptCall[] = [];
    const { app, wshub, url } = await startServer(promptCalls);
    const ws = new WebSocket(url);
    try {
      // 等握手完成、连接进入 clients map（证明是“活跃连接”）
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      await new Promise((r) => setTimeout(r, 100));
      const startedAt = Date.now();
      wshub.closeAll();
      await app.close();
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 2000, `关闭耗时 ${elapsed}ms，超过 2000ms 上限`);
    } finally {
      ws.terminate();
    }
  });
});

describe("ws: 子代理 childTails acquire/release 严格配对（AC8 回归）", () => {
  it("子会话消失 release 一次；连接关闭不二次 release（不误减其它连接同 id tail 的 ref）", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const childA: SessionListItem = { ...sessionFixture, id: "child-a", sessionFile: "/tmp/child-a.jsonl" };
    const childB: SessionListItem = { ...sessionFixture, id: "child-b", sessionFile: "/tmp/child-b.jsonl" };
    let children: SessionListItem[] = [childA];
    const acquires = new Map<string, number>();
    const releases = new Map<string, number>();
    const count = (m: Map<string, number>, id: string): void => {
      m.set(id, (m.get(id) ?? 0) + 1);
    };
    const fakeTails = {
      acquire: (id: string) => count(acquires, id),
      release: (id: string) => count(releases, id),
      detach: () => undefined,
      stopAll: () => undefined,
    };
    const hub = {
      ...makeFakeHub([]),
      isLive: () => false,
      listChildren: async () => children,
    };
    const app = await createApp({
      hub: hub as unknown as SessionHubLike,
      kpi: { getCards: () => [] },
      dashboard: makeFakeDashboard(),
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      webRoot: null, appLock: fakeUnlockedAppLock(),
      logger: false,
    });
    const wshub = new WsHub();
    wshub.childScanMs = 50; // 测试注入短扫描间隔
    wshub.attach(app.server, hub as unknown as SessionHub, {
      tailManager: fakeTails as unknown as SessionTailManager,
      auth: { enabled: false, token: "" },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/sess-1`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      await sleep(250); // 首轮 syncChildren：发现 child-a
      assert.equal(acquires.get("child-a"), 1, "发现子会话即 acquire");

      children = []; // 子会话消失 → release 一次（同步移除追踪）
      await sleep(250);
      assert.equal(releases.get("child-a") ?? 0, 1, "消失时 release 恰一次");

      children = [childB]; // 新子会话 → 重新 acquire
      await sleep(250);
      assert.equal(acquires.get("child-b"), 1);

      ws.terminate(); // 连接关闭：cleanup 只 release 仍在追踪的
      await sleep(250);
      assert.equal(releases.get("child-a"), 1, "child-a 消失时已 release，cleanup 不得二次 release（误减其它连接的 ref）");
      assert.equal(releases.get("child-b"), 1, "仍在追踪的 child-b 由 cleanup 释放");
      assert.equal(releases.get("sess-1"), 1, "父会话 tail 释放");
      for (const id of ["child-a", "child-b", "sess-1"]) {
        assert.equal(acquires.get(id), releases.get(id), `${id} acquire/release 严格配对`);
      }
    } finally {
      ws.terminate();
      wshub.closeAll();
      await app.close();
    }
  });
});

describe("ws: upgrade 鉴权（config.auth.enabled 时必须携带 token）", () => {
  type OpenResult = "open" | "denied" | "timeout";

  function tryOpen(url: string, opts?: { headers?: Record<string, string>; protocols?: string[] }): Promise<OpenResult> {
    return new Promise((resolve) => {
      const ws = opts?.protocols ? new WebSocket(url, opts.protocols, { headers: opts.headers }) : new WebSocket(url, opts);
      const timer = setTimeout(() => {
        ws.terminate();
        resolve("timeout");
      }, 2000);
      ws.on("open", () => {
        clearTimeout(timer);
        ws.terminate();
        resolve("open");
      });
      ws.on("error", () => {
        clearTimeout(timer);
        resolve("denied");
      });
      ws.on("unexpected-response", (_req, res) => {
        clearTimeout(timer);
        ws.terminate();
        resolve(res.statusCode === 401 ? "denied" : "timeout");
      });
    });
  }

  async function startAuthedServer(auth: { enabled: boolean; token: string }) {
    const app = await createApp({
      hub: makeFakeHub([]),
      kpi: { getCards: () => [] },
      dashboard: makeFakeDashboard(),
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      webRoot: null,
      appLock: fakeUnlockedAppLock(),
    });
    const wshub = new WsHub();
    wshub.attach(app.server, makeFakeHub([]) as unknown as SessionHub, { auth });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    return { app, wshub, base: `ws://127.0.0.1:${port}` };
  }

  it("无 token / 错 token：会话与全局通道一律断连；query/header/子协议三种通道均可鉴权", async () => {
    const { app, wshub, base } = await startAuthedServer({ enabled: true, token: "s3cret" });
    try {
      // 无 token / 错 token → 拒绝（401 断连）
      assert.equal(await tryOpen(`${base}/ws/sessions/sess-1`), "denied", "无 token 必须拒连");
      assert.equal(await tryOpen(`${base}/ws/sessions/sess-1?token=wrong`), "denied", "错 token 必须拒连");
      assert.equal(
        await tryOpen(`${base}/ws/sessions/sess-1`, { headers: { authorization: "Bearer wrong" } }),
        "denied",
      );
      assert.equal(await tryOpen(`${base}/ws/events`), "denied", "全局通道同样受鉴权保护");
      // 三种 token 通道（与 HTTP 鉴权同口径）
      assert.equal(await tryOpen(`${base}/ws/sessions/sess-1?token=s3cret`), "open", "query ?token=");
      assert.equal(
        await tryOpen(`${base}/ws/sessions/sess-1`, { headers: { authorization: "Bearer s3cret" } }),
        "open",
        "Authorization: Bearer",
      );
      assert.equal(
        await tryOpen(`${base}/ws/sessions/sess-1`, { protocols: ["bearer", "s3cret"] }),
        "open",
        "Sec-WebSocket-Protocol: bearer, <token>",
      );
      assert.equal(await tryOpen(`${base}/ws/events?token=s3cret`), "open", "全局通道带 token 可连");
    } finally {
      wshub.closeAll();
      await app.close();
    }
  });

  it("auth 未启用：不带 token 照常连接（默认行为不变）", async () => {
    const { app, wshub, base } = await startAuthedServer({ enabled: false, token: "" });
    try {
      assert.equal(await tryOpen(`${base}/ws/sessions/sess-1`), "open");
    } finally {
      wshub.closeAll();
      await app.close();
    }
  });
});

describe("ws: 连接建立期断连不泄漏 socket / childScan interval", () => {
  it("findSession 未返回前连接即关闭：clients Map 不残留死 socket，interval 不启动", async () => {
    const promptCalls: PromptCall[] = [];
    let childScans = 0;
    const hub = {
      ...makeFakeHub(promptCalls),
      isLive: () => false,
      // 只有 childScan interval 泄漏才会被调用（ready 前关闭的连接不该走到这里）
      listChildren: async () => {
        childScans += 1;
        return [];
      },
    } as unknown as SessionHub;
    const app = await createApp({
      hub: hub as unknown as SessionHubLike,
      kpi: { getCards: () => [] },
      dashboard: makeFakeDashboard(),
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      webRoot: null,
      appLock: fakeUnlockedAppLock(),
    });
    const wshub = new WsHub();
    wshub.childScanMs = 30;
    const acquireIds: string[] = [];
    const fakeTails = {
      acquire: (id: string) => acquireIds.push(id),
      release: () => undefined,
      detach: () => undefined,
      stopAll: () => undefined,
    };
    // findSession 延迟 200ms：制造 close 先于 IIFE 继续执行的竞态窗口
    const delayedHub = {
      ...hub,
      findSession: () => new Promise((r) => setTimeout(() => r(sessionFixture), 200)),
    } as unknown as SessionHub;
    wshub.attach(app.server, delayedHub, {
      tailManager: fakeTails as unknown as SessionTailManager,
      auth: { enabled: false, token: "" },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/sess-1`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      ws.terminate(); // 立刻断连：close 先于 findSession(200ms) 返回
      await new Promise((r) => setTimeout(r, 500)); // 跨过 IIFE 恢复与至少 10 个 scan 周期

      const clients = (wshub as unknown as { clients: Map<string, Set<unknown>> }).clients;
      assert.equal(clients.size, 0, "死 socket 不得永驻 clients Map");
      assert.equal(childScans, 0, "childScan interval 不得启动/泄漏（否则 listChildren 持续被扫）");
      assert.deepEqual(acquireIds, [], "断连后不得 acquire tail（防 ref 泄漏）");
    } finally {
      ws.terminate();
      wshub.closeAll();
      await app.close();
    }
  });
});

describe("ws: abort 门禁与分发（修复：绕过 promptGuard，锁屏/接管期可中止 turn）", () => {
  /** 锁屏 fake：应用锁已配置且令牌恒无效（与 promptGuard 锁分支同判据 → 拒绝） */
  function fakeLockedAppLock(): AppLockStoreLike {
    return {
      status: () => ({ configured: true, webauthn: false, expiresAt: null }),
      setup: () => {
        throw new Error("fakeLockedAppLock.setup 未实现");
      },
      unlock: () => {
        throw new Error("fakeLockedAppLock.unlock 未实现");
      },
      change: () => {
        throw new Error("fakeLockedAppLock.change 未实现");
      },
      disable: () => {
        throw new Error("fakeLockedAppLock.disable 未实现");
      },
      verifyToken: () => ({ ok: false, expiresAt: null }),
      createChallenge: () => {
        throw new Error("fakeLockedAppLock.createChallenge 未实现");
      },
      consumeChallenge: () => {
        throw new Error("fakeLockedAppLock.consumeChallenge 未实现");
      },
      registerWebAuthn: () => {
        throw new Error("fakeLockedAppLock.registerWebAuthn 未实现");
      },
      loginWebAuthn: () => {
        throw new Error("fakeLockedAppLock.loginWebAuthn 未实现");
      },
    };
  }

  interface AbortHarness {
    app: Awaited<ReturnType<typeof createApp>>;
    wshub: WsHub;
    ws: WebSocket;
    abortCalls: string[];
    abortTurnCalls: string[];
    errors: Array<{ type?: string; code?: string; message?: string }>;
    sendAbort(): void;
    waitForErrorFrame(): Promise<{ type?: string; code?: string; message?: string }>;
    waitForCalls(calls: unknown[], label: string): Promise<void>;
    close(): Promise<void>;
  }

  /** 走生产装配 attachSessionWs（abortHandler 由它派生）+ 真 WS 连接的 abort 测试骨架 */
  async function startAbortServer(opts: {
    appLock: AppLockStoreLike;
    /** 会话来源（镜像 HTTP /abort：仅 claude 源且驱动接管中走 driver.abortTurn） */
    source: SessionListItem["source"];
    /** claude 驱动接管中 */
    attached: boolean;
  }): Promise<AbortHarness> {
    const abortCalls: string[] = [];
    const abortTurnCalls: string[] = [];
    const errors: Array<{ type?: string; code?: string; message?: string }> = [];
    const session: SessionListItem = { ...sessionFixture, source: opts.source };
    const wsHub: WsSessionHub = {
      isLive: () => false,
      findSession: async (id: string) => (id === session.id ? session : null),
      prompt: async () => ({ accepted: true, mode: "prompt" }),
      abort: async (id: string) => {
        abortCalls.push(id);
      },
    };
    const app = await createApp({
      hub: makeFakeHub([]),
      kpi: { getCards: () => [] },
      dashboard: makeFakeDashboard(),
      config: { ...DEFAULT_CONFIG },
      systemInfo: async () => systemFixture,
      webRoot: null,
      appLock: fakeUnlockedAppLock(),
      logger: false,
    });
    const wshub = new WsHub();
    attachSessionWs(app.server, wsHub, {
      wshub,
      config: { ...DEFAULT_CONFIG },
      appLock: opts.appLock,
      claudeDriver: {
        isAttached: () => opts.attached,
        abortTurn: (id: string) => {
          abortTurnCalls.push(id);
        },
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/sess-1`);
    // 消息监听必须先于 open 挂好（握手确认帧可能与 101 同批到达，等 open 再挂会丢帧——
    // 见 terminal-route.test.ts connectAndFirstMessage 注释）
    let resolveSession: (() => void) | null = null;
    const sessionFrame = new Promise<void>((resolve) => {
      resolveSession = resolve;
    });
    ws.on("message", (raw: Buffer) => {
      const ev = JSON.parse(raw.toString()) as { type?: string; code?: string; message?: string };
      if (ev.type === "session") resolveSession?.();
      if (ev.type === "error") errors.push(ev);
    });
    // 建立 + 握手确认帧：连接进入 ready（此后 abort 不再进 pending 队列）。
    // 任一步失败即回收全部句柄（app/wshub/ws），防泄漏句柄挂住整个测试进程
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      await Promise.race([
        sessionFrame,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("握手确认帧未达")), 2000)),
      ]);
    } catch (err) {
      ws.terminate();
      wshub.closeAll();
      await app.close();
      throw err;
    }
    const waitForErrorFrame = async (): Promise<{ type?: string; code?: string; message?: string }> => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (errors.length > 0) return errors[0];
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("2s 内未收到 error 帧（abort 未被拒绝）");
    };
    const waitForCalls = async (calls: unknown[], label: string): Promise<void> => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (calls.length > 0) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`2s 内 ${label} 未被调用`);
    };
    return {
      app,
      wshub,
      ws,
      abortCalls,
      abortTurnCalls,
      errors,
      sendAbort: () => ws.send(JSON.stringify({ type: "abort" })),
      waitForErrorFrame,
      waitForCalls,
      close: async () => {
        ws.terminate();
        wshub.closeAll();
        await app.close();
      },
    };
  }

  it("锁屏（应用锁已配置未解锁）：WS abort 被拒（APP_LOCKED error 帧），hub.abort 不被调用", async () => {
    const h = await startAbortServer({ appLock: fakeLockedAppLock(), source: "pi", attached: false });
    try {
      h.sendAbort();
      const err = await h.waitForErrorFrame();
      assert.equal(err.type, "error", "回 error 帧（对齐 prompt 分支回执形状）");
      assert.equal(err.code, "APP_LOCKED", "锁屏拒绝 code 与 promptGuard 锁分支同口径");
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(h.abortCalls, [], "锁屏时 hub.abort 不得被调用");
      assert.deepEqual(h.abortTurnCalls, [], "锁屏时 driver.abortTurn 不得被调用");
    } finally {
      await h.close();
    }
  });

  it("claude 驱动接管期：WS abort 走 driver.abortTurn（fake driver 断言），hub.abort 不被调用", async () => {
    const h = await startAbortServer({ appLock: fakeUnlockedAppLock(), source: "claude", attached: true });
    try {
      h.sendAbort();
      await h.waitForCalls(h.abortTurnCalls, "driver.abortTurn");
      assert.deepEqual(h.abortTurnCalls, ["sess-1"], "接管期中止走 driver.abortTurn（control interrupt）");
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(h.abortCalls, [], "接管期不得走 hub.abort（adapter 杀进程路径）");
      assert.deepEqual(h.errors, [], "成功中止不回 error 帧");
    } finally {
      await h.close();
    }
  });

  it("非接管期：WS abort 走 hub.abort（分发基线）", async () => {
    const h = await startAbortServer({ appLock: fakeUnlockedAppLock(), source: "claude", attached: false });
    try {
      h.sendAbort();
      await h.waitForCalls(h.abortCalls, "hub.abort");
      assert.deepEqual(h.abortCalls, ["sess-1"]);
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(h.abortTurnCalls, [], "未接管不得走 driver.abortTurn");
      assert.deepEqual(h.errors, [], "成功中止不回 error 帧");
    } finally {
      await h.close();
    }
  });

  it("非 claude 源会话即使驱动报接管中也走 hub.abort（镜像 HTTP /abort 的 source 判定）", async () => {
    const h = await startAbortServer({ appLock: fakeUnlockedAppLock(), source: "pi", attached: true });
    try {
      h.sendAbort();
      await h.waitForCalls(h.abortCalls, "hub.abort");
      assert.deepEqual(h.abortCalls, ["sess-1"]);
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(h.abortTurnCalls, [], "pi 源不得走 driver.abortTurn");
    } finally {
      await h.close();
    }
  });
});

describe("ws: 畸形百分号 sessionId 不崩服（pre-auth DoS 回归）", () => {
  type OpenResult = "open" | "denied" | "timeout";

  function tryOpen(url: string): Promise<OpenResult> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.terminate();
        resolve("timeout");
      }, 2000);
      ws.on("open", () => {
        clearTimeout(timer);
        ws.terminate();
        resolve("open");
      });
      ws.on("error", () => {
        clearTimeout(timer);
        resolve("denied");
      });
      ws.on("unexpected-response", (_req, res) => {
        clearTimeout(timer);
        ws.terminate();
        resolve(res.statusCode === 400 ? "denied" : "timeout");
      });
    });
  }

  it("decodeURIComponent 抛 URIError 的 sessionId（%ZZ / %）：upgrade 拒绝且进程存活，后续连接正常", async () => {
    const { app, wshub, url } = await startServer([]);
    const base = url.replace(/\/ws\/sessions\/[^/]+$/, "");
    try {
      // 失败路径：畸形百分号编码必须被拒（400 断连），而不是抛 uncaughtException 崩掉整个 hub
      assert.equal(await tryOpen(`${base}/ws/sessions/%ZZ`), "denied", "畸形 %ZZ 必须拒连");
      assert.equal(await tryOpen(`${base}/ws/sessions/%`), "denied", "裸 % 必须拒连");
      assert.equal(await tryOpen(`${base}/ws/sessions/%E0%A4%A`), "denied", "截断 UTF-8 序列必须拒连");
      // 进程存活证明：同一 server 上正常会话与全局通道仍可连（崩服则此处超时/拒绝）
      assert.equal(await tryOpen(`${base}/ws/sessions/sess-1`), "open", "正常 sessionId 不受影响");
      assert.equal(await tryOpen(`${base}/ws/events`), "open", "全局通道不受影响");
    } finally {
      wshub.closeAll();
      await app.close();
    }
  });
});
