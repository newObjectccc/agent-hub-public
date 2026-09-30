/**
 * REST 路由（docs/API_CONTRACT.md §1-§5）。
 * 统一错误信封：{ "error": { "code", "message" } }
 */
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AgentLinkLike, CommandMode } from "./agents.js";
import type { CommandsApi } from "./commands.js";
import { createCommandsApi } from "./commands.js";
import type { HubConfig } from "./config.js";
import type { DashboardServiceLike } from "./dashboard.js";
import { ErrorCodes, HubError, toErrorEnvelope } from "./errors.js";
import { listDir, type ListDirOptions } from "./fs-tree.js";
import { createGitApi, type GitApi } from "./git.js";
import type { KpiService } from "./kpi.js";
import type { LiveIngestLike } from "./live.js";
import { createPanelDrivenStore, drivenByOf, type PanelDrivenStoreLike } from "./panelDriven.js";
import { dataDir } from "./paths.js";
import type { PromptResult } from "./sessions/hub.js";
import { fullPage, paginateMessages, parseLimit } from "./sessions/paginate.js";
import { buildSubAgentActivity } from "./subagents.js";
import {
  loadImageAttachments,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_UPLOAD_BODY_BYTES,
  saveUpload,
} from "./uploads.js";
import type {
  CommandListDto,
  FsTreeDto,
  MessageDto,
  PromptImageAttachment,
  SearchResultDto,
  SessionListItem,
  SessionSource,
  SessionStatus,
  SessionTreeDto,
  SystemInfo,
  UploadDto,
} from "./types.js";

/** SessionHub 的结构接口（测试可注入 fake） */
export interface SessionHubLike {
  getStatus(id: string): SessionStatus;
  listSessions(): Promise<SessionListItem[]>;
  findSession(id: string): Promise<SessionListItem | null>;
  loadMessages(id: string): Promise<MessageDto[] | null>;
  /** 轻量消息解析（已知 sessionFile 直读，跳过全量扫描；子代理活动快照聚合用） */
  loadMessagesFast?(id: string, sessionFile: string): Promise<MessageDto[]>;
  search(query: string, limit?: number): Promise<SearchResultDto[]>;
  loadTree(id: string): Promise<SessionTreeDto | null>;
  createSession(cwd: string, name?: string, source?: SessionSource): Promise<SessionListItem>;
  forkSession(id: string): Promise<SessionListItem>;
  prompt(id: string, text: unknown, modeRaw: unknown, images?: PromptImageAttachment[]): Promise<PromptResult>;
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
  /** 面板驱动标注（可注入 mock；缺省持久化到 data/panel-driven.json） */
  panelDriven?: PanelDrivenStoreLike;
  /** 终端 pi 反向指令通道（E3 双模式；可注入 mock，缺省不启用接管相关路由） */
  agents?: AgentLinkLike;
}

/** 会话项注入终端驱动状态（仅 pi 会话；agents 未启用时原样返回） */
function stampTerminal(session: SessionListItem, agents?: AgentLinkLike): SessionListItem {
  if (!agents || session.source !== "pi") return session;
  return { ...session, terminal: agents.statusFor(session.id) };
}

