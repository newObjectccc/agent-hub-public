/**
 * REST 路由（docs/API_CONTRACT.md §1-§5）。
 * 统一错误信封：{ "error": { "code", "message" } }
 */
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CommandsApi } from "./commands.js";
import { createCommandsApi } from "./commands.js";
import type { HubConfig } from "./config.js";
import type { DashboardServiceLike } from "./dashboard.js";
import { ErrorCodes, HubError, toErrorEnvelope } from "./errors.js";
import { listDir, type ListDirOptions } from "./fs-tree.js";
import { createGitApi, type GitApi } from "./git.js";
import type { KpiService } from "./kpi.js";
import type { LiveIngestLike } from "./live.js";
import type { PromptResult } from "./sessions/hub.js";
import { fullPage, paginateMessages, parseLimit } from "./sessions/paginate.js";
import type {
  CommandListDto,
  FsTreeDto,
  MessageDto,
  SearchResultDto,
  SessionListItem,
  SessionSource,
  SessionStatus,
  SessionTreeDto,
  SystemInfo,
} from "./types.js";

/** SessionHub 的结构接口（测试可注入 fake） */
export interface SessionHubLike {
  getStatus(id: string): SessionStatus;
  listSessions(): Promise<SessionListItem[]>;
  findSession(id: string): Promise<SessionListItem | null>;
  loadMessages(id: string): Promise<MessageDto[] | null>;
  search(query: string, limit?: number): Promise<SearchResultDto[]>;
  loadTree(id: string): Promise<SessionTreeDto | null>;
  createSession(cwd: string, name?: string, source?: SessionSource): Promise<SessionListItem>;
  forkSession(id: string): Promise<SessionListItem>;
  prompt(id: string, text: unknown, modeRaw: unknown): Promise<PromptResult>;
  abort(id: string): Promise<void>;
  /** 手动压缩上下文（pi 专用；instructions 透传 SDK session.compact()） */
  compact(id: string, instructions?: string): Promise<void>;
}

export interface RouteDeps {
  hub: SessionHubLike;
  kpi: Pick<KpiService, "getCards">;
  config: HubConfig;
  systemInfo: () => Promise<SystemInfo>;
  /** 只读 git/文件 API（可注入 mock；缺省用真实实现） */
  git?: GitApi;
  /** pi 扩展 live-feed 接入（可选，缺省时 /api/live 返回 503） */
  live?: LiveIngestLike;
  /** 首页工作台统计 + 通知（docs/API_CONTRACT.md §4-§5） */
  dashboard: DashboardServiceLike;
  /** slash 命令清单（可注入 mock；缺省真实扫描 ~/.claude/commands） */
  commands?: CommandsApi;
  /** 文件树只读列表（可注入 mock；缺省真实 fs） */
  fsTree?: { listDir(cwd: string, options: ListDirOptions): Promise<FsTreeDto> };
}

