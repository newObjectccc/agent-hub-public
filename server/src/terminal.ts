/**
 * ttyd Web 终端（F2，契约 §13）：按需拉起 + 同源反代 + token 保护 + 生命周期回收。
 *
 * 设计（安全优先）：
 * - ttyd 仅绑定 127.0.0.1、随机高端口、随机 Basic 凭证；从不对外直接暴露。
 * - 浏览器只访问 server 的同源反代 `/terminal/*`（免 CORS / 免混合内容），token 能力
 *   URL（`?t=`）+ HttpOnly cookie 传递；token 校验不过一律 401/断连。
 * - 按需拉起：访问终端页时才 spawn ttyd；server 关闭 / 空闲超时自动回收。
 * - 跨平台：仅 POSIX（macOS/Linux）；win32 返回“不支持（WSL 内可用）”降级提示。
 *
 * 反代 HTML 注入一小段 shim：
 * - 覆写 window.WebSocket 把 ttyd 客户端写死的 `/ws` 改写为 `/terminal/ws`（否则会
 *   撞上 hub 自己的 /ws 事件通道）；同时把 token 带进 ws 查询串。
 * - 绝对路径资源（src|href 以 / 开头）改写到 /terminal/ 前缀下。
 */
import { execFile as nodeExecFile, spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { connect as netConnect } from "node:net";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorCodes, HubError } from "./errors.js";
import type { TerminalSessionDto, TerminalStatusDto } from "./types.js";

/** 同源反代前缀（SPA 路由 /terminal 恰好不带斜杠，与 /terminal/* 反代不冲突） */
export const TERMINAL_PREFIX = "/terminal";
/** upgrade 请求已被本反代接管的标记（ws.ts 据此不销毁 socket） */
export const UPGRADE_HANDLED_MARK = "__agentHubUpgradeHandled";

const TOKEN_COOKIE = "hub-terminal-token";
const DEFAULT_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_READY_TIMEOUT_MS = 8_000;
const DEFAULT_PROBE_TTL_MS = 30_000;
const DEFAULT_GIT_STYLE_TIMEOUT_MS = 5_000;

/** 降级提示（未安装时给安装命令；跨平台文案不同） */
export function installHint(platform: NodeJS.Platform | string): string {
  if (platform === "darwin") return "未安装（brew install ttyd）";
  if (platform === "linux") return "未安装（sudo apt install ttyd）";
  return "未安装（安装 ttyd 后可用）";
}

/** Windows 降级文案（WSL 内部可用） */
export const WINDOWS_UNSUPPORTED_HINT = "不支持（WSL 内可用）";

/** 从 ttyd 启动日志解析监听端口（libwebsockets：Listening on '127.0.0.1:7681' / Listening on port 7681） */
export function parseTtydListenPort(output: string): number | null {
  const quoted = /listening on\s+'[^']*:(\d+)'/i.exec(output);
  if (quoted) {
    const port = Number.parseInt(quoted[1], 10);
    return Number.isFinite(port) && port > 0 ? port : null;
  }
  const bare = /listening on\s+port\s+(\d+)/i.exec(output);
  if (bare) {
    const port = Number.parseInt(bare[1], 10);
    return Number.isFinite(port) && port > 0 ? port : null;
  }
  return null;
}

export interface TtydSpawnPlan {
  bin: string;
  args: string[];
  /** Basic 凭证（server 自用，绝不进日志/错误文案/响应） */
  credential: string;
}

/**
 * 构造 ttyd 启动计划：loopback 绑定 + 随机高端口 + 随机 Basic 凭证 + 可写终端。
 * 注：`--writable` 忙 ttyd ≥ 1.7（默认只读）；命令为登录 shell（tmux 可在 shell 内自行 attach）。
 */
export function buildTtydSpawnPlan(options: {
  port: number;
  shell: string;
  randomToken?: () => string;
}): TtydSpawnPlan {
  const randomToken = options.randomToken ?? (() => randomBytes(18).toString("base64url"));
  const credential = `hub:${randomToken()}`;
  return {
    bin: "ttyd",
    args: [
      "--port",
      String(options.port),
      "--interface",
      "127.0.0.1",
      "--writable",
      "--credential",
      credential,
      "--client-option",
      "fontSize=14",
      options.shell,
    ],
    credential,
  };
}

