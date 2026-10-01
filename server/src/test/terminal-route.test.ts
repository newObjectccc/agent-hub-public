/**
 * ttyd Web 终端（F2，契约 §13）路由 + 同源反代集成测试。
 * mock ttyd = 真实 http + ws 上游服务；TerminalService 用 fake spawn 把“监听端口”
 * 指向上游，从而真实走一遍：签发 token → /terminal/* 反代（HTML shim 注入 / 资源转发 /
 * 401 令牌校验）→ /terminal/ws upgrade 字节流管道 → hub /ws 通道不受影响。
 */
import { strict as assert } from "node:assert";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { WebSocket, WebSocketServer } from "ws";
import { DEFAULT_CONFIG } from "../config.js";
import { createApp } from "../index.js";
import type { SessionHubLike } from "../routes.js";
import { TerminalService, type TerminalChildProcess, type TerminalSpawnFn } from "../terminal.js";
import type { MessageDto, SearchResultDto, SessionListItem, SystemInfo } from "../types.js";
import { WsHub } from "../ws.js";
import { makeFakeDashboard } from "./fakeDashboard.js";

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
  ttyd: { available: true, version: "1.7.7" },
  tailscale: { available: false, version: null, loggedIn: false, hostname: null },
  sessionDir: "/tmp/sessions",
  workspaceRoot: "/tmp/ws",
  metrics: null,
};

function makeFakeHub(): SessionHubLike {
  return {
    getStatus: () => "idle",
    listSessions: async () => [sessionFixture],
    findSession: async (id: string) => (id === "sess-1" ? sessionFixture : null),
    loadMessages: async (): Promise<MessageDto[]> => [],
    search: async (): Promise<SearchResultDto[]> => [],
    loadTree: async () => null,
    createSession: async () => sessionFixture,
    forkSession: async () => sessionFixture,
    prompt: async () => ({ accepted: true, mode: "prompt" as const }),
    abort: async () => undefined,
    compact: async () => undefined,
  };
}

// ---------- mock ttyd（真实 http + ws 上游） ----------

interface MockTtyd {
  port: number;
  httpServer: Server;
  /** 收到的反代请求鉴权头（应为随机 Basic 凭证，且非空） */
  authHeaders: Array<string | undefined>;
  /** 收到的 upgrade 请求路径（应为 /ws） */
  upgradePaths: string[];
  close(): Promise<void>;
}

async function startMockTtyd(): Promise<MockTtyd> {
  const authHeaders: Array<string | undefined> = [];
  const upgradePaths: string[] = [];
  const httpServer = createServer((req: IncomingMessage, res) => {
    authHeaders.push(req.headers.authorization);
    const path = (req.url ?? "").split("?")[0];
    if (path === "/" || path === "/terminal/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<html><head><title>ttyd</title></head><body><script src="/assets/main.js"></script><script>new WebSocket("ws://" + location.host + "/ws");</script></body></html>`,
      );
      return;
    }
    if (path === "/assets/main.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end("console.log('ttyd');");
      return;
    }
    res.writeHead(404).end("nope");
  });
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    upgradePaths.push((req.url ?? "").split("?")[0]);
    authHeaders.push(req.headers.authorization);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send("welcome");
      ws.on("message", (raw) => ws.send(`echo:${String(raw)}`));
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    port,
    httpServer,
    authHeaders,
    upgradePaths,
    close: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/** fake spawn：假装 ttyd 已监听在 mock 上游端口（日志行驱动服务端口采纳） */
function spawnToMock(port: number): TerminalSpawnFn {
  const spawnFn: TerminalSpawnFn = () => {
    const handlers = new Map<string, Array<(...args: never[]) => void>>();
    const add = (event: string, cb: (...args: never[]) => void): void => {
      handlers.set(event, [...(handlers.get(event) ?? []), cb]);
    };
    const child = {
      stdout: { on: (event: string, cb: (chunk: Buffer | string) => void) => add(`stdout:${event}`, cb as never) },
      stderr: { on: (event: string, cb: (chunk: Buffer | string) => void) => add(`stderr:${event}`, cb as never) },
      on: (event: string, cb: (...args: never[]) => void) => {
        add(event, cb);
        return child;
      },
      kill: () => true,
    };
    queueMicrotask(() => {
      for (const cb of handlers.get("stderr:data") ?? []) cb(`Listening on '127.0.0.1:${port}'\n` as never);
    });
    return child as unknown as TerminalChildProcess;
  };
  return spawnFn;
}