/** 指令通道仅限本机回环 + 共享 token（防局域网伪造心跳/指令/回执） */
function isLoopbackAddr(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, "");
  return a === "127.0.0.1" || a === "::1" || a === "localhost";
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
  const panelDriven: PanelDrivenStoreLike = deps.panelDriven ?? createPanelDrivenStore(dataDir);
  /** 会话 DTO 附加最后驱动来源（契约 §1，面板驱动过即 panel） */
  const decorateSession = (s: SessionListItem): SessionListItem => ({
    ...s,
    lastDrivenBy: drivenByOf(panelDriven, s.id),
  });
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

  /** 冲突保护：attach 接管期间拒绝 parallel 发送/压缩（防 server SDK 与终端 pi 双写同一会话） */
  const rejectIfAttached = (id: string): void => {
    if (deps.agents?.isAttached(id)) {
      throw new HubError(
        ErrorCodes.ATTACH_ACTIVE,
        "终端接管中：消息由电脑终端 pi 执行，平行发送已停用（切回 📱 平行模式可恢复）",
        409,
      );
    }
  };

  // GET /api/sessions
  app.get("/api/sessions", async (_req, reply) => {
    try {
      const sessions = (await hub.listSessions()).map(decorateSession);
      return reply.send({ sessions: sessions.map((s) => stampTerminal(s, deps.agents)) });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // GET /api/sessions/:id（支持 ?before=<messageId>&limit=<n> 消息分页，契约 §1）
  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>(
    "/api/sessions/:id",
    async (req, reply) => {
      try {
        const found = await hub.findSession(req.params.id);
        if (!found) {
          throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${req.params.id}`, 404);
        }
        const session = decorateSession(found);
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
        return reply.send({ session: stampTerminal(session, deps.agents), messages: page.messages, hasMore: page.hasMore, nextBefore: page.nextBefore });
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

  // GET /api/sessions/:id/agents：子代理活动快照（反馈轮 3 #4，父会话面板初始化）
  app.get<{ Params: { id: string } }>("/api/sessions/:id/agents", async (req, reply) => {
    try {
      const all = await hub.listSessions();
      // 只聚合 pi-subagents 派生子代理（fork 分支虽带 parentSessionId 但不是“子代理在干活”）
      const children = all.filter((s) => s.isSubAgent && s.parentSessionId === req.params.id);
      // 分批解析（6 并发）：长会话几十个子代理时避免一次性 40+ 个文件流排队拖慢首屏
      const agents = [];
      for (let i = 0; i < children.length; i += 6) {
        const batch = children.slice(i, i + 6);
        const built = await Promise.all(
          batch.map(async (s) => {
            // 轻量路径：直接按 sessionFile 解析（每个子代理一次 findSession 全量扫描会把聚合拖到秒级）
            const messages = hub.loadMessagesFast
              ? await hub.loadMessagesFast(s.id, s.sessionFile)
              : (await hub.loadMessages(s.id)) ?? [];
            return buildSubAgentActivity(s, messages);
          }),
        );
        agents.push(...built);
      }
      return reply.send({ agents });
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

  // POST /api/sessions/:id/prompt（images：上传图片相对路径数组，pi 直接附图，契约 §1/§11）
  app.post<{ Params: { id: string } }>("/api/sessions/:id/prompt", async (req, reply) => {
    try {
      rejectIfAttached(req.params.id);
      const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as {
        text?: unknown;
        mode?: unknown;
        images?: unknown;
      };
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
            await panelDriven.mark(req.params.id);
            return reply.status(202).send({ accepted: true, mode: "prompt", handled: "compact" });
          }
        }
      }
      let attachments: PromptImageAttachment[] | undefined;
      if (body.images !== undefined && body.images !== null) {
        if (!Array.isArray(body.images)) {
          throw new HubError(ErrorCodes.INVALID_REQUEST, "images 必须是路径数组");
        }
        if (body.images.length > MAX_ATTACHMENTS_PER_MESSAGE) {
          throw new HubError(ErrorCodes.INVALID_REQUEST, `单条消息最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 张图片`);
        }
        const owner = await hub.findSession(req.params.id);
        if (!owner) {
          throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${req.params.id}`, 404);
        }
        attachments = await loadImageAttachments(owner.cwd, body.images);
      }
      const result = await hub.prompt(req.params.id, body.text, body.mode, attachments);
      if (result.busy) {
        throw new HubError(ErrorCodes.SESSION_BUSY, "会话正在运行中；可指定 mode=steer|followUp 或先 abort", 409);
      }
      // 面板驱动标注（心理预期管理）：接受 prompt 即记入“面板驱动过”集合
      await panelDriven.mark(req.params.id);
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
      rejectIfAttached(req.params.id);
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

  /* ===== 终端接管 / 指令队列（E3 双模式，契约 §12） ===== */

  /** 指令通道鉴权：仅限本机回环 + auth.token 非空时校验 Bearer（防局域网伪造） */
  const requireAgentChannel = (req: FastifyRequest): void => {
    if (!isLoopbackAddr(req.ip) && !isLoopbackAddr(req.socket?.remoteAddress)) {
      throw new HubError(ErrorCodes.UNAUTHORIZED, "指令通道仅限本机回环访问", 401);
    }
    if (config.auth.token !== "") {
      const header = req.headers.authorization ?? "";
      if (!tokenMatches(header, `Bearer ${config.auth.token}`)) {
        throw new HubError(ErrorCodes.UNAUTHORIZED, "invalid or missing shared token", 401);
      }
    }
  };

  const requireAgents = (): AgentLinkLike => {
    if (!deps.agents) {
      throw new HubError(ErrorCodes.INTERNAL, "终端接管未启用", 503);
    }
    return deps.agents;
  };

  // POST /api/agents/heartbeat：扩展启动即注册 + 每 30s 续（server 据此判定"终端 pi 在线"）
  app.post("/api/agents/heartbeat", async (req, reply) => {
    try {
      requireAgentChannel(req);
      const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
      const { ttlMs } = requireAgents().heartbeat({
        sessionId: typeof body.sessionId === "string" ? body.sessionId : "",
        pid: body.pid,
        cwd: body.cwd,
        capabilities: body.capabilities,
      });
      return reply.status(202).send({ ok: true, ttlMs });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // GET /api/agents/commands?sessionId=&wait=：扩展长轮询指令队列（wait 钳制 0..30s）
  app.get<{ Querystring: { sessionId?: string; wait?: string } }>("/api/agents/commands", async (req, reply) => {
    try {
      requireAgentChannel(req);
      const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";
      if (sessionId === "" || sessionId.length > 256) {
        throw new HubError(ErrorCodes.INVALID_REQUEST, "sessionId 非法");
      }
      const waitRaw = Number.parseInt(req.query.wait ?? "0", 10);
      const wait = Number.isFinite(waitRaw) ? Math.max(0, Math.min(waitRaw, 30_000)) : 0;
      const commands = await requireAgents().poll(sessionId, wait);
      return reply.send({
        commands: commands.map((c) => ({
          id: c.id,
          kind: c.kind,
          text: c.text,
          mode: c.mode,
          enqueuedAt: c.enqueuedAt,
          expiresAt: c.expiresAt,
          attempts: c.attempts,
        })),
      });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/agents/ack：指令执行结果回执（幂等；失败带原因）
  app.post("/api/agents/ack", async (req, reply) => {
    try {
      requireAgentChannel(req);
      const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
      const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
      const commandId = typeof body.commandId === "string" ? body.commandId.trim() : "";
      if (sessionId === "" || commandId === "") {
        throw new HubError(ErrorCodes.INVALID_REQUEST, "sessionId / commandId 必填");
      }
      const ok = body.ok !== false;
      const error = typeof body.error === "string" ? body.error : undefined;
      const result = requireAgents().ack(sessionId, commandId, ok, error);
      return reply.status(202).send({ ok: true, known: result !== null });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/sessions/:id/attach：接管会话（进入 attach 模式，需终端在线）
  app.post<{ Params: { id: string } }>("/api/sessions/:id/attach", async (req, reply) => {
    try {
      const session = await hub.findSession(req.params.id);
      if (!session) {
        throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${req.params.id}`, 404);
      }
      if (session.source !== "pi") {
        throw new HubError(ErrorCodes.INVALID_REQUEST, "仅 pi 会话支持终端接管", 400);
      }
      const agent = requireAgents().attach(req.params.id);
      return reply.status(202).send({ attached: true, agent });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/sessions/:id/detach：退出接管（恢复 parallel 通道）
  app.post<{ Params: { id: string } }>("/api/sessions/:id/detach", async (req, reply) => {
    try {
      requireAgents().detach(req.params.id);
      return reply.send({ attached: false });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/sessions/:id/message：attach 模式发消息 → 入指令队列（终端 pi 执行）
  app.post<{ Params: { id: string } }>("/api/sessions/:id/message", async (req, reply) => {
    try {
      const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
      const command = requireAgents().enqueue(req.params.id, {
        text: typeof body.text === "string" ? body.text : "",
        mode: body.mode as CommandMode | undefined,
        clientMessageId: body.clientMessageId,
      });
      return reply.status(202).send({
        accepted: true,
        channel: "attach",
        commandId: command.id,
        mode: command.mode,
      });
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

  // POST /api/uploads（契约 §11：上传到会话 cwd/.agent-hub-uploads/，base64 JSON）
  app.post("/api/uploads", { bodyLimit: MAX_UPLOAD_BODY_BYTES }, async (req, reply) => {
    try {
      const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as {
        sessionId?: unknown;
        cwd?: unknown;
        name?: unknown;
        mimeType?: unknown;
        data?: unknown;
      };
      // cwd 优先取 sessionId 归属会话（防前端伪造任意写入目录）；无 sessionId 时要求显式绝对路径 cwd
      let cwd: string | null = null;
      if (typeof body.sessionId === "string" && body.sessionId !== "") {
        const session = await hub.findSession(body.sessionId);
        if (!session) {
          throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${body.sessionId}`, 404);
        }
        cwd = session.cwd;
      } else if (typeof body.cwd === "string" && body.cwd.trim() !== "") {
        const { cwd: abs } = requireAbsoluteCwd({ cwd: body.cwd });
        cwd = abs;
      }
      const upload: UploadDto = await saveUpload({
        cwd,
        sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
        name: body.name,
        mimeType: body.mimeType,
        data: body.data,
      });
      return reply.status(201).send({ upload });
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
