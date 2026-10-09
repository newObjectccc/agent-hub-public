/**
 * agent-hub server 入口：Fastify REST + WS + pi SDK + KPI + 系统探测 + 静态托管 web/dist。
 * 默认监听 127.0.0.1:7700（config/hub.config.json 可覆盖），绝不明文绑定公网。
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCompress from "@fastify/compress";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { AgentCommandHub } from "./agents.js";
import { ClaudeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { findClaudeSessionFiles } from "./adapters/claude-transcript.js";
import { PiAdapter } from "./adapters/pi.js";
import { SessionRegistry } from "./adapters/registry.js";
import { loadHubConfig, type HubConfig } from "./config.js";
import { DashboardService } from "./dashboard.js";
import { ErrorCodes } from "./errors.js";
import { KpiService } from "./kpi.js";
import { LiveIngest } from "./live.js";
import { configDir, dataDir, webDistDir } from "./paths.js";
import { registerRoutes, type RouteDeps, type SessionHubLike } from "./routes.js";
import { SubAgentRouter } from "./subagents.js";
import { SessionHub } from "./sessions/hub.js";
import { PresenceWatcher } from "./sessions/presence.js";
import { findSessionFiles } from "./sessions/scan.js";
import { SessionTailManager } from "./sessions/tail.js";
import { createSystemInfoProvider } from "./system.js";
import { attachTerminalProxy, TerminalService, type TerminalRuntime } from "./terminal.js";
import { UsageService } from "./usage.js";
import type { ServerEvent } from "./types.js";
import { WsHub } from "./ws.js";

export interface CreateAppOptions extends RouteDeps {
  /** 静态托管根目录（web/dist）；null 表示不托管 */
  webRoot?: string | null;
  logger?: boolean;
  /** ttyd Web 终端（F2）：比 RouteDeps.terminal 多出反代所需运行时能力 */
  terminal?: TerminalRuntime;
}

/** 装配 Fastify app：CORS + REST 路由 + 静态托管 + SPA history fallback */
export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, forceCloseConnections: true });
  // 响应压缩（brotli 优先）：弱网/移动网络下 JSON 与静态资源体积降约 70%；
  // 仅在请求带 Accept-Encoding 时生效（WS upgrade / 终端反代不受影响）
  await app.register(fastifyCompress, { encodings: ["br", "gzip", "deflate"] });
  await app.register(fastifyCors, { origin: true });

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
      setHeaders(res, filePath) {
        // Vite 产物带内容 hash（/assets/*）：长缓存 + immutable，二次打开零请求；
        // index.html / sw.js / manifest 保持协商缓存（发版可见性与 SW 更新检查）
        if (filePath.split(sep).includes("assets")) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
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
  // 统一事件出口：通知聚合（settled/error + 最后输出摘要）+ WS 推送 +
  // 全局 status 变更广播（首页运行看板实时刷新）
  const emit = (sessionId: string, event: ServerEvent): void => {
    dashboard.recordEvent(sessionId, event);
    if (event.type === "status") {
      wshub.broadcastGlobal({ type: "session_status", sessionId, status: event.status });
    }
    wshub.broadcast(sessionId, event);
    // 子代理活动路由（反馈轮 3 #4）：子会话事件按 parentSessionId 汇到父会话通道
    const routed = subAgentRouter.route(sessionId, event);
    if (routed) wshub.broadcast(routed.parentSessionId, routed.event);
  };
  const piHub = new SessionHub(config.sessionDir, emit);
  // 终端 pi 反向指令通道（E3 双模式）：心跳 / 指令队列 / 回执（attach_state、command_ack 走同一 emit）
  const agents = new AgentCommandHub(emit);
  // Claude Code 会话来源：~/.claude/projects/<encoded-cwd>/<uuid>.jsonl + history.jsonl
  const claudeProjectsDir = join(homedir(), ".claude", "projects");
  const claudeHistoryFile = join(homedir(), ".claude", "history.jsonl");
  const claudeAdapter = new ClaudeAdapter({ projectsDir: claudeProjectsDir, historyFile: claudeHistoryFile, emit });
  // Codex 会话来源：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl + session_index.jsonl（与桌面 app/CLI 共享）
  const codexSessionsDir = join(homedir(), ".codex", "sessions");
  const codexSessionIndexFile = join(homedir(), ".codex", "session_index.jsonl");
  const codexAdapter = new CodexAdapter({ sessionsDir: codexSessionsDir, sessionIndexFile: codexSessionIndexFile, emit });
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
  // Token 用量汇总（契约 §15，pi 源）：按文件 mtime+size 增量重读，presence 变更时失效
  const usage = new UsageService({ sessionDir: config.sessionDir });
  const kpi = new KpiService({ configDir, kpiRefreshMinutes: config.kpiRefreshMinutes });
  // ttyd Web 终端服务（F2）：生命周期归 server 管（关闭时回收 ttyd）
  const terminalService = new TerminalService();
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
    webRoot: webDistDir,
    logger: true,
    // ttyd Web 终端（F2）：按需拉起 + 同源反代（POSIX；win32 自动降级为提示）
    terminal: terminalService,
    systemInfo: async () => ({
      ...(await systemInfo()),
      terminal: await terminalService.status(),
    }),
  });

  await app.listen({ port: config.port, host: config.host });
  agents.startSweep();
  // live map LRU/TTL 逐出 + feedSessions/statuses 过期清扫（30s，unref；OOM 审计 AC2/AC3）
  piHub.startSweep();
  // usage 启动预热（fire-and-forget）：预扫全部会话 JSONL，/api/usage 冷启动不再同步等 2.3s（
  // 请求侧另有 ≤300ms 限时兑底，超时先回当前缓存/空窗，UI 走无数据占位降级，最终一致）
  usage.warmup();
  const tails = new SessionTailManager((sessionId, event) => emit(sessionId, event));
  // 会话一旦由本进程接管（live），停掉文件 tail，避免双推送源产生重复气泡
  hub.onLive = (sid) => tails.detach(sid);
  // attach 接管期间拒绝 WS parallel 发送（与 REST /prompt 同一冲突保护）
  wshub.attach(app.server, hub, tails, (id) =>
    agents.isAttached(id)
      ? { code: ErrorCodes.ATTACH_ACTIVE, message: "终端接管中：平行发送已停用（切回 📱 平行模式可恢复）" }
      : null,
  );
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
    void started.close().then(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

// 直接执行时启动（被 import 时不自启，便于测试）
const entryHref = process.argv[1] !== undefined ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (entryHref === import.meta.url) {
  void main().catch((err) => {
    console.error("[agent-hub] failed to start:", err);
    process.exit(1);
  });
}
