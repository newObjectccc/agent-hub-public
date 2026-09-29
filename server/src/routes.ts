/**
 * REST 路由（docs/API_CONTRACT.md §1-§3）。
 * 统一错误信封：{ "error": { "code", "message" } }
 */
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { HubConfig } from "./config.js";
import { ErrorCodes, HubError, toErrorEnvelope } from "./errors.js";
import type { KpiService } from "./kpi.js";
import type { LiveIngestLike } from "./live.js";
import type { PromptResult } from "./sessions/hub.js";
import type { MessageDto, SessionListItem, SessionStatus, SystemInfo } from "./types.js";

/** SessionHub 的结构接口（测试可注入 fake） */
export interface SessionHubLike {
  getStatus(id: string): SessionStatus;
  listSessions(): Promise<SessionListItem[]>;
  findSession(id: string): Promise<SessionListItem | null>;
  loadMessages(id: string): Promise<MessageDto[] | null>;
  createSession(cwd: string, name?: string): Promise<SessionListItem>;
  prompt(id: string, text: unknown, modeRaw: unknown): Promise<PromptResult>;
  abort(id: string): Promise<void>;
  compact(id: string): Promise<void>;
}

export interface RouteDeps {
  hub: SessionHubLike;
  kpi: Pick<KpiService, "getCards">;
  config: HubConfig;
  systemInfo: () => Promise<SystemInfo>;
  /** pi 扩展 live-feed 接入（可选，缺省时 /api/live 返回 503） */
  live?: LiveIngestLike;
}

function tokenMatches(headerValue: string, expected: string): boolean {
  const a = Buffer.from(headerValue);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function handle(reply: FastifyReply, err: unknown): void {
  const { statusCode, body } = toErrorEnvelope(err);
  void reply.status(statusCode).send(body);
}

function requireAbsoluteCwd(body: unknown): { cwd: string; name?: string } {
  const record = (typeof body === "object" && body !== null ? body : {}) as { cwd?: unknown; name?: unknown };
  const cwd = record.cwd;
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new HubError(ErrorCodes.INVALID_CWD, "请求体需要 cwd（绝对路径）");
  }
  if (!cwd.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(cwd)) {
    throw new HubError(ErrorCodes.INVALID_CWD, `cwd 必须是绝对路径: ${cwd}`);
  }
  const name = typeof record.name === "string" && record.name.trim() !== "" ? record.name.trim() : undefined;
  return { cwd, name };
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { hub, kpi, config } = deps;

  // auth.token 预留：enabled 时校验 Bearer（v0 默认关闭）
  if (config.auth.enabled && config.auth.token !== "") {
    app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
      const header = req.headers.authorization ?? "";
      const expected = `Bearer ${config.auth.token}`;
      const ok = tokenMatches(header, expected);
      if (!ok) {
        return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "invalid or missing bearer token" } });
      }
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    handle(reply, err);
  });

  // GET /api/sessions
  app.get("/api/sessions", async (_req, reply) => {
    try {
      const sessions = await hub.listSessions();
      return reply.send({ sessions });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // GET /api/sessions/:id
  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (req, reply) => {
    try {
      const session = await hub.findSession(req.params.id);
      if (!session) {
        throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${req.params.id}`, 404);
      }
      const messages = (await hub.loadMessages(req.params.id)) ?? [];
      return reply.send({ session, messages });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/sessions
  app.post("/api/sessions", async (req, reply) => {
    try {
      const { cwd, name } = requireAbsoluteCwd(req.body);
      const session = await hub.createSession(cwd, name);
      return reply.status(201).send({ session });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/sessions/:id/prompt
  app.post<{ Params: { id: string } }>("/api/sessions/:id/prompt", async (req, reply) => {
    try {
      const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as { text?: unknown; mode?: unknown };
      const result = await hub.prompt(req.params.id, body.text, body.mode);
      if (result.busy) {
        throw new HubError(ErrorCodes.SESSION_BUSY, "会话正在运行中；可指定 mode=steer|followUp 或先 abort", 409);
      }
      return reply.status(202).send({ accepted: true, mode: result.mode });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/sessions/:id/abort
  app.post<{ Params: { id: string } }>("/api/sessions/:id/abort", async (req, reply) => {
    try {
      const session = await hub.findSession(req.params.id);
      if (!session) {
        throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${req.params.id}`, 404);
      }
      await hub.abort(req.params.id);
      return reply.send({ aborted: true });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/sessions/:id/compact
  app.post<{ Params: { id: string } }>("/api/sessions/:id/compact", async (req, reply) => {
    try {
      const session = await hub.findSession(req.params.id);
      if (!session) {
        throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${req.params.id}`, 404);
      }
      await hub.compact(req.params.id);
      return reply.send({ ok: true });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/live/:sessionId：pi 扩展 live-feed 事件接入（契约 §6，fire-and-forget）
  // 共享密钥：config auth.token 非空则校验 Bearer，空则放行（tailnet 场景）
  app.post<{ Params: { sessionId: string } }>("/api/live/:sessionId", async (req, reply) => {
    try {
      if (config.auth.token !== "") {
        const header = req.headers.authorization ?? "";
        if (!tokenMatches(header, `Bearer ${config.auth.token}`)) {
          throw new HubError(ErrorCodes.UNAUTHORIZED, "invalid or missing shared token", 401);
        }
      }
      const sessionId = req.params.sessionId;
      if (typeof sessionId !== "string" || sessionId === "" || sessionId.length > 256) {
        throw new HubError(ErrorCodes.INVALID_REQUEST, "sessionId 非法");
      }
      if (!deps.live) {
        throw new HubError(ErrorCodes.INTERNAL, "live 接入未启用", 503);
      }
      const { accepted } = deps.live.ingest(sessionId, req.body);
      return reply.status(202).send({ accepted });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // GET /api/system
  app.get("/api/system", async (_req, reply) => {
    try {
      const info = await deps.systemInfo();
      return reply.send(info);
    } catch (err) {
      return handle(reply, err);
    }
  });

  // GET /api/kpi
  app.get("/api/kpi", async (_req, reply) => {
    try {
      return reply.send({ cards: kpi.getCards() });
    } catch (err) {
      return handle(reply, err);
    }
  });
}