/**
 * 反代 HTML shim 注入：
 * 1) WebSocket 覆写：ttyd 客户端写死的 `/ws` → `/terminal/ws`，并透传 token 查询串；
 * 2) 绝对路径资源改写到 /terminal/ 前缀下（相对路径天然落在前缀内，无需处理）。
 */
export function injectTerminalShim(html: string): string {
  const shim = `<script data-agent-hub-terminal-shim>(function(){var Orig=window.WebSocket;if(!Orig)return;function rewrite(u){try{var url=new URL(u,window.location.href);if(url.pathname==="/ws"||url.pathname==="/ws/"){url.pathname="${TERMINAL_PREFIX}/ws";var t=new URLSearchParams(window.location.search).get("t");if(t)url.searchParams.set("t",t);}return url.toString();}catch(e){return u;}}function Patched(url,protocols){return protocols===undefined?new Orig(rewrite(url)):new Orig(rewrite(url),protocols);}Patched.prototype=Orig.prototype;Patched.CONNECTING=Orig.CONNECTING;Patched.OPEN=Orig.OPEN;Patched.CLOSING=Orig.CLOSING;Patched.CLOSED=Orig.CLOSED;window.WebSocket=Patched;})();</script>`;
  const withAssets = html.replace(/(\s(?:src|href)=["'])\/(?!terminal\/)/g, `$1${TERMINAL_PREFIX}/`);
  if (/<head[^>]*>/i.test(withAssets)) return withAssets.replace(/<head[^>]*>/i, (m) => `${m}${shim}`);
  return shim + withAssets;
}

/**
 * 日志脱敏（P2）：终端 token 走 `?t=` URL 能力链接，而 pino/Fastify 请求日志默认记 req.url——
 * 令牌会随访问日志落盘/外送。凡查询键为 `t` / `token` / `*token*` / secret / password /
 * sig / auth / credential 等敏感名，其值一律替换为 [REDACTED]（path 与非敏感查询保留原样）。
 */
const SENSITIVE_QUERY_KEY_RE = /^(t|token|access[_-]?token|.*token.*|secret|.*secret.*|password|passwd|pwd|sig|signature|auth|authorization|credential|api[_-]?key|key)$/i;

export function redactUrlSecrets(url: string): string {
  const qIndex = url.indexOf("?");
  if (qIndex < 0) return url;
  const path = url.slice(0, qIndex);
  const parts = url.slice(qIndex + 1).split("&").map((part) => {
    const eq = part.indexOf("=");
    if (eq < 0) return part;
    const key = part.slice(0, eq);
    return SENSITIVE_QUERY_KEY_RE.test(key) ? `${key}=[REDACTED]` : part;
  });
  return `${path}?${parts.join("&")}`;
}

/** 从 URL 查询串 / Cookie 提取终端 token */
export function tokenFrom(url: string | undefined, cookieHeader: string | undefined): string | null {
  const query = (url ?? "").split("?")[1] ?? "";
  for (const part of query.split("&")) {
    const [k, v] = part.split("=");
    if (k === "t" && v) return decodeURIComponent(v);
  }
  for (const part of (cookieHeader ?? "").split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === TOKEN_COOKIE && v) return decodeURIComponent(v);
  }
  return null;
}

/** 剥离 hop-by-hop 头（逐跳语义，不能透传） */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function filterHeaders(headers: IncomingMessage["headers"], drop: string[] = []): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || drop.includes(lower) || value === undefined) continue;
    out[lower] = value;
  }
  return out;
}

// ---------- 子进程接口（测试可注入 fake） ----------

export interface TerminalChildProcess {
  stdout: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "exit", cb: (code: number | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type TerminalSpawnFn = (
  bin: string,
  args: string[],
  options: { windowsHide?: boolean },
) => TerminalChildProcess;

/** 默认真实 spawn（签名与 TerminalSpawnFn 兼容） */
const realSpawn: TerminalSpawnFn = (bin, args, options) =>
  nodeSpawn(bin, args, { ...options, stdio: ["ignore", "pipe", "pipe"] }) as unknown as TerminalChildProcess &
    ChildProcess;

/** 端口分配：让内核给一个随机高端口（短暂占用后释放，交给 ttyd 绑定） */
export function allocPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error("端口分配失败"))));
    });
  });
}

