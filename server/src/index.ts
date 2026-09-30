/**
 * agent-hub server 入口：Fastify REST + WS + pi SDK + KPI + 系统探测 + 静态托管 web/dist。
 * 默认监听 127.0.0.1:7700（config/hub.config.json 可覆盖），绝不明文绑定公网。
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { ClaudeAdapter } from "./adapters/claude.js";
import { findClaudeSessionFiles } from "./adapters/claude-transcript.js";
import { PiAdapter } from "./adapters/pi.js";
import { SessionRegistry } from "./adapters/registry.js";
import { loadHubConfig, type HubConfig } from "./config.js";
import { DashboardService } from "./dashboard.js";
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
import type { ServerEvent } from "./types.js";
import { WsHub } from "./ws.js";

export interface CreateAppOptions extends RouteDeps {
  /** 静态托管根目录（web/dist）；null 表示不托管 */
  webRoot?: string | null;
  logger?: boolean;
}

/** 装配 Fastify app：CORS + REST 路由 + 静态托管 + SPA history fallback */
export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, forceCloseConnections: true });
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
  });
  // 静态托管 web/dist（存在时），单进程即可服务 PWA
  const root = options.webRoot ?? null;
  const hasWeb = root !== null && existsSync(join(root, "index.html"));
  if (hasWeb && root !== null) {
    await app.register(fastifyStatic, { root, prefix: "/" });
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
  // Claude Code 会话来源：~/.claude/projects/<encoded-cwd>/<uuid>.jsonl + history.jsonl
  const claudeProjectsDir = join(homedir(), ".claude", "projects");
  const claudeHistoryFile = join(homedir(), ".claude", "history.jsonl");
  const claudeAdapter = new ClaudeAdapter({ projectsDir: claudeProjectsDir, historyFile: claudeHistoryFile, emit });
  const hub = new SessionRegistry(new PiAdapter(piHub), claudeAdapter, config.sessionDir);
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
  const kpi = new KpiService({ configDir, kpiRefreshMinutes: config.kpiRefreshMinutes });
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
    config,
    live: liveIngest,
    webRoot: webDistDir,
    logger: true,
    systemInfo: createSystemInfoProvider({
      sessionDir: config.sessionDir,
      workspaceRoot: config.workspaceRoot,
      sdkVersion: VERSION,
    }),
  });

  await app.listen({ port: config.port, host: config.host });
  const tails = new SessionTailManager((sessionId, event) => emit(sessionId, event));
  // 会话一旦由本进程接管（live），停掉文件 tail，避免双推送源产生重复气泡
  hub.onLive = (sid) => tails.detach(sid);
  wshub.attach(app.server, hub, tails);
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
