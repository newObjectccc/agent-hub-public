/**
 * agent-hub server 入口：Fastify REST + WS + pi SDK + KPI + 系统探测 + 静态托管 web/dist。
 * 默认监听 127.0.0.1:7700（config/hub.config.json 可覆盖），绝不明文绑定公网。
 */
import { existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { isIPv4, isIPv6 } from "node:net";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyCompress from "@fastify/compress";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { AgentCommandHub } from "./agents.js";
import { ClaudeAdapter } from "./adapters/claude.js";
import { ClaudeDriverHub } from "./adapters/claude-driver.js";
import { HostRequestRegistry } from "./adapters/host-request-registry.js";
import { CodexAdapter } from "./adapters/codex.js";
import { CodexDriverHub } from "./adapters/codex-driver.js";
import { inspectCodexRuntime, formatCodexRuntimeDiagnostics } from "../../cli/lib/codex-runtime.js";
import { findClaudeSessionFiles } from "./adapters/claude-transcript.js";
import { PiAdapter } from "./adapters/pi.js";
import { SessionRegistry } from "./adapters/registry.js";
import { loadHubConfig, isAllowedCrossOrigin, isSameOrigin, type HubConfig } from "./config.js";
import { createAppLockStore, type AppLockStoreLike } from "./appLock.js";
import { DashboardService } from "./dashboard.js";
import { ErrorCodes } from "./errors.js";
import { KpiService } from "./kpi.js";
import { LiveIngest } from "./live.js";
import { configDir, dataDir, repoRoot, webDistDir } from "./paths.js";
import { registerRoutes, type RouteDeps, type SessionHubLike } from "./routes.js";
import { SubAgentRouter } from "./subagents.js";
import { SessionHub } from "./sessions/hub.js";
import { PresenceWatcher } from "./sessions/presence.js";
import { findSessionFiles } from "./sessions/scan.js";
import { SessionTailManager } from "./sessions/tail.js";
import { createSystemInfoProvider } from "./system.js";
import {
  attachTerminalProxy,
  redactUrlSecrets,
  TerminalService,
  UPGRADE_HANDLED_MARK,
  type TerminalRuntime,
} from "./terminal.js";
import { UsageService } from "./usage.js";
import type { ServerEvent, SessionStatus } from "./types.js";
import { WsHub, type WsSessionHub } from "./ws.js";

/**
 * DNS rebinding 防护（P2）：浏览器会把任意域名解析到本机，恶意页面再以
 * `http://evil.com:7700` 直连本服务（同源策略下可读响应）。Host 头白名单宽松判定：
 * - localhost / *.localhost、任意 IP 字面量（回环/局域网 IP 直接访问不受影响，IP 无 DNS 可被 rebind）
 * - *.ts.net（Tailscale MagicDNS）、*.local（mDNS 局域网设备名）
 * - 额外显式信任名单 extraHosts（bindHost 主机名 + allowOrigins 的 hostname）
 * 其余主机名一律 403。未配置项零维护：自定义域名部署可经 allowOrigins/绑定主机名进入白名单。
 */
export function isAllowedHostHeader(
  hostHeader: string | string[] | undefined,
  options: { bindHost?: string; extraHosts?: readonly string[] } = {},
): boolean {
  const raw = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (typeof raw !== "string") return false;
  const h = raw.trim().toLowerCase();
  if (h === "") return false;
  // Host 头 = hostname[:port]；IPv6 字面量必须带 []（裸多冒号非法一律拒）
  let hostname: string;
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end <= 1) return false;
    hostname = h.slice(1, end);
  } else {
    const colons = h.split(":").length - 1;
    if (colons > 1) return false;
    hostname = colons === 1 ? h.slice(0, h.indexOf(":")) : h;
  }
  if (hostname === "") return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (isIPv4(hostname) || isIPv6(hostname)) return true;
  if (hostname.endsWith(".ts.net") || hostname.endsWith(".local")) return true;
  const extras = [options.bindHost, ...(options.extraHosts ?? [])];
  return extras.some((extra) => {
    if (typeof extra !== "string" || extra.trim() === "") return false;
    return hostname === extra.trim().toLowerCase();
  });
}

/** Host 信任名单派生参数（DNS rebinding 闸 + 同源判定共用；见 isAllowedHostHeader） */
export interface HostTrustOptions {
  bindHost?: string;
  extraHosts?: readonly string[];
}