function fakeExec(installed: boolean) {
  return ((cmd: string, args: string[], _o: unknown, cb: (err: Error | null, out: string) => void) => {
    queueMicrotask(() => {
      if ((cmd === "which" || cmd === "where") && args[0] === "ttyd") {
        cb(installed ? null : new Error("not found"), installed ? "/usr/local/bin/ttyd\n" : "");
        return;
      }
      cb(installed ? null : new Error("not found"), installed ? "ttyd version 1.7.7\n" : "");
    });
  }) as never;
}

function once(socket: WebSocket, event: "message" | "open" | "error" | "close"): Promise<unknown> {
  return new Promise((resolve) => socket.once(event, resolve));
}

/** 防挂死：WS 断言一律带超时（丢帧/握手卡住时报错而不是卡住整个套件） */
function withTimeout<T>(promise: Promise<T>, label: string, ms = 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时：${label}`)), ms);
    void promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 消息监听必须先于 open 挂好（welcome 帧可能与握手同批到达，先 await open 会丢帧） */
function connectAndFirstMessage(url: string): Promise<{ socket: WebSocket; first: Promise<unknown> }> {
  const socket = new WebSocket(url);
  const first = once(socket, "message");
  return withTimeout(once(socket, "open"), `WS 握手 ${url}`).then(() => ({ socket, first }));
}

describe("terminal: 路由 + 同源反代（mock ttyd 链路）", () => {
  let mock: MockTtyd;
  let app: FastifyInstance;
  let svc: TerminalService;
  let base: string;
  let unlocked = true;
  let token = "";

  before(async () => {
    mock = await startMockTtyd();
    const spawnFn = spawnToMock(mock.port);
    svc = new TerminalService({
      platform: "darwin",
      execFileFn: fakeExec(true),
      spawnFn,
      readyTimeoutMs: 2_000,
    });
    app = await createApp({
      hub: makeFakeHub(),
      kpi: { getCards: () => [] },
      config: DEFAULT_CONFIG,
      systemInfo: async () => ({ ...systemFixture, terminal: await svc.status() }),
      dashboard: makeFakeDashboard(),
      terminal: svc,
      terminalUnlocked: () => unlocked,
      webRoot: null,
    });
    // WsHub 在反代之后挂载（与 startHub 顺序一致）：验证 /terminal/ws 不被 hub upgrade 处理器误杀
    const wshub = new WsHub();
    wshub.attach(app.server, {
      isLive: () => false,
      findSession: async (id: string) => (id === "sess-1" ? sessionFixture : null),
      prompt: async () => ({ accepted: true, mode: "prompt" }),
      abort: async () => undefined,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    svc.dispose();
    await app.close();
    await mock.close();
  });

  it("GET /api/terminal/status：已安装未运行 + /api/system 带 terminal 运行态", async () => {
    const status = await (await fetch(`${base}/api/terminal/status`)).json();
    assert.equal(status.supported, true);
    assert.equal(status.installed, true);
    assert.equal(status.running, false);
    assert.equal(status.version, "1.7.7");
    const system = await (await fetch(`${base}/api/system`)).json();
    assert.equal(system.terminal.running, false);
    assert.equal(system.ttyd.available, true);
  });

  it("POST /api/terminal/session：应用锁门禁（F1 预留）401", async () => {
    unlocked = false;
    const res = await fetch(`${base}/api/terminal/session`, { method: "POST" });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, "UNAUTHORIZED");
    unlocked = true;
  });

  it("POST /api/terminal/session：签发同源反代 URL（token 能力凭证）", async () => {
    const res = await fetch(`${base}/api/terminal/session`, { method: "POST" });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.match(body.url, /^\/terminal\/\?t=/);
    assert.ok(typeof body.expiresAt === "string");
    token = decodeURIComponent(body.url.split("?t=")[1]);
    const status = await (await fetch(`${base}/api/terminal/status`)).json();
    assert.equal(status.running, true, "ensureSession 后 ttyd 在运行");
  });

  it("GET /terminal/?t=：HTML 反代 + shim 注入 + HttpOnly cookie", async () => {
    const res = await fetch(`${base}/terminal/?t=${encodeURIComponent(token)}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("data-agent-hub-terminal-shim"), "注入 WS shim");
    assert.ok(html.includes('"/terminal/ws"'), "/ws 改写到 /terminal/ws");
    assert.ok(html.includes('src="/terminal/assets/main.js"'), "绝对资源路径改写");
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.ok(setCookie.startsWith("hub-terminal-token="), `种 token cookie: ${setCookie}`);
    assert.ok(setCookie.includes("HttpOnly"));
  });

  it("GET /terminal/assets/main.js：资源反代（cookie 亦可鉴权，无需查询串）", async () => {
    const withQuery = await fetch(`${base}/terminal/assets/main.js?t=${encodeURIComponent(token)}`);
    assert.equal(withQuery.status, 200);
    assert.equal(await withQuery.text(), "console.log('ttyd');");
    const withCookie = await fetch(`${base}/terminal/assets/main.js`, {
      headers: { cookie: `hub-terminal-token=${encodeURIComponent(token)}` },
    });
    assert.equal(withCookie.status, 200, "Cookie 通道鉴权");
    // 上游收到的应是随机 Basic 凭证（不是浏览器弹的原生认证）
    assert.ok(mock.authHeaders.some((h) => typeof h === "string" && h.startsWith("Basic ")));
  });

  it("无 token / 假 token → 401 错误信封", async () => {
    const noToken = await fetch(`${base}/terminal/`);
    assert.equal(noToken.status, 401);
    assert.equal((await noToken.json()).error.code, "UNAUTHORIZED");
    const bad = await fetch(`${base}/terminal/?t=forged`);
    assert.equal(bad.status, 401);
  });

  it("WS /terminal/ws：upgrade 字节流管道到 ttyd /ws（带 Basic 凭证），假 token 被拒", async () => {
    const { socket: ws, first } = await connectAndFirstMessage(`${base.replace("http", "ws")}/terminal/ws?t=${encodeURIComponent(token)}`);
    const welcome = await withTimeout(first, "ttyd welcome");
    assert.equal(String(welcome), "welcome");
    ws.send("ping");
    const echo = await withTimeout(once(ws, "message"), "ttyd echo");
    assert.equal(String(echo), "echo:ping");
    ws.close();
    await withTimeout(once(ws, "close"), "ws close");
    assert.ok(mock.upgradePaths.includes("/ws"), "上游看到的是 /ws（前缀已剥）");

    const forged = new WebSocket(`${base.replace("http", "ws")}/terminal/ws?t=forged`);
    const result = await withTimeout(
      Promise.race([
        once(forged, "open").then(() => "open"),
        once(forged, "error").then(() => "error"),
        once(forged, "close").then(() => "close"),
      ]),
      "假 token upgrade 拒绝",
    );
    assert.ok(result === "error" || result === "close", "假 token 的 upgrade 被拒绝");
  });

  it("hub /ws/events 通道不受反代影响（upgrade 处理器共存）", async () => {
    const { socket: ws, first } = await connectAndFirstMessage(`${base.replace("http", "ws")}/ws/events`);
    const hello = await withTimeout(first, "hub welcome");
    const parsed = JSON.parse(String(hello)) as { type?: string; id?: string };
    assert.equal(parsed.id, "events", "hub WS 握手确认照常");
    ws.close();
    await withTimeout(once(ws, "close"), "ws close");
  });

  it("POST /api/terminal/stop：回收 ttyd；随后反代 503", async () => {
    const res = await fetch(`${base}/api/terminal/stop`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { stopped: true });
    const proxied = await fetch(`${base}/terminal/?t=${encodeURIComponent(token)}`);
    assert.equal(proxied.status, 503);
    assert.equal((await proxied.json()).error.code, "TERMINAL_UNAVAILABLE");
    const status = await (await fetch(`${base}/api/terminal/status`)).json();
    assert.equal(status.running, false);
  });
});

