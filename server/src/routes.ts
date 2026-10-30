/**
 * REST 路由（docs/API_CONTRACT.md §1-§5）。
 * 统一错误信封：{ "error": { "code", "message" } }
 */
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AgentLinkLike, CommandMode } from "./agents.js";
import type { ClaudeDriverLinkLike } from "./adapters/claude-driver.js";
import type { CodexDriverLinkLike } from "./adapters/codex-driver.js";
import { mergeCodexSnapshot } from "./adapters/codex-snapshot.js";
import { parseBridgeHostRequestBody } from "./adapters/claude-host-protocol.js";
import {
  createAppLockStore,
  isValidSecret,
  secretRuleHint,
  type AppLockStoreLike,
} from "./appLock.js";
import type { CommandsApi } from "./commands.js";
import { createCommandsApi } from "./commands.js";
import { expandPath, type HubConfig } from "./config.js";
import type { DashboardServiceLike } from "./dashboard.js";
import { ErrorCodes, HubError, toErrorEnvelope } from "./errors.js";
import { listDir, type ListDirOptions } from "./fs-tree.js";
import { createGitApi, type GitApi } from "./git.js";
import type { KpiService } from "./kpi.js";
import type { LiveIngestLike } from "./live.js";
import { createPanelDrivenStore, drivenByOf, type PanelDrivenStoreLike } from "./panelDriven.js";
import { dataDir } from "./paths.js";
import type { PromptResult } from "./sessions/hub.js";
import { parsePiModel } from "./sessions/models.js";
import { fullPage, paginateMessages, parseLimit } from "./sessions/paginate.js";
import { buildSubAgentActivity, buildClaudeSubAgentActivity } from "./subagents.js";
import { loadClaudeSubAgents } from "./adapters/claude-transcript.js";
import type { TerminalServiceLike } from "./terminal.js";
import { parseDaysParam, UsageService, type UsageServiceLike } from "./usage.js";
import {
  isUnderRoot,
  loadImageAttachments,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_UPLOAD_BODY_BYTES,
  saveUpload,
} from "./uploads.js";
import type {
  CommandListDto,
  EffectivePolicyDto,
  FsTreeDto,
  MessageDto,
  PiModelCatalog,
  PiModelRef,
  PromptImageAttachment,
  SearchResultDto,
  SessionListItem,
  SessionSource,
  SessionStatus,
  SessionTreeDto,
  SystemInfo,
  TerminalAttachInfo,
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
  createSession(cwd: string, name?: string, source?: SessionSource, model?: PiModelRef): Promise<SessionListItem>;
  getPiModels?(cwd: string): Promise<PiModelCatalog>;
  getSessionModels?(id: string): Promise<PiModelCatalog>;
  setPiModel?(id: string, model: PiModelRef): Promise<PiModelRef>;
  forkSession(id: string): Promise<SessionListItem>;
  /** 重命名会话（body.name 空串 = 清空名字）；实现方不支持时路由返回 501 */
  renameSession?(id: string, name: string): Promise<SessionListItem>;
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
  /** Token 用量汇总（docs/API_CONTRACT.md §15，pi 源；缺省按 config.sessionDir 自建） */
  usage?: UsageServiceLike;
  /** slash 命令清单（可注入 mock；缺省真实扫描 ~/.claude/commands） */
  commands?: CommandsApi;
  /** 文件树只读列表（可注入 mock；缺省真实 fs） */
  fsTree?: { listDir(cwd: string, options: ListDirOptions): Promise<FsTreeDto> };
  /** 面板驱动标注（可注入 mock；缺省持久化到 data/panel-driven.json） */
  panelDriven?: PanelDrivenStoreLike;
  /** 终端 pi 反向指令通道（E3 双模式；可注入 mock，缺省不启用接管相关路由） */
  agents?: AgentLinkLike;
  /** claude hub 驱动接管（可注入 mock，缺省 claude 接管路由回 400/503） */
  claudeDriver?: ClaudeDriverLinkLike;
  codexDriver?: CodexDriverLinkLike;
  /** 应用锁（F1；可注入 mock/临时目录，缺省持久化到 data/app-lock.json） */
  appLock?: AppLockStoreLike;
  /** ttyd Web 终端服务（F2；可注入 mock，缺省时 /api/terminal/* 返回 503） */
  terminal?: TerminalServiceLike;
  /** 应用锁门禁（F1）：传入请求的 X-App-Lock-Token，返回 false 时拒绝签发终端 token；缺省视为已解锁 */
  terminalUnlocked?: (lockToken?: string) => boolean | Promise<boolean>;}

/** 会话出参 DTO：剥离 sessionFile（服务端内部绝对路径，前端零使用；数百会话可省 ~57KB 响应） */
export type SessionDto = Omit<SessionListItem, "sessionFile">;
export function toSessionDto(session: SessionListItem): SessionDto {
  const { sessionFile: _sessionFile, ...rest } = session;
  return rest;
}

/**
 * 会话项注入终端驱动状态：pi→agents 心跳状态；claude→hub 驱动状态（docs/CLAUDE_DRIVER.md）。
 * codex/未启用对应通道时原样返回；出参统一走 SessionDto 瘦身。
 * defaultPolicy（config.claudeDriver.defaultPolicy）合并进 terminal 下发——前端默认接管判定
 * 按服务端策略走（active-only=活跃会话默认接管；always=打开即接管；never=只手动；
 * 老 server 缺省 → 前端按 active-only 容错）。pi/claude 通道的 statusFor 结果都要带。
 * 注：terminal 全量展开 statusFor 结果，因此 driver 回传的 `effectivePolicy`（P1-2：接管后
 * 实际生效的权限策略 + bypass 判定）会随之透传给前端；driver 未提供时不下发（向后兼容）。
 */
