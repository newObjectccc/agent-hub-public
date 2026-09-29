/**
 * agent-hub server 入口：Fastify REST + WS + pi SDK + KPI + 系统探测 + 静态托管 web/dist。
 * 默认监听 127.0.0.1:7700（config/hub.config.json 可覆盖），绝不明文绑定公网。
 */
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { loadHubConfig, type HubConfig } from "./config.js";
import { KpiService } from "./kpi.js";
import { configDir, webDistDir } from "./paths.js";
import { registerRoutes, type RouteDeps, type SessionHubLike } from "./routes.js";
import { SessionHub } from "./sessions/hub.js";
import { probeSystem } from "./system.js";
import type { ServerEvent } from "./types.js";
import { WsHub } from "./ws.js";

export interface CreateAppOptions extends RouteDeps {
  /** 静态托管根目录（web/dist）；null 表示不托管 */
  webRoot?: string | null;
  logger?: boolean;
}

/** 装配 Fastify app：CORS + REST 路由 + 静态托管 + SPA history fallback */
export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  await app.register(fastifyCors, { origin: true });

  await registerRoutes(app, {
    hub: options.hub,
    kpi: options.kpi,
    config: options.config,
    systemInfo: options.systemInfo,
  });

  // 静态托管 web/dist（存在时），单进程即可服务 PWA
  const root = options.webRoot ?? null;
  const hasWeb = root !== null && existsSync(join(root, "index.html"));
  if (hasWeb && root !== null) {
    await app.register(fastifyStatic, { root, prefix: "/" });
    // SPA history fallback：不在 /api、/ws 前缀下的 GET 未命中静态文件 → index.html
    // （前端路由 /s/:id 等直接刷新不 404）
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/ws")) {
        return reply.type("text/html").sendFile("index.html");
      }
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: `no route: ${req.url}` } });
    });
    app.log.info(`serving PWA from ${root}`);
  }

  return app;
}

export interface StartedHub {
  app: FastifyInstance;
  hub: SessionHub;
  kpi: KpiService;
  config: HubConfig;
  close(): Promise<void>;
}

export async function startHub(): Promise<StartedHub> {
  const { config, warnings } = loadHubConfig(configDir);
  for (const warning of warnings) {
    console.warn(`[agent-hub] ${warning}`);
  }

  const wshub = new WsHub();
  const emit = (sessionId: string, event: ServerEvent): void => wshub.broadcast(sessionId, event);
  const hub = new SessionHub(config.sessionDir, emit);
  const kpi = new KpiService({ configDir, kpiRefreshMinutes: config.kpiRefreshMinutes });

  const app = await createApp({
    hub,
    kpi,
    config,
    webRoot: webDistDir,
    logger: true,
    systemInfo: () =>
      probeSystem({ sessionDir: config.sessionDir, workspaceRoot: config.workspaceRoot, sdkVersion: VERSION }),
  });

  await app.listen({ port: config.port, host: config.host });
  wshub.attach(app.server, hub);
  await kpi.start();

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    kpi.stop();
    hub.disposeAll();
    await app.close();
  };

  return { app, hub, kpi, config, close };
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