/**
 * 从 config 派生 Host 信任名单（bindHost + allowOrigins 的 hostname）。
 * HTTP CORS 闸与 WS upgrade Origin 闸共用此派生（单一事实源，避免双份维护）。
 */
export function hostTrustOptionsFor(config: { host?: string; allowOrigins?: readonly string[] }): HostTrustOptions {
  const allowOrigins = config.allowOrigins ?? [];
  return {
    bindHost: config.host,
    extraHosts: allowOrigins
      .map((o) => {
        try {
          return new URL(o).hostname;
        } catch {
          return "";
        }
      })
      .filter((h) => h !== ""),
  };
}

/**
 * 同源/跨域白名单判定（HTTP CORS 闸与 WS upgrade Origin 闸同口径共用）：
 * 同源放行；跨域只放 allowOrigins 精确白名单（默认空 = 拒绝一切跨域），其余带 Origin 一律拒绝。
 * 反代感知（安全版）：Host 头可信（localhost/IP/ts.net/local/bindHost/allowOrigins，浏览器不可伪造）
 * 时跳过协议比对（tailscale serve https→http 降级真机踩坑）；非可信 Host 时协议也要对上。
 * 绝不采信 X-Forwarded-*（fetch 可自定义，恶意页可伪造 → 同源判定整体沦陷）。
 */
export function crossOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  protocol: string | undefined,
  options: { allowOrigins: readonly string[]; hostTrust: HostTrustOptions },
): boolean {
  const trustedHost = isAllowedHostHeader(host, options.hostTrust);
  return isSameOrigin(origin, host, trustedHost ? undefined : protocol) || isAllowedCrossOrigin(origin, options.allowOrigins);
}

/**
 * emit 同步链隔离（P2）：通知聚合 / WS 广播 / 子代理路由各路独立 try/catch，
 * 单路抛错只记日志不影响其它路（任一订阅者出错不拖垮事件分发）。
 */
export interface EmitTargets {
  recordEvent(sessionId: string, event: ServerEvent): void;
  broadcast(sessionId: string, event: ServerEvent): void;
  broadcastGlobal(event: { type: string; [key: string]: unknown }): void;
  route(sessionId: string, event: ServerEvent): { parentSessionId: string; event: ServerEvent } | null;
}

export function createEventEmitter(
  targets: EmitTargets,
  onError: (where: string, err: unknown) => void = (where, err) => {
    console.error(`[agent-hub] emit ${where} failed:`, err instanceof Error ? err.stack ?? err.message : err);
  },
): (sessionId: string, event: ServerEvent) => void {
  return (sessionId, event) => {
    try {
      targets.recordEvent(sessionId, event);
    } catch (err) {
      onError("recordEvent", err);
    }
    if (event.type === "status") {
      try {
        targets.broadcastGlobal({ type: "session_status", sessionId, status: event.status });
      } catch (err) {
        onError("broadcastGlobal", err);
      }
    }
    try {
      targets.broadcast(sessionId, event);
    } catch (err) {
      onError("broadcast", err);
    }
    try {
      const routed = targets.route(sessionId, event);
      if (routed) targets.broadcast(routed.parentSessionId, routed.event);
    } catch (err) {
      onError("route", err);
    }
  };
}

/**
 * 日志 req 序列化器（P2）：终端 token 走 `?t=` 能力链接，pino 默认序列化会把完整 req.url
 * 记入访问日志——此处输出最小字段集并对敏感查询参数（t/token/secret/…）统一 [REDACTED]。
 * createApp 的 pino serializers.req 与测试共用本实现。
 */
export function serializeReqForLog(req: {
  method?: string;
  url?: string;
  hostname?: string;
  ip?: string;
}): Record<string, unknown> {
  return {
    method: req.method,
    url: redactUrlSecrets(req.url ?? ""),
    hostname: req.hostname,
    remoteAddress: req.ip,
  };
}

export interface CreateAppOptions extends RouteDeps {
  /** 静态托管根目录（web/dist）；null 表示不托管 */
  webRoot?: string | null;
  logger?: boolean;
  /** ttyd Web 终端（F2）：比 RouteDeps.terminal 多出反代所需运行时能力 */
  terminal?: TerminalRuntime;
}