function stampTerminal(
  session: SessionListItem,
  agents?: AgentLinkLike,
  claudeDriver?: ClaudeDriverLinkLike,
  defaultPolicy?: TerminalAttachInfo["defaultPolicy"],
  codexDriver?: CodexDriverLinkLike,
): SessionDto {
  const withPolicy = (info: TerminalAttachInfo): TerminalAttachInfo =>
    defaultPolicy === undefined ? info : { ...info, defaultPolicy };
  if (session.source === "pi" && agents) {
    return toSessionDto({ ...session, terminal: withPolicy(agents.statusFor(session.id)) });
  }
  if (session.source === "claude" && claudeDriver) {
    return toSessionDto({ ...session, terminal: withPolicy(claudeDriver.statusFor(session.id)) });
  }
  if (session.source === "codex" && codexDriver && !session.archived) {
    // Codex 产品规则（2026-10-23 用户明确）：进入会话默认 📱 平行，defaultPolicy 恒 "never" 下发——
    // 接管有「须先退出桌面 ChatGPT app 对应会话」的写者互斥前提，默认接管几乎必失败；
    // 与 pi/claude（active-only：电脑活跃 → 默认接管）刻意区分。codexDriver.defaultPolicy 配置不再影响默认通道，
    // 手动切换 / pin 仍可接管。
    return toSessionDto({ ...session, status: codexDriver.runStatusFor(session.id) ?? session.status, terminal: { ...codexDriver.statusFor(session.id), source: "codex", defaultPolicy: "never" } });
  }
  return toSessionDto(session);
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

/**
 * 问答应答 body 的粗校验：{ [questionId]: string[] } 形状，逐题合法性（未知 id / 空数组 /
 * 长度上限）由 driver 按该请求下发的 questions 校验（未知 questionId 一律 400 且不消费请求）。
 */
function parseAnswerMap(value: unknown): Record<string, string[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HubError(ErrorCodes.INVALID_REQUEST, "answers 必须是 { [questionId]: string[] }");
  }
  const result: Record<string, string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!Array.isArray(item) || item.some((element) => typeof element !== "string")) {
      throw new HubError(ErrorCodes.INVALID_REQUEST, "answers 必须是 { [questionId]: string[] }");
    }
    result[key] = item as string[];
  }
  return result;
}