describe("terminal: 未安装降级（路由）", () => {
  it("status 给安装提示；session 503 TERMINAL_UNAVAILABLE", async () => {
    const svc = new TerminalService({ platform: "darwin", execFileFn: fakeExec(false) });
    const app = await createApp({
      hub: makeFakeHub(),
      kpi: { getCards: () => [] },
      config: DEFAULT_CONFIG,
      systemInfo: async () => systemFixture,
      dashboard: makeFakeDashboard(),
      terminal: svc,
      webRoot: null,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    try {
      const status = await (await fetch(`${base}/api/terminal/status`)).json();
      assert.equal(status.installed, false);
      assert.equal(status.hint, "未安装（brew install ttyd）");
      const res = await fetch(`${base}/api/terminal/session`, { method: "POST" });
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.error.code, "TERMINAL_UNAVAILABLE");
      assert.ok(body.error.message.includes("brew install ttyd"), "带安装指引");
    } finally {
      svc.dispose();
      await app.close();
    }
  });

  it("terminal 未启用 → 503（缺省依赖）", async () => {
    const app = await createApp({
      hub: makeFakeHub(),
      kpi: { getCards: () => [] },
      config: DEFAULT_CONFIG,
      systemInfo: async () => systemFixture,
      dashboard: makeFakeDashboard(),
      webRoot: null,
    });
    try {
      const injected = await app.inject({ method: "GET", url: "/api/terminal/status" });
      assert.equal(injected.statusCode, 503);
      assert.equal(injected.json().error.code, "TERMINAL_UNAVAILABLE");
    } finally {
      await app.close();
    }
  });
});