/** 装配 Fastify app：CORS + REST 路由 + 静态托管 + SPA history fallback */
export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  // 日志脱敏（P2）：终端 token 走 `?t=` 能力链接，pino 默认 req 序列化会把完整 req.url
  // 记入访问日志。自定义 req serializer 对敏感查询参数（t/token/secret/…）统一 [REDACTED]。
  const loggerOption = options.logger
    ? {
        level: "info",
        serializers: {
          req: serializeReqForLog,
        },
      }
    : false;
  const app = Fastify({ logger: loggerOption, forceCloseConnections: true });
  // GET/HEAD JSON 响应弱 ETag + no-cache 协商缓存：重复打开面板命中 If-None-Match → 304（零字节体），
  // 慢链路（tailnet 中继）下二次打开的关键优化。注册在压缩之前：对 identity 内容做哈希
  // （W/ 弱 ETag，语义与 nginx gzip+etag 同口径）；静态资源由 @fastify/static 自管缓存不受影响。
  app.addHook("onSend", async (req, reply, payload) => {
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      reply.statusCode === 200 &&
      typeof payload === "string" &&
      !reply.hasHeader("etag")
    ) {
      const etag = `W/"${createHash("sha1").update(payload).digest("base64url").slice(0, 27)}"`;
      reply.header("etag", etag);
      if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-cache");
      const inm = req.headers["if-none-match"];
      if (typeof inm === "string" && inm.split(",").some((t) => t.trim() === etag)) {
        reply.code(304);
        return "";
      }
    }
    return payload;
  });
  // DNS rebinding 防护（P2）：非法 Host（非 localhost/IP/ts.net/local/显式信任名）→ 403，
  // 先于一切业务路由/静态托管；WS upgrade 不走 onRequest hook，在下方单独把关
  app.addHook("onRequest", async (req, reply) => {
    if (isAllowedHostHeader(req.headers.host, hostOptions)) return;
    return reply.status(403).send({ error: { code: ErrorCodes.UNAUTHORIZED, message: "host not allowed (dns rebinding guard)" } });
  });
  app.server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    if (isAllowedHostHeader(req.headers.host, hostOptions)) return;
    (req as IncomingMessage & Record<string, unknown>)[UPGRADE_HANDLED_MARK] = true;
    socket.destroy();
  });
  // 响应压缩（brotli 优先）：弱网/移动网络下 JSON 与静态资源体积降约 70%；
  // 仅在请求带 Accept-Encoding 时生效（WS upgrade / 终端反代不受影响）
  await app.register(fastifyCompress, { encodings: ["br", "gzip", "deflate"] });

  // CORS 安全（P0）：绝不反射任意 Origin。同源请求放行（面板与 API 同源部署，
  // Vite dev 走 proxy 也是同源）；跨域只放 config.allowOrigins 白名单（默认空 = 拒绝一切跨域），
  // 其余带 Origin 的请求直接 403（错误信封），防恶意网页跨域读会话/发 prompt。
  // 判定抽成导出函数 crossOriginAllowed / hostTrustOptionsFor（含 Host 信任派生 + 反代感知协议豁免，
  // 见函数注释）：HTTP 闸与 WS upgrade Origin 闸（attachSessionWs 装配）共用同一实现，避免双份维护。
  const allowOrigins = options.config.allowOrigins ?? [];
  const hostOptions = hostTrustOptionsFor(options.config);
  const originGate = { allowOrigins, hostTrust: hostOptions };
  // 拒绝 hook 先于 CORS 插件注册：恶意 preflight OPTIONS 也一律 403
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (typeof origin !== "string" || origin === "") return; // 非浏览器/同源导航：无 CORS 问题
    if (crossOriginAllowed(origin, req.headers.host, req.protocol, originGate)) return;
    return reply.status(403).send({ error: { code: ErrorCodes.UNAUTHORIZED, message: "cross-origin request denied" } });
  });
  await app.register(fastifyCors, {
    delegator: (req, cb) => {
      const origin = req.headers.origin;
      const ok = crossOriginAllowed(origin, req.headers.host, req.protocol, originGate);
      cb(null, { origin: ok ? (origin ?? false) : false });
    },
  });

  await registerRoutes(app, {
    hub: options.hub,
    kpi: options.kpi,
    config: options.config,
    systemInfo: options.systemInfo,
    git: options.git,
    live: options.live,
    commands: options.commands,
    fsTree: options.fsTree,
    panelDriven: options.panelDriven,
    dashboard: options.dashboard,
    usage: options.usage,
    agents: options.agents,
    claudeDriver: options.claudeDriver,
    codexDriver: options.codexDriver,
    appLock: options.appLock,
    terminal: options.terminal,
    terminalUnlocked: options.terminalUnlocked,  });
  // /terminal/* 同源反代（ttyd Web 终端，F2）：HTTP + WS upgrade，token 保护
  if (options.terminal) {
    attachTerminalProxy(app, options.terminal);
  }
  // 静态托管 web/dist（存在时），单进程即可服务 PWA
  const root = options.webRoot ?? null;
  const hasWeb = root !== null && existsSync(join(root, "index.html"));
  if (hasWeb && root !== null) {
    await app.register(fastifyStatic, {
      root,
      prefix: "/",
      setHeaders(reply, filePath) {
        // Vite 产物带内容 hash（/assets/*）：长缓存 + immutable，二次打开零请求；
        // index.html / sw.js / manifest 保持协商缓存（发版可见性与 SW 更新检查）
        // （D3）@fastify/static v10 契约变更：setHeaders 收到的是 FastifyReply（v8 传原生 res），
        // 必须用 reply.header 而非 res.setHeader；v10 在 reply.headers() 之后调 setHeaders，可覆盖插件自设头
        if (filePath.split(sep).includes("assets")) {
          reply.header("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    });
    app.log.info(`serving PWA from ${root}`);
  }

  // 统一 404 错误信封（契约要求）：无论 web/dist 是否存在，未命中路由都返回 {error:{code,message}}；
  // SPA history fallback 仅在托管 web/dist 时生效：非 /api、/ws 的 GET → index.html（/s/:id 刷新不 404）
  app.setNotFoundHandler((req, reply) => {
    if (hasWeb && root !== null && req.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/ws")) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.status(404).send({ error: { code: "NOT_FOUND", message: `no route: ${req.url}` } });
  });

  return app;
}

/** attachSessionWs 的结构依赖（生产 = startHub 装配实例；测试注入 fake） */
export interface AttachSessionWsOptions {
  /** WS hub（广播出口；生产 = startHub 创建的 WsHub） */
  wshub: WsHub;
  /** 配置（auth 派生 upgrade 鉴权——README 承诺：开启后全部 API 与 WS 均需 Bearer；
   *  host/allowOrigins 派生 WS upgrade Origin 闸——与 HTTP CORS 闸同源同逻辑） */
  config: Pick<HubConfig, "auth" | "host" | "allowOrigins">;
  /** 非本进程会话文件 tail 实时推送（可选） */
  tails?: SessionTailManager;
  /** 应用锁门禁（锁屏拒绝 WS 发送；与 HTTP 门禁同口径） */
  appLock?: AppLockStoreLike;
  /** pi 扩展 attach 接管检测（ATTACH_ACTIVE 冲突保护并集） */
  agents?: { isAttached(sessionId: string): boolean };
  /** claude hub 驱动 attach 接管检测 + 中止 turn（并集；config.claudeDriver.enabled=false 装配时缺省） */
  claudeDriver?: { isAttached(sessionId: string): boolean; abortTurn(sessionId: string): void } | null;
  codexDriver?: { isAttached(sessionId: string): boolean; isAttaching(sessionId: string): boolean; isBusy?(sessionId: string): boolean; abortTurn(sessionId: string): void } | null;
}

/**
 * 会话 WS 生产唯一挂载路径（修复：WS 鉴权未接线）：
 * 封装「promptGuard（锁屏门禁 + ATTACH_ACTIVE 并集）+ abortHandler（锁屏门禁 + driver/hub 中止分发）
 * + 从 config.auth 派生 upgrade 鉴权 + 从 config 派生 Origin 跨站闸」，startHub 唯一通过它挂载 WS。
 * auth 必填进 WsHub.attach（漏传 = 编译错误），鉴权装配断裂在测试/生产同一路径上可回归
 * （server/src/test/ws-auth-wiring.test.ts）。
 */
export function attachSessionWs(server: HttpServer, hub: WsSessionHub, options: AttachSessionWsOptions): void {
  const { wshub, config, tails, appLock, agents, claudeDriver, codexDriver } = options;
  // Origin 跨站闸：与 HTTP CORS 闸共用 crossOriginAllowed（同源/白名单/Host 信任派生单一事实源）
  const originGate = { allowOrigins: config.allowOrigins ?? [], hostTrust: hostTrustOptionsFor(config) };
  /** 应用锁门禁（与 promptGuard 锁分支同判据）：已配置锁且令牌无效 = 锁屏 */
  const appLocked = (lockToken?: string): boolean =>
    appLock?.status().configured === true && !appLock.verifyToken(lockToken ?? "").ok;
  wshub.attach(server, hub, {
    tailManager: tails,
    promptGuard: (id, lockToken) =>
      appLocked(lockToken)
        ? { code: ErrorCodes.APP_LOCKED, message: "应用已锁定：请先解锁" }
        : agents?.isAttached(id) || claudeDriver?.isAttached(id) || codexDriver?.isBusy?.(id) || codexDriver?.isAttached(id) || codexDriver?.isAttaching(id)
          ? { code: ErrorCodes.ATTACH_ACTIVE, message: "终端接管中：平行发送已停用（切回 📱 平行模式可恢复）" }
          : null,
    // WS abort 门禁 + 分发（修复：abort 绕过 promptGuard，锁屏/接管期可中止 turn）——镜像 HTTP
    // /api/sessions/:id/abort 语义：先过应用锁门禁（同 promptGuard 锁分支判据；abort 不复用 promptGuard
    // 本体——其含 ATTACH_ACTIVE 拒绝，而 abort 在接管期合法且必要）；通过后 claude 驱动接管中走
    // driver.abortTurn（control interrupt，进程存活可续），否则 hub.abort
    abortHandler: async (id, lockToken) => {
      if (appLocked(lockToken)) return { code: ErrorCodes.APP_LOCKED, message: "应用已锁定：请先解锁" };
      try {
        const session = await hub.findSession(id);
        if (!session) return { code: ErrorCodes.SESSION_NOT_FOUND, message: `会话不存在: ${id}` };
        if (session.source === "claude" && claudeDriver?.isAttached(id)) {
          claudeDriver.abortTurn(id);
        } else if (session.source === "codex" && (codexDriver?.isAttached(id) || codexDriver?.isAttaching(id))) {
          codexDriver.abortTurn(id);
        } else {
          await hub.abort(id);
        }
        return null;
      } catch (err) {
        return { code: ErrorCodes.PROMPT_FAILED, message: err instanceof Error ? err.message : String(err) };
      }
    },
    // Origin 校验与鉴权是 AND 关系（先鉴权后 Origin，见 WsHub.attach）：
    // 浏览器 WS 必带 Origin 头，非法跨站 403 断连；无 Origin（node ws/curl/自动化）不在此闸
    isAllowedOrigin: (req, protocol) =>
      crossOriginAllowed(
        typeof req.headers.origin === "string" ? req.headers.origin : undefined,
        req.headers.host,
        protocol,
        originGate,
      ),
    auth: { enabled: config.auth.enabled, token: config.auth.token },
  });
}

export interface StartedHub {
  app: FastifyInstance;
  hub: SessionRegistry;
  kpi: KpiService;
  config: HubConfig;
  wshub: WsHub;
  close(): Promise<void>;
}

export async function startHub(): Promise<StartedHub> {
  const { config, warnings } = loadHubConfig(configDir);
  for (const warning of warnings) {
    console.warn(`[agent-hub] ${warning}`);
  }

  const wshub = new WsHub();
  let tails: SessionTailManager | undefined;
  // 统一事件出口：通知聚合（settled/error + 最后输出摘要）+ WS 推送 +
  // 全局 status 变更广播（首页运行看板实时刷新）+ 子代理活动路由（反馈轮 3 #4：
  // 子会话事件按 parentSessionId 汇到父会话通道）。各路独立 try/catch（P2 emit 隔离）；
  // 目标对象延迟绑定（事件只可能在 startHub 装配完成后到达）
  const emit = createEventEmitter({
    recordEvent: (sessionId, event) => dashboard.recordEvent(sessionId, event),
    broadcast: (sessionId, event) => {
      wshub.broadcast(sessionId, event);
    },
    broadcastGlobal: (event) => wshub.broadcastGlobal(event),
    route: (sessionId, event) => subAgentRouter.route(sessionId, event),
  });
  // 终端 pi 反向指令通道（E3 双模式）：心跳 / 指令队列 / 回执（attach_state、command_ack 走同一 emit）
  // 必须先于 piHub 构造：piHub 的外部活跃闸门（防双写）要注入 agents.isOnline
  const agents = new AgentCommandHub(emit);
  const piHub = new SessionHub(config.sessionDir, emit, {
    // 平行发送双写闸门：终端 pi-command 扩展心跳在线 = 终端进程持有该会话的 leafId，
    // 此时 server 内 SDK 实例再 append 会让 JSONL 分叉（EXTERNAL_ACTIVE，契约 §12）
    externalActive: (id) => agents.isOnline(id),
  });
  // claude 权限请求登记表（契约 §12）：attach 与 parallel 两路径共用同一审批通道，
  // 手机端同一套 HostRequestCard。bridge 回连挂起、手机应答解结、超时/收尾一律 deny。
  const claudeHostRequests = new HostRequestRegistry({ emit });
  // claude hub 驱动接管（docs/CLAUDE_DRIVER.md）：attach 期间持有长驻 claude -p 进程，
  // stdin 注入真用户 turn；非 bypass 档位权限经 MCP bridge 回连手机批/拒（默认 bypass 全自动）。
  // config.claudeDriver.enabled=false（总开关，修复死旋钮）：不构造 driver → claude 接管路由回 400，
  // 前端回落 parallel（routes 的 requireClaudeDriver 对 deps 缺失已有 400 路径，无需另改）。
  // enabled=false 同时关掉审批通道（bridge 不挂、请求不登记）：本开关是 claude 增强通道总闸。
  const claudeBridgePath = config.claudeDriver.enabled
    ? join(repoRoot, "integrations", "claude-perm-bridge", "bridge.mjs")
    : null;
  const claudeDriver = config.claudeDriver.enabled
    ? new ClaudeDriverHub({
        emit,
        liveUrl: `http://127.0.0.1:${config.port}`,
        liveToken: config.auth.token,
        bridgeScriptPath: claudeBridgePath!,
        maxConcurrent: config.claudeDriver.maxConcurrent,
        idleDetachMs: config.claudeDriver.idleDetachMs,
        externalQuietMs: config.claudeDriver.externalQuietMs,
        mirror: config.claudeDriver.mirror,
        permissionMode: config.claudeDriver.permissionMode,
        hostRequests: claudeHostRequests,
        // 权限请求只在「有人在环」时挂起：attach 中或 parallel run 中；未知伪造请求一律 deny
        parallelActive: (id): boolean => claudeAdapter.hasActiveRun(id),
      })
    : null;
  // Claude Code 会话来源：~/.claude/projects/<encoded-cwd>/<uuid>.jsonl + history.jsonl
  const claudeProjectsDir = join(homedir(), ".claude", "projects");
  const claudeHistoryFile = join(homedir(), ".claude", "history.jsonl");
  const claudeAdapter = new ClaudeAdapter({
    projectsDir: claudeProjectsDir,
    historyFile: claudeHistoryFile,
    emit,
    // 防双写加固（D8）：hub 驱动接管中的会话按 busy 拒绝 parallel 发送（driver 未启用 = 恒不忙）
    driverBusy: (id): boolean => claudeDriver?.isAttached(id) ?? false,
    driverStatus: (id): SessionStatus | null => claudeDriver?.runStatusFor(id) ?? null,
    // 权限档位与 driver 接管路径共用同一配置（默认 bypassPermissions，attach/detach 不跳变）
    permissionMode: config.claudeDriver.permissionMode,
    // 审批通道与接管路径共用（同一 registry → 同一套手机审批卡片）：非 bypass 档位 spawn 挂 bridge
    hostRequests: claudeHostRequests,
    bridgeScriptPath: claudeBridgePath,
    liveUrl: `http://127.0.0.1:${config.port}`,
    liveToken: config.auth.token,
  });
  // Codex 会话来源：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl + session_index.jsonl（与桌面 app/CLI 共享）
  // 归档会话：~/.codex/archived_sessions/（平铺，列表标注归档并排尾）
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const codexSessionsDir = join(codexHome, "sessions");
  const codexArchivedDir = join(codexHome, "archived_sessions");
  const codexSessionIndexFile = join(codexHome, "session_index.jsonl");
  const codexDriver: CodexDriverHub | null = config.codexDriver.enabled ? new CodexDriverHub({
    emit,
    codexBin: config.codexBin,
    maxConcurrent: config.codexDriver.maxConcurrent,
    idleDetachMs: config.codexDriver.idleDetachMs,
    externalQuietMs: config.codexDriver.externalQuietMs,
    approvalPolicy: config.codexDriver.approvalPolicy === "inherit" ? undefined : config.codexDriver.approvalPolicy,
    sandbox: config.codexDriver.sandbox === "inherit" ? undefined : config.codexDriver.sandbox,
    parallelBusy: (id) => codexAdapter.isLive(id),
  }) : null;
  const codexAdapter: CodexAdapter = new CodexAdapter({
    sessionsDir: codexSessionsDir,
    archivedSessionsDir: codexArchivedDir,
    sessionIndexFile: codexSessionIndexFile,
    emit,
    codexBin: config.codexBin,
    driverBusy: (id) => codexDriver?.isBusy(id) ?? false,
    driverStatus: (id) => codexDriver?.runStatusFor(id) ?? null,
  });
  const hub = new SessionRegistry(new PiAdapter(piHub), claudeAdapter, config.sessionDir, codexAdapter);
  // 子代理血缘路由器（emit 闭包延迟引用：事件只可能在 startHub 装配完成后到达）
  const subAgentRouter = new SubAgentRouter(
    (id) => hub.findSession(id),
    // 首波缓存 flush 出口：与 emit 链同一广播（修复"子代理首条输出丢失"）
    (routed) => wshub.broadcast(routed.parentSessionId, routed.event),
  );
  const dashboard = new DashboardService({
    sessionDir: config.sessionDir,
    workspaceRoot: config.workspaceRoot,
    storeFile: join(dataDir, "notifications-read.json"),
    statusOf: (id, updatedMs) => piHub.statusFor(id, updatedMs),
    onNotification: (item) => wshub.broadcastGlobal({ type: "notification", notification: item }),
  });
  piHub.onActivity = (sessionId, activity) => dashboard.recordActivity(sessionId, activity);
  // Token 用量汇总（契约 §14，pi + codex 源）：按文件 mtime+size 增量重读，presence 变更时失效；
  // codex 的 token_usage_record 在解析层计数（含归档目录）
  const usage = new UsageService({ sessionDir: config.sessionDir, codexSessionDirs: [codexSessionsDir, codexArchivedDir] });
  const kpi = new KpiService({ configDir, kpiRefreshMinutes: config.kpiRefreshMinutes });
  // ttyd Web 终端服务（F2）：生命周期归 server 管（关闭时回收 ttyd）
  const terminalService = new TerminalService();
  // 应用锁存储：路由门禁与终端门禁共用同一实例（令牌校验口径一致）
  const appLock = createAppLockStore(dataDir);
  const systemInfo = createSystemInfoProvider({
    sessionDir: config.sessionDir,
    workspaceRoot: config.workspaceRoot,
    sdkVersion: VERSION,
  });
  // pi 扩展 live-feed 接入：终端 pi 会话的 token 级实时流（契约 §6）
  const liveIngest = new LiveIngest({
    emit,
    // 首个 live 事件标记会话转 live：触发 hub.onLive 停文件 tail，防双推送
    onLive: (sid) => hub.markLiveFeed(sid),
    // 本进程 SDK 流是权威源：接管中的会话丢弃扩展推送
    isSdkLive: (sid) => hub.isSdkLive(sid),
  });

  const app = await createApp({
    hub,
    kpi,
    dashboard,
    usage,
    config,
    live: liveIngest,
    agents,
    claudeDriver: claudeDriver ?? undefined,
    codexDriver: codexDriver ?? undefined,
    webRoot: webDistDir,
    logger: true,
    // ttyd Web 终端（F2）：按需拉起 + 同源反代（POSIX；win32 自动降级为提示）
    terminal: terminalService,
    appLock,
    // 终端门禁（F1）：应用锁已配置且未解锁时拒绝签发 ttyd token（未配置锁 = 视为已解锁）
    terminalUnlocked: (lockToken) => !appLock.status().configured || appLock.verifyToken(lockToken ?? "").ok,
    systemInfo: async () => ({
      ...(await systemInfo()),
      terminal: await terminalService.status(),
    }),
  });

  await app.listen({ port: config.port, host: config.host });
  agents.startSweep();
  claudeDriver?.startSweep();
  codexDriver?.startSweep();
  // 仅检查二进制版本与有限条 rollout 头；不请求模型、不读取登录凭据、不阻塞监听。
  void inspectCodexRuntime({ codexBin: config.codexBin, codexHome }).then((report) => {
    for (const line of formatCodexRuntimeDiagnostics(report)) app.log.info(line);
  }).catch(() => app.log.warn("Codex 版本诊断暂不可用，可运行 agent-hub doctor 重试"));
  // live map LRU/TTL 逐出 + feedSessions/statuses 过期清扫（30s，unref；OOM 审计 AC2/AC3）
  piHub.startSweep();
  // usage 启动预热（fire-and-forget）：预扫全部会话 JSONL，/api/usage 冷启动不再同步等 2.3s（
  // 请求侧另有 ≤300ms 限时兑底，超时先回当前缓存/空窗，UI 走无数据占位降级，最终一致）
  usage.warmup();
  tails = new SessionTailManager((sessionId, event) => emit(sessionId, event));
  // 会话一旦由本进程接管（live），停掉文件 tail，避免双推送源产生重复气泡
  hub.onLive = (sid) => tails?.detach(sid);
  // attach 接管期间拒绝 WS parallel 发送（与 REST /prompt 同一冲突保护，pi 指令队列 / claude hub 驱动并集）；
  // 锁屏时拒绝 WS 发送（与 HTTP 门禁同口径）；upgrade 鉴权从 config.auth 派生（开启后 WS 同样要 Bearer）。
  // 生产唯一挂载路径：attachSessionWs（WS 鉴权接线回归测试走同一函数，见 ws-auth-wiring.test.ts）
  attachSessionWs(app.server, {
    findSession: (id) => hub.findSession(id),
    listChildren: (id) => hub.listChildren(id),
    isLive: (id) => hub.isLive(id) || (codexDriver?.isBusy(id) ?? false),
    prompt: (id, text, mode) => hub.prompt(id, text, mode),
    abort: (id) => hub.abort(id),
  }, {
    wshub,
    config,
    tails,
    appLock,
    agents,
    claudeDriver,
    codexDriver,
  });
  // 全局存在感知：任一会话文件（pi / claude）变化 → 广播 sessions_changed + 搜索索引失效（fs.watch 事件驱动）
  const presence = new PresenceWatcher(
    async () => [
      ...(await findSessionFiles(config.sessionDir)),
      ...(await findClaudeSessionFiles(claudeProjectsDir)),
    ],
    () => {
      hub.invalidateSearch();
      hub.invalidateList();
      dashboard.invalidate();
      usage.invalidate();
      wshub.broadcastGlobal({ type: "sessions_changed" });
    },
    [config.sessionDir, claudeProjectsDir],
  );
  await presence.start();
  await kpi.start();
  // 预热：延迟 5s 后台完成首次全量扫描（先让 HTTP 就绪；扫描批间让出不堵事件循环）
  const warmTimer = setTimeout(() => {
    void hub.listSessions().catch(() => undefined);
    void dashboard.getStats().catch(() => undefined);
  }, 5_000);
  warmTimer.unref?.();

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    kpi.stop();
    presence.stop();
    liveIngest.close();
    agents.close();
    // hub 驱动接管：杀掉全部 claude 驱动进程（attach 态不跨重启恢复，web 回落 parallel）
    claudeDriver?.disposeAll();
    codexDriver?.disposeAll();
    terminalService.dispose();
    hub.disposeAll();
    // 先掐掉全部 WS 连接再关 HTTP，否则在线 WS 客户端会让 app.close() 永不 resolve
    wshub.closeAll();
    await app.close();
  };

  return { app, hub, kpi, config, close, wshub };
}

async function main(): Promise<void> {
  const started = await startHub();
  console.log(`[agent-hub] server listening on http://${started.config.host}:${started.config.port}`);

  const shutdown = (signal: string): void => {
    console.log(`[agent-hub] received ${signal}, shutting down...`);
    void started
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error("[agent-hub] shutdown failed:", err);
        process.exit(1);
      });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  // 崩溃兜底（P0）：未处理 Promise 拒绝 / 未捕获异常 → 记日志 + 优雅关闭，不裸崩；
  // 关闭卡死 5s 兜底强退（同样 exit(1)）
  const crashExit = (kind: string, err: unknown): void => {
    console.error(`[agent-hub] ${kind}:`, err instanceof Error ? (err.stack ?? err.message) : err);
    const force = setTimeout(() => process.exit(1), 5_000);
    void started
      .close()
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(force);
        process.exit(1);
      });
  };
  process.on("unhandledRejection", (reason) => crashExit("unhandledRejection", reason));
  process.on("uncaughtException", (err) => crashExit("uncaughtException", err));
}

// 直接执行时启动（被 import 时不自启，便于测试）
const entryHref = process.argv[1] !== undefined ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (entryHref === import.meta.url) {
  void main().catch((err) => {
    console.error("[agent-hub] failed to start:", err);
    process.exit(1);
  });
}