function tokenMatches(headerValue: string, expected: string): boolean {
  const a = Buffer.from(headerValue);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);}

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
  const { hub, kpi, config, dashboard } = deps;
  const git = deps.git ?? createGitApi();
  const commands: CommandsApi = deps.commands ?? createCommandsApi();
  const fsTree = deps.fsTree ?? { listDir: (cwd: string, options: ListDirOptions) => listDir(cwd, options) };
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

  // GET /api/sessions/:id（支持 ?before=<messageId>&limit=<n> 消息分页，契约 §1）
  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>(
    "/api/sessions/:id",
    async (req, reply) => {
      try {
        const session = await hub.findSession(req.params.id);
        if (!session) {
          throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${req.params.id}`, 404);
        }
        const query = (req.query ?? {}) as { before?: unknown; limit?: unknown };
        const limit = parseLimit(query.limit);
        if (limit === null) {
          throw new HubError(ErrorCodes.INVALID_REQUEST, "limit 必须是 1..500 的整数");
        }
        const before = typeof query.before === "string" && query.before !== "" ? query.before : undefined;
        if (query.before !== undefined && before === undefined) {
          throw new HubError(ErrorCodes.INVALID_REQUEST, "before 必须是非空消息 id");
        }
        const all = (await hub.loadMessages(req.params.id)) ?? [];
        // 不带分页查询：保持 v0 全量行为（hasMore=false / nextBefore=null）
        const page = limit === undefined && before === undefined ? fullPage(all) : paginateMessages(all, { before, limit });
        return reply.send({ session, messages: page.messages, hasMore: page.hasMore, nextBefore: page.nextBefore });
      } catch (err) {
        return handle(reply, err);
      }
    },
  );

  // GET /api/search?q=&limit=
  app.get<{ Querystring: { q?: string; limit?: string } }>("/api/search", async (req, reply) => {
    try {
      const q = typeof req.query.q === "string" ? req.query.q : "";
      if (q.trim() === "") {
        throw new HubError(ErrorCodes.INVALID_REQUEST, "缺少搜索关键词 q");
      }
      const rawLimit = req.query.limit;
      const parsedLimit = rawLimit !== undefined ? Number(rawLimit) : NaN;
      const limit = Number.isFinite(parsedLimit) ? Math.floor(parsedLimit) : undefined;
      const results = await hub.search(q, limit);
      return reply.send({ results });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // GET /api/sessions/:id/tree
  app.get<{ Params: { id: string } }>("/api/sessions/:id/tree", async (req, reply) => {
    try {
      const tree = await hub.loadTree(req.params.id);
      if (!tree) {
        throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${req.params.id}`, 404);
      }
      return reply.send(tree);
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/sessions（body.source: "pi"|"claude"，缺省 pi）
  app.post("/api/sessions", async (req, reply) => {
    try {
      const { cwd, name } = requireAbsoluteCwd(req.body);
      const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as { source?: unknown };
      const sourceRaw = body.source;
      const source = sourceRaw === undefined || sourceRaw === null || sourceRaw === "" ? "pi" : sourceRaw;
      if (source !== "pi" && source !== "claude") {
        throw new HubError(ErrorCodes.INVALID_REQUEST, "source 必须是 pi|claude 之一");
      }
      const session = await hub.createSession(cwd, name, source);
      return reply.status(201).send({ session });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/sessions/:id/fork：基于完整上下文复制为独立新会话（原会话只读不受影响）
  app.post<{ Params: { id: string } }>("/api/sessions/:id/fork", async (req, reply) => {
    try {
      const session = await hub.forkSession(req.params.id);
      return reply.status(201).send({ session });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/sessions/:id/prompt
  app.post<{ Params: { id: string } }>("/api/sessions/:id/prompt", async (req, reply) => {
    try {
      const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as { text?: unknown; mode?: unknown };
      const text = body.text;
      // pi slash 命令 `/compact [instructions]`：SDK prompt() 不处理内置命令（实测透传成普通消息），
      // 改走官方 SDK session.compact() 通道（契约 §8）；其余命令原样作为 prompt 文本发送
      if (typeof text === "string") {
        const compactMatch = text.match(/^\/compact(?:\s+([\s\S]*))?$/);
        if (compactMatch) {
          const session = await hub.findSession(req.params.id);
          if (!session) {
            throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${req.params.id}`, 404);
          }
          if (session.source === "pi") {
            try {
              await hub.compact(req.params.id, (compactMatch[1] ?? "").trim() || undefined);
            } catch (err) {
              // SDK 报 “Nothing to compact”（会话太小）等语义错误 → 400，不进 500
              const message = err instanceof Error ? err.message : String(err);
              if (/nothing to compact/i.test(message)) {
                throw new HubError(ErrorCodes.INVALID_REQUEST, message, 400);
              }
              throw err;
            }
            return reply.status(202).send({ accepted: true, mode: "prompt", handled: "compact" });
          }
        }
      }
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

  /* ===== git / 文件只读 API（契约 §6，硬约束：只读） ===== */

  type GitQuery = { cwd?: string; file?: string; commit?: string; limit?: string; path?: string };
  const queryCwd = (query: GitQuery): string => {
    // cwd 缺失/相对/非仓库都回 404 信封（NOT_REPO），语义统一（契约 §6）
    const cwd = typeof query.cwd === "string" ? query.cwd : "";
    return cwd.trim();
  };

  // GET /api/git/status?cwd=
  app.get<{ Querystring: GitQuery }>("/api/git/status", async (req, reply) => {
    try {
      return reply.send(await git.status(queryCwd(req.query)));
    } catch (err) {
      return handle(reply, err);
    }
  });

  // GET /api/dashboard/stats（首页今日概览 + 工作中/等你处理分区）
  app.get("/api/dashboard/stats", async (_req, reply) => {
    try {
      return reply.send(await dashboard.getStats());
    } catch (err) {
      return handle(reply, err);
    }
  });

  // GET /api/git/log?cwd=&limit=
  app.get<{ Querystring: GitQuery }>("/api/git/log", async (req, reply) => {
    try {
      const limit = Number.parseInt(req.query.limit ?? "20", 10);
      const commits = await git.log(queryCwd(req.query), Number.isFinite(limit) ? limit : 20);
      return reply.send({ commits });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // GET /api/notifications（最近 50 条 + 未读数）
  app.get("/api/notifications", async (_req, reply) => {
    try {
      return reply.send(await dashboard.listNotifications());
    } catch (err) {
      return handle(reply, err);
    }
  });

  // GET /api/git/diff?cwd=&file=&commit=
  app.get<{ Querystring: GitQuery }>("/api/git/diff", async (req, reply) => {
    try {
      const file = typeof req.query.file === "string" && req.query.file.trim() !== "" ? req.query.file.trim() : null;
      const commit =
        typeof req.query.commit === "string" && req.query.commit.trim() !== "" ? req.query.commit.trim() : null;
      return reply.send(await git.diff(queryCwd(req.query), file, commit));
    } catch (err) {
      return handle(reply, err);
    }
  });

  // GET /api/git/branches?cwd=
  app.get<{ Querystring: GitQuery }>("/api/git/branches", async (req, reply) => {
    try {
      return reply.send(await git.branches(queryCwd(req.query)));
    } catch (err) {
      return handle(reply, err);
    }
  });

  // GET /api/files/content?cwd=&path=
  app.get<{ Querystring: GitQuery }>("/api/files/content", async (req, reply) => {
    try {
      const path = typeof req.query.path === "string" ? req.query.path.trim() : "";
      return reply.send(await git.fileContent(queryCwd(req.query), path));
    } catch (err) {
      return handle(reply, err);
    }
  });

  // GET /api/commands?source=pi|claude（契约 §8：slash 命令清单，pi 内置 + claude 内置/自定义）
  app.get<{ Querystring: { source?: string } }>("/api/commands", async (req, reply) => {
    try {
      const source = req.query.source;
      if (source !== "pi" && source !== "claude") {
        throw new HubError(ErrorCodes.INVALID_REQUEST, "source 必须是 pi|claude");
      }
      const list: CommandListDto = await commands.list(source);
      return reply.send(list);
    } catch (err) {
      return handle(reply, err);
    }
  });

  // GET /api/fs/tree?cwd=&path=&q=&hidden=（契约 §9：只读单层目录列表，防路径穿越）
  app.get<{ Querystring: GitQuery & { q?: string; hidden?: string } }>("/api/fs/tree", async (req, reply) => {
    try {
      const path = typeof req.query.path === "string" ? req.query.path : undefined;
      if (req.query.path !== undefined && path === undefined) {
        throw new HubError(ErrorCodes.INVALID_REQUEST, "path 必须是字符串");
      }
      const q = typeof req.query.q === "string" ? req.query.q : undefined;
      const hiddenRaw = req.query.hidden;
      const hidden = hiddenRaw === "1" || hiddenRaw === "true";
      return reply.send(await fsTree.listDir(queryCwd(req.query), { path, q, hidden }));
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/notifications/read（body.ids 缺省=全部已读；带 ids=单条/多条已读）
  app.post<{ Body: { ids?: unknown } }>("/api/notifications/read", async (req, reply) => {
    try {
      const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as { ids?: unknown };
      if (body.ids !== undefined) {
        if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string" || id === "")) {
          throw new HubError(ErrorCodes.INVALID_REQUEST, "ids 必须是非空字符串数组");
        }
      }
      const unreadCount = await dashboard.markRead(body.ids as string[] | undefined);
      return reply.send({ ok: true, unreadCount });
    } catch (err) {
      return handle(reply, err);
    }
  });
}