function handle(reply: FastifyReply, err: unknown): void {
  const { statusCode, body } = toErrorEnvelope(err);
  // 内部错误的真实 message/堆栈只进服务端日志（信封已固定为 "internal error"）
  if (statusCode >= 500) {
    console.error("[agent-hub] internal error:", err instanceof Error ? (err.stack ?? err.message) : err);
  }
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

/**
 * prompt 幂等键去重（sessionId + clientMessageId，TTL 10min）：
 * 防弱网重发双执行；首次占位防并发双发，失败释放允许重试。
 */
export class PromptIdempotencyStore {
  private readonly entries = new Map<string, { expiresAt: number; mode: string | null }>();

  constructor(
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** 首次/已过期 → 占位返回 false（可执行）；重复（处理中/已完成未过期）→ true（重放） */
  begin(key: string): boolean {
    const now = this.now();
    for (const [k, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(k);
    }
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) return true;
    this.entries.set(key, { expiresAt: now + this.ttlMs, mode: null });
    return false;
  }

  /** 处理成功：记录受理 mode，重发时重放同语义响应 */
  complete(key: string, mode: string): void {
    const hit = this.entries.get(key);
    if (hit) hit.mode = mode;
  }

  /** 处理失败：释放占位允许客户端重试（不缓存错误结果） */
  release(key: string): void {
    this.entries.delete(key);
  }

  modeOf(key: string): string | null {
    return this.entries.get(key)?.mode ?? null;
  }
}

/** 锁屏门禁豁免：解锁/设置/登录（/api/app-lock/*）+ 机器通道（/api/agents/*、/api/live——
 * 自带更严的 requireAgentChannel（仅限本机回环 + auth token），app lock 是界面锁不该锁机器 API，
 * 否则终端扩展心跳被 423 → isOnline 超时 → 「接管终端」灰显（真机反馈实测踩坑）+ 静态资源（非 /api） */
export function isAppLockExempt(url: string): boolean {
  const path = url.split("?")[0];
  if (!path.startsWith("/api")) return true;
  return path === "/api/app-lock" || path.startsWith("/api/app-lock/")
    || path === "/api/agents" || path.startsWith("/api/agents/")
    || path === "/api/live" || path.startsWith("/api/live/");
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { hub, kpi, config, dashboard } = deps;
  const git = deps.git ?? createGitApi();
  const commands: CommandsApi = deps.commands ?? createCommandsApi();
  const fsTree = deps.fsTree ?? { listDir: (cwd: string, options: ListDirOptions) => listDir(cwd, options) };
  /** Token 用量服务（缺省自建：pi 会话目录增量扫描） */
  const usageService: UsageServiceLike = deps.usage ?? new UsageService({ sessionDir: config.sessionDir });
  const panelDriven: PanelDrivenStoreLike = deps.panelDriven ?? createPanelDrivenStore(dataDir);
  const appLock: AppLockStoreLike = deps.appLock ?? createAppLockStore(dataDir);
  /** prompt 幂等键（sessionId + clientMessageId）：弱网重发不双执行 */
  const promptIdem = new PromptIdempotencyStore();
  /** 会话 DTO 附加最后驱动来源（契约 §1：面板驱动过即 panel；无消息的空会话无驱动史，不下发） */
  const decorateSession = (s: SessionListItem): SessionListItem => ({
    ...s,
    lastDrivenBy: drivenByOf(panelDriven, s.id, s.messageCount),
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

  /** 冲突保护：attach 接管期间拒绝 parallel 发送/压缩（防双写同一会话：pi 指令队列 / claude hub 驱动） */
  const rejectIfAttached = (id: string, action = "平行发送"): void => {
    if (deps.agents?.isAttached(id) || deps.claudeDriver?.isAttached(id) || deps.codexDriver?.isBusy?.(id) || deps.codexDriver?.isAttached(id) || deps.codexDriver?.isAttaching(id)) {
      throw new HubError(
        ErrorCodes.ATTACH_ACTIVE,
        `终端接管中：消息由电脑上的会话执行，${action}已停用（切回 📱 平行模式可恢复）`,
        409,
      );
    }
  };

  // GET /api/sessions
  app.get("/api/sessions", async (_req, reply) => {
    try {
      const sessions = (await hub.listSessions()).map(decorateSession);
      return reply.send({
        sessions: sessions.map((s) => stampTerminal(s, deps.agents, deps.claudeDriver, deps.config.claudeDriver.defaultPolicy, deps.codexDriver)),
      });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // Identifiers only: no API keys, headers, endpoint URLs or auth records in these DTOs.
  app.get<{ Querystring: { cwd?: string } }>("/api/pi/models", async (req, reply) => {
    try {
      if (!hub.getPiModels) throw new HubError(ErrorCodes.INVALID_REQUEST, "pi 模型目录不可用", 501);
      const cwd = req.query.cwd === undefined ? config.workspaceRoot : requireAbsoluteCwd({ cwd: req.query.cwd }).cwd;
      return reply.send(await hub.getPiModels(cwd));
    } catch (err) { return handle(reply, err); }
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/model", async (req, reply) => {
    try {
      if (!hub.getSessionModels) throw new HubError(ErrorCodes.INVALID_REQUEST, "会话模型信息不可用", 501);
      return reply.send(await hub.getSessionModels(req.params.id));
    } catch (err) { return handle(reply, err); }
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/model", async (req, reply) => {
    try {
      rejectIfAttached(req.params.id, "手机切换模型");
      if (!hub.setPiModel) throw new HubError(ErrorCodes.INVALID_REQUEST, "会话模型切换不可用", 501);
      const model = parsePiModel(req.body);
      return reply.send({ model: await hub.setPiModel(req.params.id, model) });
    } catch (err) { return handle(reply, err); }
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
        const history = (await hub.loadMessages(req.params.id)) ?? [];
        const all = session.source === "codex"
          ? mergeCodexSnapshot(history, deps.codexDriver?.snapshotFor?.(req.params.id) ?? []) : history;
        // 不带分页查询：保持 v0 全量行为（hasMore=false / nextBefore=null）
        const page = limit === undefined && before === undefined ? fullPage(all) : paginateMessages(all, { before, limit });
        return reply.send({
          session: stampTerminal(session, deps.agents, deps.claudeDriver, deps.config.claudeDriver.defaultPolicy, deps.codexDriver),
          messages: page.messages,
          hasMore: page.hasMore,
          nextBefore: page.nextBefore,
        });
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
      // claude：Task 子代理（sidechain）与主会话同存一个 transcript → 直接从解析产物聚合
      const parent = all.find((s) => s.id === req.params.id);
      if (parent?.source === "claude") {
        const subs = await loadClaudeSubAgents(parent.sessionFile);
        return reply.send({ agents: buildClaudeSubAgentActivity(parent.id, subs) });
      }
      // pi：只聚合 pi-subagents 派生子代理（fork 分支虽带 parentSessionId 但不是“子代理在干活”）
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

  // POST /api/sessions（body.source: "pi"|"claude"|"codex"，缺省 pi）
  app.post("/api/sessions", async (req, reply) => {
    try {
      const { cwd, name } = requireAbsoluteCwd(req.body);
      const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as { source?: unknown; model?: unknown };
      const sourceRaw = body.source;
      const source = sourceRaw === undefined || sourceRaw === null || sourceRaw === "" ? "pi" : sourceRaw;
      if (source !== "pi" && source !== "claude" && source !== "codex") {
        throw new HubError(ErrorCodes.INVALID_REQUEST, "source 必须是 pi|claude|codex 之一");
      }
      const model = body.model === undefined ? undefined : parsePiModel(body.model);
      if (model && source !== "pi") throw new HubError(ErrorCodes.INVALID_REQUEST, "创建时选择模型目前仅支持 pi");
      const session = model ? await hub.createSession(cwd, name, source, model) : await hub.createSession(cwd, name, source);
      return reply.status(201).send({ session: toSessionDto(session) });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/sessions/:id/fork：基于完整上下文复制为独立新会话（原会话只读不受影响）
  app.post<{ Params: { id: string } }>("/api/sessions/:id/fork", async (req, reply) => {
    try {
      const session = await hub.forkSession(req.params.id);
      return reply.status(201).send({ session: toSessionDto(session) });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/sessions/:id/rename（body.name：新名字，空串=清空名字）：pi 追加 session_info entry、
  // claude 追加 ai-title 行（最新一条为当前名）；两源均快照登记改名瞬间的推断状态，防写盘刷新
  // mtime 后被 60s 时间窗误判 running（契约 §1）
  app.post<{ Params: { id: string } }>("/api/sessions/:id/rename", async (req, reply) => {
    try {
      const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as { name?: unknown };
      const name = body.name;
      if (typeof name !== "string") {
        throw new HubError(ErrorCodes.INVALID_REQUEST, "name 必须是字符串（空串 = 清空名字）");
      }
      if (name.length > 200) {
        throw new HubError(ErrorCodes.INVALID_REQUEST, "name 最长 200 字符");
      }
      if (!hub.renameSession) {
        throw new HubError(ErrorCodes.INVALID_REQUEST, "该服务不支持重命名会话", 501);
      }
      const session = await hub.renameSession(req.params.id, name);
      return reply.status(200).send({ session });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/sessions/:id/prompt（images：上传图片相对路径数组，pi 直接附图，契约 §1/§15；
  // clientMessageId 可选幂等键：同 (sessionId, clientMessageId) 重发只执行一次，重放首次受理响应）
  app.post<{ Params: { id: string } }>("/api/sessions/:id/prompt", async (req, reply) => {
    const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as {
      text?: unknown;
      mode?: unknown;
      images?: unknown;
      clientMessageId?: unknown;
    };
    const clientMessageId =
      typeof body.clientMessageId === "string" && body.clientMessageId !== "" && body.clientMessageId.length <= 128
        ? body.clientMessageId
        : undefined;
    const idemKey = clientMessageId === undefined ? null : `${req.params.id}:${clientMessageId}`;
    if (idemKey !== null && promptIdem.begin(idemKey)) {
      const replayed = promptIdem.modeOf(idemKey);
      if (replayed !== null) {
        // 首发已受理完成：重放同语义结果，不再次驱动 agent（幂等的正确形态，防双执行）
        return reply.status(202).send({ accepted: true, mode: replayed, deduplicated: true });
      }
      // 首发仍在 flight：**绝不能伪报 accepted**——此前这里回 `mode: "prompt"` + accepted:true，
      // 弱网重发方于是清掉输入框、气泡显示已发送，而首发可能随后 409/500（外部活跃/会话损坏），
      // 消息就静默消失了。回 409 让前端把它留在队列里重试（同 clientMessageId 仍幂等）。
      throw new HubError(
        ErrorCodes.PROMPT_IN_FLIGHT,
        "这条消息的上一次提交还在处理中（结果未出）：已保留在发送队列里会自动重试，不会重复执行。",
        409,
      );
    }
    try {
      rejectIfAttached(req.params.id);
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
            if (idemKey !== null) promptIdem.complete(idemKey, "prompt");
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
      if (idemKey !== null) promptIdem.complete(idemKey, result.mode);
      return reply.status(202).send({ accepted: true, mode: result.mode });
    } catch (err) {
      // 失败不缓存：释放占位允许客户端带同一 clientMessageId 重试
      if (idemKey !== null) promptIdem.release(idemKey);
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
      // hub 驱动接管中：control interrupt 中止当前 turn（进程存活可续），不走 adapter 杀进程路径
      if (session.source === "claude" && deps.claudeDriver?.isAttached(req.params.id)) {
        deps.claudeDriver.abortTurn(req.params.id);
        return reply.send({ aborted: true });
      }
      if (session.source === "codex" && (deps.codexDriver?.isAttached(req.params.id) || deps.codexDriver?.isAttaching(req.params.id))) {
        deps.codexDriver.abortTurn(req.params.id);
        return reply.send({ aborted: true });
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
  // 鉴权与 auth 同口径：token 非空（或 auth.enabled）必须 Bearer 匹配；无共享密钥时仅限本机回环，
  // 防局域网/恶意网页注入伪造会话消息
  app.post<{ Params: { sessionId: string } }>("/api/live/:sessionId", async (req, reply) => {
    try {
      if (config.auth.token !== "" || config.auth.enabled) {
        const header = req.headers.authorization ?? "";
        if (!tokenMatches(header, `Bearer ${config.auth.token}`)) {
          throw new HubError(ErrorCodes.UNAUTHORIZED, "invalid or missing shared token", 401);
        }
      } else if (!isLoopbackAddr(req.ip) && !isLoopbackAddr(req.socket?.remoteAddress)) {
        throw new HubError(ErrorCodes.UNAUTHORIZED, "live 接入仅限本机回环（或配置 auth.token 共享密钥）", 401);
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

  const requireClaudeDriver = (): ClaudeDriverLinkLike => {
    if (!deps.claudeDriver) {
      throw new HubError(ErrorCodes.INVALID_REQUEST, "claude 会话接管未启用", 400);
    }
    return deps.claudeDriver;
  };
  const requireCodexDriver = (): CodexDriverLinkLike => {
    if (!deps.codexDriver) throw new HubError(ErrorCodes.INVALID_REQUEST, "Codex 会话接管未启用，请配置 codexDriver.enabled", 400);
    return deps.codexDriver;
  };
  /**
   * 手机审批通道的归属驱动：codex / claude 各自驱动；返回 null = 该会话没有审批通道
   * （pi 源走终端扩展指令队，权限在终端里确认）。
   * P2-1：null 不再当错误抛——只读列表端点据此回落 200 空列表而不是 400：
   * e74bcde 之前 pi 会话拿到的是 `{requests: []}`，改成 400「该会话没有手机审批通道」
   * 是共享端点的错误码语义变更（且契约未记录），旧缓存 PWA / 第三方调用会突然报错。
   * 向后兼容优先：没有审批请求本就是「空列表」的语义，不是客户端错误。
   * 写路径（应答 host-requests/:requestId）仍抛 400：只有收到 host_request 事件才会调用，
   * pi 会话永远不会走到，不存在兼容风险。
   */
  const hostDriverFor = async (id: string): Promise<ClaudeDriverLinkLike | CodexDriverLinkLike | null> => {
    const session = await hub.findSession(id);
    if (!session) throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${id}`, 404);
    if (session.source === "codex") return requireCodexDriver();
    if (session.source === "claude") return requireClaudeDriver();
    return null;
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

  // POST /api/sessions/:id/attach：接管会话（pi=终端扩展指令队列；claude=hub 驱动长驻进程，docs/CLAUDE_DRIVER.md）
  app.post<{ Params: { id: string } }>("/api/sessions/:id/attach", async (req, reply) => {
    try {
      const session = await hub.findSession(req.params.id);
      if (!session) {
        throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${req.params.id}`, 404);
      }
      if (session.source === "pi") {
        const agent = requireAgents().attach(req.params.id);
        return reply.status(202).send({ attached: true, agent });
      }
      if (session.source === "claude" || session.source === "codex") {
        if (session.archived) throw new HubError(ErrorCodes.INVALID_REQUEST, "归档会话请先在 Codex 恢复后再接管", 400);
        const driver = session.source === "codex" ? requireCodexDriver() : requireClaudeDriver();
        const result = await driver.attach(req.params.id, {
          cwd: session.cwd,
          sessionFile: session.sessionFile,
        });
        const payload: {
          attached: true;
          agent: { sessionId: string; cwd: string; online: boolean; driver?: "queue" | "hub"; mirror: boolean };
          effectivePolicy?: EffectivePolicyDto;
        } = {
          attached: true,
          agent: { sessionId: req.params.id, cwd: session.cwd, online: true, driver: result.driver, mirror: result.mirror },
        };
        // P1-2：接管生效后把「实际生效的权限策略」随响应下发（bypass=true → 审批通道空转，
        // 前端不得暗示有门禁）。driver 未回传时不下发该字段（可选 + 缺省不出现 = 向后兼容）。
        const effectivePolicy = driver.statusFor(req.params.id).effectivePolicy;
        if (effectivePolicy) payload.effectivePolicy = effectivePolicy;
        return reply.status(202).send(payload);
      }
      // 兼容兼底（P2-3）：source 枚举扩展后未接接管实现的会话走这里——400 而不是 404/500，
      // 因为会话确实存在、只是该来源不支持接管（文案给前端直接展示）。
      throw new HubError(ErrorCodes.INVALID_REQUEST, "该会话不支持接管", 400);
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/sessions/:id/detach：退出接管（恢复 parallel 通道）
  app.post<{ Params: { id: string } }>("/api/sessions/:id/detach", async (req, reply) => {
    try {
      const session = await hub.findSession(req.params.id);
      // 按接管形态分流（未知会话双向容错清理，保持幂等）
      if (session?.source === "codex" || (!session && (deps.codexDriver?.isAttached(req.params.id) || deps.codexDriver?.isAttaching(req.params.id)))) {
        deps.codexDriver?.detach(req.params.id);
      } else if (session?.source === "claude" || (!session && deps.claudeDriver?.isAttached(req.params.id))) {
        requireClaudeDriver().detach(req.params.id);
      } else {
        requireAgents().detach(req.params.id);
      }
      return reply.send({ attached: false });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/sessions/:id/message：attach 模式发消息（pi=入指令队列；claude=stdin 注入真用户 turn）
  app.post<{ Params: { id: string } }>("/api/sessions/:id/message", async (req, reply) => {
    try {
      const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
      const session = await hub.findSession(req.params.id);
      // P2-2：未知会话 → 404 SESSION_NOT_FOUND（e74bcde 之前是 agents.enqueue 兼底抛的
      // 409 ATTACH_REQUIRED）。保留 404：语义更准确（会话根本不存在，而不是「需要先接管」），
      // 409 会让调用方误以为补一次 attach 就能重试；此为有意的错误码语义变更（待同步契约文档）。
      if (!session) throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${req.params.id}`, 404);
      // P2-2：`images: null` 是老 PWA 显式表达「无附件」的写法（JSON 序列化会保留 null），
      // 一律宽容视为未传；只有非 null 的非数组才是真非法值 → 400（与 /prompt 的 images 口径一致）。
      const rawImages = body.images === null ? undefined : body.images;
      if (rawImages !== undefined && !Array.isArray(rawImages)) throw new HubError(ErrorCodes.INVALID_REQUEST, "images 必须是上传图片引用数组", 400);
      const images = session.source === "codex" && rawImages !== undefined
        ? await loadImageAttachments(session.cwd, rawImages) : undefined;
      const input = {
        text: typeof body.text === "string" ? body.text : "",
        mode: body.mode as CommandMode | undefined,
        clientMessageId: body.clientMessageId,
      };
      const command =
        session.source === "codex"
          ? requireCodexDriver().send(req.params.id, { ...input, images })
          : session.source === "claude"
          ? requireClaudeDriver().send(req.params.id, input)
          : requireAgents().enqueue(req.params.id, input);
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

  /* ===== host 权限请求（hub 驱动 claude 会话的手机批权限，契约 §12） ===== */
  // 丢失 WS 回执时只读恢复，不以重发 turn 推测受理状态。
  app.get<{ Params: { id: string; commandId: string } }>("/api/sessions/:id/commands/:commandId", async (req, reply) => {
    try {
      const session = await hub.findSession(req.params.id);
      if (!session) throw new HubError(ErrorCodes.SESSION_NOT_FOUND, "会话不存在", 404);
      if (session.source !== "codex") throw new HubError(ErrorCodes.INVALID_REQUEST, "该会话不提供原生回执查询", 400);
      return reply.send(requireCodexDriver().commandStatusFor?.(req.params.id, req.params.commandId) ?? { state: "unknown", error: null });
    } catch (error) { return handle(reply, error); }
  });

  // POST /api/agents/host-requests：bridge 注册权限请求并挂起等人工应答（仅本机回环 + token）
  // 响应 {behavior, message} 直接作为 PermissionResult 依据；超时/收尾一律 deny（绝不自动 allow）
  app.post("/api/agents/host-requests", async (req, reply) => {
    try {
      requireAgentChannel(req);
      requireClaudeDriver();
      const parsed = parseBridgeHostRequestBody(req.body);
      if (!parsed) {
        throw new HubError(ErrorCodes.INVALID_REQUEST, "body 需含 sessionId/requestId/toolName", 400);
      }
      const decision = await deps.claudeDriver!.registerHostRequest(parsed);
      return reply.send({ behavior: decision.behavior, message: decision.message });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // GET /api/sessions/:id/host-requests：未决权限请求（手机刷新/重连兜底拉取，防 WS 丢事件卡死）
  app.get<{ Params: { id: string } }>("/api/sessions/:id/host-requests", async (req, reply) => {
    try {
      const driver = await hostDriverFor(req.params.id);
      // 无审批通道的源（pi）→ 200 空列表（向后兼容，理由见 hostDriverFor 注释）
      return reply.send({ requests: driver ? driver.listHostRequests(req.params.id) : [] });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/sessions/:id/host-requests/:requestId：手机应答（契约 §12）
  // body 二选一：{ outcome: "allow" | "deny" } = 审批；{ answers: { [questionId]: string[] } } = 问答
  // （kind==="question" 的请求）。二者互斥，问答的逐题校验在 driver（那里持有 questions）。
  app.post<{ Params: { id: string; requestId: string } }>(
    "/api/sessions/:id/host-requests/:requestId",
    async (req, reply) => {
      try {
        const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
        const message = typeof body.message === "string" ? body.message : undefined;
        const driver = await hostDriverFor(req.params.id);
        if (!driver) throw new HubError(ErrorCodes.INVALID_REQUEST, "该会话没有手机审批通道", 400);
        let ok: boolean;
        // 响应回显口径：问答应答成功视作 allow（已替用户提交），拒绝回答为 deny
        let resolvedOutcome: "allow" | "deny";
        if (body.answers !== undefined) {
          if (body.outcome !== undefined) throw new HubError(ErrorCodes.INVALID_REQUEST, "outcome 与 answers 只能二选一");
          // 问答应答只走 Codex 驱动（claude 的 host request 全是审批，不存在 questions）
          if (driver !== deps.codexDriver) throw new HubError(ErrorCodes.INVALID_REQUEST, "该会话不支持问答应答", 400);
          resolvedOutcome = "allow";
          ok = deps.codexDriver.respondHostRequest(req.params.id, req.params.requestId, { answers: parseAnswerMap(body.answers) });
        } else {
          const outcome = body.outcome;
          if (outcome !== "allow" && outcome !== "deny") {
            throw new HubError(ErrorCodes.INVALID_REQUEST, "outcome 必须是 allow|deny");
          }
          resolvedOutcome = outcome;
          ok = driver === deps.codexDriver
            ? deps.codexDriver.respondHostRequest(req.params.id, req.params.requestId, { outcome, message })
            : (driver as ClaudeDriverLinkLike).respondHostRequest(req.params.id, req.params.requestId, { behavior: outcome, message: message ?? "" });
        }
        if (!ok) {
          // 未知 / 已决（契约 §12）：已决记忆判 409 HOST_REQUEST_RESOLVED，其余 404（双重应答/幂等回放不再误报 404）
          const resolved = driver.isResolvedHostRequest(req.params.requestId);
          throw new HubError(
            resolved ? ErrorCodes.HOST_REQUEST_RESOLVED : ErrorCodes.HOST_REQUEST_NOT_FOUND,
            resolved ? "该权限请求已决" : "权限请求不存在",
            resolved ? 409 : 404,
          );
        }
        return reply.send({ resolved: true, outcome: resolvedOutcome });
      } catch (err) {
        return handle(reply, err);
      }
    },
  );

  // GET /api/system
  app.get("/api/system", async (_req, reply) => {
    try {
      const info = await deps.systemInfo();
      return reply.send(info);
    } catch (err) {
      return handle(reply, err);
    }
  });

  /* ===== ttyd Web 终端（契约 §13） ===== */

  const requireTerminal = (): TerminalServiceLike => {
    if (!deps.terminal) {
      throw new HubError(ErrorCodes.TERMINAL_UNAVAILABLE, "终端服务未启用", 503);
    }
    return deps.terminal;
  };

  // GET /api/terminal/status：ttyd 可用性 + 运行态 + 降级提示（不拉起进程）
  app.get("/api/terminal/status", async (_req, reply) => {
    try {
      return reply.send(await requireTerminal().status());
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/terminal/session：按需拉起 ttyd 并签发同源反代 URL（token 能力凭证）
  app.post("/api/terminal/session", async (req, reply) => {
    try {
      if (deps.terminalUnlocked && !(await deps.terminalUnlocked(lockTokenOf(req)))) {
        throw new HubError(ErrorCodes.UNAUTHORIZED, "应用已锁定：解锁后可用终端", 401);
      }
      const session = await requireTerminal().ensureSession();
      return reply.status(201).send(session);
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/terminal/stop：回收 ttyd（幂等）
  app.post("/api/terminal/stop", async (_req, reply) => {
    try {
      await requireTerminal().stop();
      return reply.send({ stopped: true });
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

  // GET /api/usage?sessionId=&days=（Token 用量汇总，契约 §14；pi + codex 源）
  app.get<{ Querystring: { sessionId?: string; days?: string } }>("/api/usage", async (req, reply) => {
    try {
      const query = (req.query ?? {}) as { sessionId?: unknown; days?: unknown };
      const days = parseDaysParam(query.days);
      const sessionId =
        typeof query.sessionId === "string" && query.sessionId.trim() !== "" ? query.sessionId.trim() : undefined;
      const now = Date.now();
      if (sessionId !== undefined) {
        const detail = await usageService.session(sessionId, now, { days });
        if (!detail) {
          throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${sessionId}`, 404);
        }
        return reply.send(detail);
      }
      return reply.send(await usageService.overview(now, { days }));
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

  // GET /api/commands?source=pi|claude|codex（契约 §8：slash 命令清单，pi 内置 + claude 内置/自定义；codex 无可用命令）
  app.get<{ Querystring: { source?: string } }>("/api/commands", async (req, reply) => {
    try {
      const source = req.query.source;
      if (source !== "pi" && source !== "claude" && source !== "codex") {
        throw new HubError(ErrorCodes.INVALID_REQUEST, "source 必须是 pi|claude|codex");
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

  // POST /api/uploads（契约 §15：上传到会话 cwd/.agent-hub-uploads/，base64 JSON）
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
      // 且必须落在 workspaceRoot 或已知会话 cwd 内（防任意目录写入）
      let cwd: string | null = null;
      const allowedCwdRoots: string[] = [expandPath(config.workspaceRoot, process.cwd())];
      if (typeof body.sessionId === "string" && body.sessionId !== "") {
        const session = await hub.findSession(body.sessionId);
        if (!session) {
          throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${body.sessionId}`, 404);
        }
        cwd = session.cwd;
        allowedCwdRoots.push(session.cwd);
      } else if (typeof body.cwd === "string" && body.cwd.trim() !== "") {
        const { cwd: abs } = requireAbsoluteCwd({ cwd: body.cwd });
        if (!isUnderRoot(allowedCwdRoots[0], abs)) {
          // workspaceRoot 外：仅允许落在已知会话 cwd 内（含自身，不接受其父级）
          const known = await hub.listSessions();
          const hit = known.find((s) => isUnderRoot(s.cwd, abs));
          if (!hit) {
            throw new HubError(ErrorCodes.INVALID_CWD, "cwd 不在 workspaceRoot 或已知会话目录内", 400);
          }
          allowedCwdRoots.push(hit.cwd);
        }
        cwd = abs;
      }
      const upload: UploadDto = await saveUpload({
        cwd,
        sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
        name: body.name,
        mimeType: body.mimeType,
        data: body.data,
        allowedCwdRoots,
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

  /* ===== 应用锁（契约 §13，F1）：UI 解锁与 auth.token（API 鉴权）完全独立 ===== */

  /** 解锁令牌只走 `X-App-Lock-Token` 请求头（绝不进 URL/日志） */
  const lockTokenOf = (req: FastifyRequest): string => {
    const raw = req.headers["x-app-lock-token"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === "string" ? value : "";
  };

  // 全局锁屏门禁（onRequest）：已配置应用锁且未解锁时，除解锁/设置/登录（/api/app-lock/*）
  // 与静态资源外的全部 API 一律拒绝（无令牌 423 / 错令牌 401，统一错误信封）
  app.addHook("onRequest", async (req, reply) => {
    if (isAppLockExempt(req.url)) return;
    if (!appLock.status().configured) return;
    const token = lockTokenOf(req);
    if (appLock.verifyToken(token).ok) return;
    if (token === "") {
      return reply.status(423).send({ error: { code: ErrorCodes.APP_LOCKED, message: "应用已锁定：请先解锁" } });
    }
    return reply.status(401).send({ error: { code: ErrorCodes.APP_LOCK_DENIED, message: "应用锁未解锁或令牌过期" } });
  });

  const requireUnlocked = (req: FastifyRequest): void => {
    if (!appLock.verifyToken(lockTokenOf(req)).ok) {
      throw new HubError(ErrorCodes.UNAUTHORIZED, "应用锁未解锁或令牌过期", 401);
    }
  };

  /** WebAuthn rpId = 请求 host 的 hostname（不含端口；dev 反代/直连同口径） */
  const rpIdOf = (req: FastifyRequest): string => {
    const forwarded = req.headers["x-forwarded-host"];
    const rawHost = (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? req.headers.host ?? "";
    const host = String(rawHost).split(",")[0].trim();
    const hostname = host.replace(/^\[/, "").split(":")[0].replace(/\]$/, "").toLowerCase();
    if (hostname === "") {
      throw new HubError(ErrorCodes.INVALID_REQUEST, "无法解析 rpId（缺 Host 头）");
    }
    return hostname;
  };

  const secretOf = (body: Record<string, unknown>, field: string): string => {
    const value = body[field];
    if (typeof value !== "string" || !isValidSecret(value)) {
      throw new HubError(ErrorCodes.INVALID_REQUEST, secretRuleHint());
    }
    return value;
  };

  // GET /api/app-lock/status：仅状态（configured/webauthn/unlocked），绝不泄漏哈希/令牌
  app.get("/api/app-lock/status", async (req, reply) => {
    try {
      const status = appLock.status();
      const unlocked = appLock.verifyToken(lockTokenOf(req)).ok;
      return reply.send({
        configured: status.configured,
        webauthn: status.webauthn,
        unlocked,
        expiresAt: unlocked ? status.expiresAt : null,
      });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/app-lock/setup：首次设置 PIN/口令（已配置 → 409，改用 change）
  app.post("/api/app-lock/setup", async (req, reply) => {
    try {
      const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
      const secret = secretOf(body, "secret");
      const issued = appLock.setup(secret);
      return reply.status(201).send({ ok: true, token: issued.token, expiresAt: issued.expiresAt });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/app-lock/unlock：验证 PIN/口令 → 发短期解锁令牌（7 天）
  app.post("/api/app-lock/unlock", async (req, reply) => {
    try {
      const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
      const secret = body.secret;
      if (typeof secret !== "string" || secret === "") {
        throw new HubError(ErrorCodes.INVALID_REQUEST, "缺少 secret");
      }
      const issued = appLock.unlock(secret);
      return reply.send({ ok: true, token: issued.token, expiresAt: issued.expiresAt });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/app-lock/change：改 PIN/口令（需验证旧 PIN；成功后令牌轮换）
  app.post("/api/app-lock/change", async (req, reply) => {
    try {
      const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
      const oldSecret = body.oldSecret;
      if (typeof oldSecret !== "string" || oldSecret === "") {
        throw new HubError(ErrorCodes.INVALID_REQUEST, "缺少 oldSecret");
      }
      const newSecret = secretOf(body, "newSecret");
      const issued = appLock.change(oldSecret, newSecret);
      return reply.send({ ok: true, token: issued.token, expiresAt: issued.expiresAt });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/app-lock/disable：关闭应用锁（需验证旧 PIN）
  app.post("/api/app-lock/disable", async (req, reply) => {
    try {
      const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
      const oldSecret = body.oldSecret;
      if (typeof oldSecret !== "string" || oldSecret === "") {
        throw new HubError(ErrorCodes.INVALID_REQUEST, "缺少 oldSecret");
      }
      appLock.disable(oldSecret);
      return reply.send({ ok: true, configured: false });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/app-lock/webauthn/register/start：注册生物识别（需已解锁令牌）
  app.post("/api/app-lock/webauthn/register/start", async (req, reply) => {
    try {
      requireUnlocked(req);
      const rpId = rpIdOf(req);
      const { challengeId, challenge } = appLock.createChallenge("create");
      return reply.send({
        challengeId,
        options: {
          publicKey: {
            challenge,
            rp: { id: rpId, name: "Agent Hub" },
            user: { id: Buffer.from("agent-hub").toString("base64url"), name: "agent-hub", displayName: "Agent Hub" },
            pubKeyCredParams: [
              { type: "public-key", alg: -7 },
              { type: "public-key", alg: -257 },
            ],
            authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
            attestation: "none",
            timeout: 60_000,
          },
        },
      });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/app-lock/webauthn/register/finish：登记公钥（clientData 绑定挑战 + rpId）
  app.post("/api/app-lock/webauthn/register/finish", async (req, reply) => {
    try {
      requireUnlocked(req);
      const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
      const challengeId = typeof body.challengeId === "string" ? body.challengeId : "";
      const challenge = appLock.consumeChallenge(challengeId, "create");
      if (!challenge) {
        throw new HubError(ErrorCodes.APP_LOCK_DENIED, "挑战不存在或已过期，请重试", 401);
      }
      const cred = (typeof body.credential === "object" && body.credential !== null ? body.credential : {}) as Record<string, unknown>;
      appLock.registerWebAuthn({
        credentialId: typeof cred.id === "string" ? cred.id : "",
        publicKey: typeof cred.publicKey === "string" ? cred.publicKey : "",
        clientDataJSON: typeof cred.clientDataJSON === "string" ? cred.clientDataJSON : "",
        challenge,
        rpId: rpIdOf(req),
      });
      return reply.send({ ok: true, webauthn: true });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/app-lock/webauthn/login/start：生物识别解锁挑战（未启用 → 400）
  app.post("/api/app-lock/webauthn/login/start", async (_req, reply) => {
    try {
      const status = appLock.status();
      if (!status.configured || !status.webauthn) {
        throw new HubError(ErrorCodes.APP_LOCK_NOT_CONFIGURED, "未启用生物识别解锁", 400);
      }
      const { challengeId, challenge } = appLock.createChallenge("get");
      return reply.send({
        challengeId,
        options: {
          publicKey: {
            challenge,
            rpId: rpIdOf(_req),
            userVerification: "required",
            timeout: 60_000,
          },
        },
      });
    } catch (err) {
      return handle(reply, err);
    }
  });

  // POST /api/app-lock/webauthn/login/finish：验签通过 → 发解锁令牌（同 PIN 解锁语义）
  app.post("/api/app-lock/webauthn/login/finish", async (req, reply) => {
    try {
      const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
      const challengeId = typeof body.challengeId === "string" ? body.challengeId : "";
      const challenge = appLock.consumeChallenge(challengeId, "get");
      if (!challenge) {
        throw new HubError(ErrorCodes.APP_LOCK_DENIED, "挑战不存在或已过期，请重试", 401);
      }
      const cred = (typeof body.credential === "object" && body.credential !== null ? body.credential : {}) as Record<string, unknown>;
      const issued = appLock.loginWebAuthn({
        credentialId: typeof cred.id === "string" ? cred.id : "",
        clientDataJSON: typeof cred.clientDataJSON === "string" ? cred.clientDataJSON : "",
        authenticatorData: typeof cred.authenticatorData === "string" ? cred.authenticatorData : "",
        signature: typeof cred.signature === "string" ? cred.signature : "",
        challenge,
        rpId: rpIdOf(req),
      });
      return reply.send({ ok: true, token: issued.token, expiresAt: issued.expiresAt });
    } catch (err) {
      return handle(reply, err);
    }
  });
}