function tcpReachable(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ port, host: "127.0.0.1" });
    const done = (ok: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

// ---------- 服务接口（路由可注入 fake） ----------

export interface TerminalProxyTarget {
  port: number;
  credential: string;
}

export interface TerminalServiceLike {
  status(): Promise<TerminalStatusDto>;
  /** 需要时拉起 ttyd 并签发访问 token（同源反代 URL） */
  ensureSession(): Promise<TerminalSessionDto>;
  stop(): Promise<void>;
}

export interface TerminalRuntime extends TerminalServiceLike {
  validateToken(token: string | null | undefined): boolean;
  /** 反代有流量时刷新空闲计时 */
  touch(): void;
  proxyTarget(): TerminalProxyTarget | null;
}

export interface TerminalServiceOptions {
  platform?: NodeJS.Platform | string;
  execFileFn?: typeof nodeExecFile;
  spawnFn?: TerminalSpawnFn;
  now?: () => number;
  shell?: string;
  /** 无反代流量多久回收 ttyd（默认 30min） */
  idleMs?: number;
  readyTimeoutMs?: number;
  /** 工具探测缓存（默认 30s） */
  probeTtlMs?: number;
  tokenTtlMs?: number;
}

interface StartedTtyd {
  child: TerminalChildProcess;
  port: number;
  credential: string;
}

/**
 * ttyd 生命周期管理：探测 → 按需拉起 → token 签发/校验 → 空闲/关闭回收。
 * 单实例复用：已运行则只签发新 token，不重复 spawn。
 */
export class TerminalService implements TerminalRuntime {
  private readonly options: Required<Pick<TerminalServiceOptions, "idleMs" | "readyTimeoutMs" | "probeTtlMs" | "tokenTtlMs">> &
    TerminalServiceOptions;
  private started: StartedTtyd | null = null;
  private starting: Promise<StartedTtyd> | null = null;
  private readonly tokens = new Map<string, number>();
  private probeCache: { value: TerminalStatusDto; at: number } | null = null;
  private lastActivity = 0;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: TerminalServiceOptions = {}) {
    this.options = {
      idleMs: options.idleMs ?? DEFAULT_IDLE_MS,
      readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      probeTtlMs: options.probeTtlMs ?? DEFAULT_PROBE_TTL_MS,
      tokenTtlMs: options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS,
      ...options,
    };
    // 空闲回收巡检（unref：不阻止进程退出）
    this.idleTimer = setInterval(() => {
      const started = this.started;
      if (started && this.now() - this.lastActivity > this.options.idleMs) void this.stop();
    }, 60_000);
    this.idleTimer.unref?.();
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private get platform(): string {
    return this.options.platform ?? process.platform;
  }

  /** ttyd 安装探测（which/where + --version，短缓存；失败一律未安装，不是错误） */
  private async probeInstalled(): Promise<{ installed: boolean; version: string | null }> {
    const now = this.now();
    if (this.probeCache && now - this.probeCache.at < this.options.probeTtlMs) {
      return { installed: this.probeCache.value.installed, version: this.probeCache.value.version };
    }
    const execFileFn = this.options.execFileFn ?? nodeExecFile;
    const run = (command: string, args: string[]): Promise<{ ok: boolean; stdout: string }> =>
      new Promise((resolve) => {
        try {
          execFileFn(command, args, { timeout: DEFAULT_GIT_STYLE_TIMEOUT_MS, windowsHide: true }, (error, stdout) =>
            resolve({ ok: error === null, stdout: String(stdout ?? "") }),
          );
        } catch {
          resolve({ ok: false, stdout: "" });
        }
      });
    const finder = this.platform === "win32" ? "where" : "which";
    const located = await run(finder, ["ttyd"]);
    let installed = located.ok;
    let version: string | null = null;
    if (installed) {
      const v = await run("ttyd", ["--version"]);
      const match = /(\d+\.\d+(?:\.\d+)?)/.exec(v.stdout);
      version = match ? match[1] : null;
    }
    const status = this.computeStatus(installed, version);
    this.probeCache = { value: status, at: now };
    return { installed, version };
  }

  private computeStatus(installed: boolean, version: string | null): TerminalStatusDto {
    const supported = this.platform !== "win32";
    const running = this.started !== null;
    if (!supported) {
      return { supported: false, installed: false, running: false, version: null, hint: WINDOWS_UNSUPPORTED_HINT };
    }
    return {
      supported: true,
      installed,
      running,
      version,
      hint: installed ? null : installHint(this.platform),
    };
  }

  async status(): Promise<TerminalStatusDto> {
    const { installed, version } = await this.probeInstalled();
    return this.computeStatus(installed, version);
  }

  validateToken(token: string | null | undefined): boolean {
    if (!token) return false;
    const expiresAt = this.tokens.get(token);
    if (expiresAt === undefined) return false;
    if (this.now() >= expiresAt) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }

  touch(): void {
    this.lastActivity = this.now();
  }

  proxyTarget(): TerminalProxyTarget | null {
    return this.started ? { port: this.started.port, credential: this.started.credential } : null;
  }

  private mintToken(): string {
    const token = randomBytes(24).toString("base64url");
    this.tokens.set(token, this.now() + this.options.tokenTtlMs);
    if (this.tokens.size > 64) {
      // 过期清理 + 上限保护（正常一个 token 用到底）
      for (const [t, exp] of this.tokens) {
        if (this.now() >= exp) this.tokens.delete(t);
      }
      while (this.tokens.size > 64) {
        const oldest = this.tokens.keys().next().value;
        if (oldest === undefined) break;
        this.tokens.delete(oldest);
      }
    }
    return token;
  }

  async ensureSession(): Promise<TerminalSessionDto> {
    const status = await this.status();
    if (!status.supported) {
      throw new HubError(ErrorCodes.TERMINAL_UNAVAILABLE, WINDOWS_UNSUPPORTED_HINT, 503);
    }
    if (!status.installed) {
      throw new HubError(ErrorCodes.TERMINAL_UNAVAILABLE, installHint(this.platform), 503);
    }
    if (this.started === null) {
      if (this.starting === null) {
        this.starting = this.startTtyd().finally(() => {
          this.starting = null;
        });
      }
      await this.starting;
    }
    this.touch();
    const token = this.mintToken();
    return {
      url: `${TERMINAL_PREFIX}/?t=${encodeURIComponent(token)}`,
      expiresAt: new Date(this.now() + this.options.tokenTtlMs).toISOString(),
    };
  }

  /** 拉起 ttyd：随机高端口 + loopback + 随机凭证；等待监听就绪（日志解析 + TCP 兜底） */
  private async startTtyd(): Promise<StartedTtyd> {
    const port = await allocPort();
    const shell = this.options.shell ?? process.env.SHELL ?? "/bin/sh";
    const plan = buildTtydSpawnPlan({ port, shell });
    const spawnFn = this.options.spawnFn ?? realSpawn;
    let child: TerminalChildProcess;
    try {
      child = spawnFn(plan.bin, plan.args, { windowsHide: true });
    } catch (err) {
      throw new HubError(
        ErrorCodes.TERMINAL_UNAVAILABLE,
        `ttyd 启动失败：${err instanceof Error ? err.message : String(err)}`,
        503,
      );
    }
    const started: StartedTtyd = { child, port, credential: plan.credential };
    this.started = started;
    this.lastActivity = this.now();

    let stderrTail = "";
    const collect = (chunk: Buffer | string): string => String(chunk);
    child.stderr?.on("data", (chunk) => {
      stderrTail = (stderrTail + collect(chunk)).slice(-800);
    });

    const exited = new Promise<{ kind: "exit"; reason: string }>((resolve) => {
      child.on("error", (err) => resolve({ kind: "exit", reason: err.message }));
      child.on("exit", (code) =>
        resolve({
          kind: "exit",
          reason: `ttyd 退出（code=${code ?? "?"}）${stderrTail ? `：${stderrTail.trim()}` : ""}`,
        }),
      );
    });
    // 只有真的解析到 Listening 行才算就绪（首包可能是版本横幅，不能误判）
    const listenLine = new Promise<number>((resolve) => {
      let buf = "";
      const onData = (chunk: Buffer | string): void => {
        buf = (buf + collect(chunk)).slice(-2_000);
        const parsed = parseTtydListenPort(buf);
        if (parsed !== null) resolve(parsed);
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
    });
    const tcpFallback = (async (): Promise<number | null> => {
      const deadline = this.now() + this.options.readyTimeoutMs;
      while (this.now() < deadline) {
        if (await tcpReachable(port, 250)) return null; // null = 就绪（端口按预期）
        await new Promise((r) => setTimeout(r, 150));
      }
      return -1; // -1 = 超时
    })();

    try {
      const ready = await Promise.race([
        listenLine.then((p) => ({ kind: "log" as const, port: p })),
        tcpFallback.then((p) => ({ kind: "tcp" as const, port: p })),
        exited,
      ]);
      const ok = ready.kind === "log" || (ready.kind === "tcp" && ready.port === null);
      if (!ok) {
        const reason = ready.kind === "exit" ? ready.reason : `ttyd 未能在 ${this.options.readyTimeoutMs}ms 内就绪${stderrTail ? `：${stderrTail.trim()}` : ""}`;
        throw new Error(reason);
      }
      if (ready.kind === "log" && ready.port > 0 && ready.port !== port) {
        started.port = ready.port; // 日志端口优先（--port 未生效等罕见情况）
      }
    } catch (err) {
      this.started = null;
      try {
        child.kill("SIGTERM");
      } catch {
        // kill 失败忽略：进程多半已退出
      }
      throw new HubError(
        ErrorCodes.TERMINAL_UNAVAILABLE,
        `ttyd 启动失败：${err instanceof Error ? err.message : String(err)}`,
        503,
      );
    }
    // 就绪后 child 崩溃 → 回收状态，下次 ensureSession 重新拉起
    child.on("exit", () => {
      if (this.started === started) this.started = null;
    });
    return started;
  }

  /** 停掉 ttyd（幂等） */
  async stop(): Promise<void> {
    const started = this.started;
    this.started = null;
    this.starting = null;
    if (started) {
      try {
        started.child.kill("SIGTERM");
      } catch {
        // kill 失败忽略
      }
    }
    this.tokens.clear();
  }

  /** server 关闭时回收 */
  dispose(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    void this.stop();
  }
}

// ---------- 同源反代（HTTP + WebSocket upgrade） ----------

function basicAuth(credential: string): string {
  return `Basic ${Buffer.from(credential).toString("base64")}`;
}

function rewritePath(url: string | undefined): string {
  const raw = url ?? "/";
  const [path = "/", query = ""] = raw.split("?");
  const stripped = path.slice(TERMINAL_PREFIX.length) || "/";
  return query ? `${stripped}?${query}` : stripped;
}

function sendEnvelope(reply: FastifyReply, statusCode: number, code: string, message: string): void {
  void reply.status(statusCode).send({ error: { code, message } });
}

interface UpgradeRequestMarked extends IncomingMessage {
  [UPGRADE_HANDLED_MARK]?: boolean;
}

/**
 * 注册 /terminal/* 同源反代：
 * - GET/HEAD/POST：转发到 ttyd 端口（HTML 注入 shim；token 通过 ?t= / Cookie 校验）；
 * - /terminal/ws upgrade：原样字节流管道到 ttyd 的 /ws（同样 token 校验 + 凭证注入）。
 */
export function attachTerminalProxy(app: FastifyInstance, runtime: TerminalRuntime): void {
  const requireAccess = (req: FastifyRequest, reply: FastifyReply): { target: TerminalProxyTarget } | null => {
    const target = runtime.proxyTarget();
    if (!target) {
      sendEnvelope(reply, 503, ErrorCodes.TERMINAL_UNAVAILABLE, "终端未运行（先打开终端页启动）");
      return null;
    }
    const token = tokenFrom(req.url, req.headers.cookie);
    if (!runtime.validateToken(token)) {
      sendEnvelope(reply, 401, ErrorCodes.UNAUTHORIZED, "终端 token 无效或已过期");
      return null;
    }
    runtime.touch();
    return { target };
  };

  const proxy = (req: FastifyRequest, reply: FastifyReply): void => {
    const gate = requireAccess(req, reply);
    if (!gate) return;
    const { target } = gate;
    const headers = filterHeaders(req.headers, ["host", "accept-encoding", "cookie"]);
    headers.host = `127.0.0.1:${target.port}`;
    headers.authorization = basicAuth(target.credential);
    let replied = false;
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: target.port,
        path: rewritePath(req.url),
        method: req.method,
        headers,
      },
      (res: IncomingMessage) => {
        replied = true;
        const resHeaders = filterHeaders(res.headers);
        const isHtml = String(res.headers["content-type"] ?? "").includes("text/html");
        const setCookie = tokenFrom(req.url, undefined);
        // 首次带 ?t= 访问时种 HttpOnly cookie：后续资源 / ws 握手免查询串
        if (setCookie && runtime.validateToken(setCookie)) {
          const prev = resHeaders["set-cookie"];
          const cookie = `${TOKEN_COOKIE}=${encodeURIComponent(setCookie)}; Path=${TERMINAL_PREFIX}; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
            DEFAULT_TOKEN_TTL_MS / 1000,
          )}`;
          resHeaders["set-cookie"] = prev === undefined ? [cookie] : [...(Array.isArray(prev) ? prev : [prev]), cookie];
        }
        if (!isHtml) {
          reply.hijack();
          reply.raw.writeHead(res.statusCode ?? 502, resHeaders);
          res.pipe(reply.raw);
          return;
        }
        // HTML：缓冲注入 shim（改写 WebSocket URL / 绝对资源路径）
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const html = injectTerminalShim(Buffer.concat(chunks).toString("utf8"));
          delete resHeaders["content-length"];
          delete resHeaders["content-encoding"];
          reply.hijack();
          reply.raw.writeHead(res.statusCode ?? 502, resHeaders);
          reply.raw.end(html);
        });
      },
    );
    upstream.on("error", () => {
      if (!replied) {
        replied = true;
        sendEnvelope(reply, 502, ErrorCodes.INTERNAL, "终端上游不可用");
      }
    });
    req.raw.pipe(upstream);
  };

  // HTML/资源请求（GET + POST；HEAD 由 Fastify 对 GET 自动暴露，勿重复声明）
  for (const method of ["GET", "POST"] as const) {
    app.route({
      method,
      url: `${TERMINAL_PREFIX}/*`,
      handler: (req, reply) => proxy(req, reply),
    });
  }

  // WebSocket upgrade：/terminal/ws → ttyd /ws（先注册于 ws.ts，故先于其 handler 执行）
  app.server.on("upgrade", (req: UpgradeRequestMarked, socket, head) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (!path.startsWith(TERMINAL_PREFIX)) return;
    // 已被更早的处理器接管/拒绝（如 index.ts 的 Host 校验直接断连）：不再二次处理
    if (req[UPGRADE_HANDLED_MARK] === true) return;
    req[UPGRADE_HANDLED_MARK] = true;
    const target = runtime.proxyTarget();
    const token = tokenFrom(req.url, req.headers.cookie);
    if (!target || !runtime.validateToken(token)) {
      socket.destroy();
      return;
    }
    runtime.touch();
    const upstream = netConnect({ port: target.port, host: "127.0.0.1" }, () => {
      // upgrade 握手必须原样保留 Connection/Upgrade/Sec-WebSocket-* 头（不能按 hop-by-hop 剥）
      const headers: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        const lower = key.toLowerCase();
        if (lower === "host" || lower === "cookie" || value === undefined) continue;
        headers[lower] = value;
      }
      headers.host = `127.0.0.1:${target.port}`;
      headers.authorization = basicAuth(target.credential);
      const lines = [`${req.method ?? "GET"} ${rewritePath(req.url)} HTTP/1.1`];
      for (const [key, value] of Object.entries(headers)) {
        lines.push(`${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
}
