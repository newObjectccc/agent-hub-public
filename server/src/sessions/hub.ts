/**
 * SessionHub：pi SDK 集成核心。
 * - 每个活跃会话一个 AgentSession 实例（内存记录运行态 idle|running|error）
 * - prompt 正忙且 mode 缺省 → SESSION_BUSY（由 prompt-policy 决策）
 * - 事件翻译为 docs/API_CONTRACT.md §6 的 WS 事件
 * - 进程退出时 disposeAll() 回收全部实例
 */
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { ErrorCodes, HubError } from "../errors.js";
import type { HubActivity, MessageDto, MessageRole, PromptImageAttachment, SearchResultDto, ServerEvent, SessionListItem, SessionStatus, SessionTreeDto, ToolCallStatus } from "../types.js";
import { decidePromptAction, parsePromptMode, type PromptMode } from "./prompt-policy.js";
import { SearchService, SEARCH_DEFAULT_LIMIT } from "./search.js";
import { inferExternalStatus } from "./tail.js";
import { loadSessionTree } from "./tree.js";
import {
  assistantToolCalls,
  contentToImages,
  contentToText,
  contentToThinking,
  encodeCwdDirName,
  isSubAgentName,
  RESULT_PREVIEW_LIMIT,
  scanSessions,
  sessionFileName,
  summarizeToolCall,
  truncateText,
  loadSessionMessages,
} from "./scan.js";

export type EmitFn = (sessionId: string, event: ServerEvent) => void;

interface LiveSession {
  session: AgentSession;
  unsubscribe: () => void;
  /** 最近一次活动时间（LRU/TTL 逐出依据） */
  lastUsedMs: number;
  /** 当前流式 assistant 消息的流内 id（message_start 分配） */
  currentMessageId: string | null;
  /** 最近一条 message_start 的消息 id（工具执行发生在 assistant message_end 之后，归属它） */
  lastMessageId: string | null;
  currentMessageStartTs: number | null;
  /** toolCallId → 结果（折叠进 assistant message_end 的 toolCalls） */
  toolResults: Map<string, { isError: boolean; text: string }>;
  seq: number;
  /** 本轮 run 是否已收尾（SDK agent_settled / abort / run 兑底三选一，保证必达且不重复） */
  runSettled: boolean;
}

export interface PromptResult {
  accepted: boolean;
  mode: PromptMode;
  busy?: boolean;
}

function msgRecord(message: unknown): Record<string, unknown> {
  return typeof message === "object" && message !== null ? (message as Record<string, unknown>) : {};
}

/** pi message role → 契约 role（system 等不进 chat） */
export function dtoRole(role: unknown): MessageRole | null {
  switch (role) {
    case "user":
    case "assistant":
    case "toolResult":
    case "custom":
      return role;
    default:
      return null;
  }
}

export interface SessionHubOptions {
  /** 测试注入：缺省用 pi SDK 的 createAgentSession */
  createAgentSession?: typeof createAgentSession;
}

export class SessionHub {
  private readonly sessionDir: string;
  private readonly emit: EmitFn;
  private readonly live = new Map<string, LiveSession>();
  private readonly statuses = new Map<string, { status: SessionStatus; at: number }>();
  /** 会话清单 TTL 缓存（listSessions/findSession 共享一次扫描） */
  private listCache: SessionListItem[] | null = null;
  private listCacheAt = 0;
  private listCacheInflight: Promise<SessionListItem[]> | null = null;
  private readonly searchService: SearchService;
  private readonly createSessionFn: typeof createAgentSession;
  /** 扩展 live-feed 推送过的会话：id → 最后事件时间（10 分钟内视为 live，防文件 tail 双推送） */
  private readonly feedSessions = new Map<string, number>();
  private disposed = false;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** 会话转 live 时回调（用于停掉文件 tail，保持单一推送源，防重复气泡） */
  onLive?: (id: string) => void;
  /** 会话运行活动回调（steering=插话/排队、done=手动中止，供通知聚合） */
  onActivity?: (sessionId: string, activity: HubActivity) => void;

  /** live-feed 活跃窗口：超过此时长无事件则重新允许文件 tail（pi 退出后自愈） */
  static readonly FEED_TTL_MS = 10 * 60_000;
  /** 会话清单缓存 TTL：外部新会话最多晚 5s 可见；写路径 invalidate 立即可见 */
  static readonly LIST_TTL_MS = 5_000;
  /** live map LRU 上限（OOM 审计 AC2）：超出后逐出最久未用的空闲实例，运行中的不动 */
  static readonly LIVE_MAX = 20;
  /** live 空闲 TTL：空闲（isIdle && 已收尾）超过此时长逐出释放，ensureLive 可重建 */
  static readonly LIVE_IDLE_TTL_MS = 10 * 60_000;
  /** statuses 过期 TTL：非 idle 状态超过此时长视为过期条目清扫（idle 条目随时清） */
  static readonly STATE_TTL_MS = 30 * 60_000;

  constructor(sessionDir: string, emit: EmitFn, options: SessionHubOptions = {}) {
    this.sessionDir = sessionDir;
    this.emit = emit;
    this.searchService = new SearchService(sessionDir);
    this.createSessionFn = options.createAgentSession ?? createAgentSession;
  }

  getStatus(id: string): SessionStatus {
    return this.statuses.get(id)?.status ?? "idle";
  }

  /** 刷新 live 实例活动时间（LRU 依据） */
  private touch(live: LiveSession, nowMs = Date.now()): void {
    live.lastUsedMs = nowMs;
  }

  /** 是否有任一 live 推送源（本进程 SDK 或扩展 live-feed，有则无需文件 tail） */
  isLive(id: string, nowMs = Date.now()): boolean {
    if (this.live.has(id)) return true;
    const lastFeed = this.feedSessions.get(id);
    return lastFeed !== undefined && nowMs - lastFeed <= SessionHub.FEED_TTL_MS;
  }

  /** 仅本进程 SDK 持有（此时扩展 live 事件应丢弃，SDK 流是权威源） */
  isSdkLive(id: string): boolean {
    return this.live.has(id);
  }

  /**
   * 扩展 live-feed 事件到达（每批调用，刷新活跃时间）。
   * 首次（或 TTL 过期后重新）标记时触发 onLive 停掉文件 tail，防止双推送。
   */
  markLiveFeed(id: string, nowMs = Date.now()): void {
    const last = this.feedSessions.get(id);
    this.feedSessions.set(id, nowMs);
    if (last === undefined || nowMs - last > SessionHub.FEED_TTL_MS) {
      this.onLive?.(id);
    }
  }

  /** 本进程运行态优先，否则按文件活动推断外部 running */
  private statusWithInference(id: string, updatedMs: number): SessionStatus {
    const own = this.statuses.get(id)?.status;
    if (own && own !== "idle") return own;
    return inferExternalStatus(updatedMs);
  }

  /** 对外暴露的状态推断（dashboard 统计注入运行态用） */
  statusFor(id: string, updatedMs: number): SessionStatus {
    return this.statusWithInference(id, updatedMs);
  }

  private setStatus(id: string, status: SessionStatus): void {
    if (this.getStatus(id) === status) return;
    this.statuses.set(id, { status, at: Date.now() });
    this.emit(id, { type: "status", status });
  }

  /**
   * 周期清扫（OOM 审计 AC2/AC3）：live LRU/TTL 逐出 + feedSessions/statuses 过期清理。
   * 只逐出空闲实例（isIdle && 已收尾），运行中的会话绝不打断（事件流语义不变）。
   */
  sweep(now = Date.now()): void {
    for (const [id, live] of [...this.live]) {
      if (this.isEvictable(live) && now - live.lastUsedMs > SessionHub.LIVE_IDLE_TTL_MS) {
        this.disposeLive(id, live);
      }
    }
    if (this.live.size > SessionHub.LIVE_MAX) {
      // LRU：最久未用的空闲实例先逐出，直到回到上限（全部运行中则容忍暂时超限）
      const idle = [...this.live.entries()]
        .filter(([, live]) => this.isEvictable(live))
        .sort((a, b) => a[1].lastUsedMs - b[1].lastUsedMs);
      for (const [id, live] of idle) {
        if (this.live.size <= SessionHub.LIVE_MAX) break;
        this.disposeLive(id, live);
      }
    }
    for (const [id, at] of [...this.feedSessions]) {
      if (now - at > SessionHub.FEED_TTL_MS) this.feedSessions.delete(id);
    }
    for (const [id, entry] of [...this.statuses]) {
      if (entry.status === "idle" || now - entry.at > SessionHub.STATE_TTL_MS) this.statuses.delete(id);
    }
  }

  /** 启动周期清扫（30s，unref）；测试可直接调 sweep */
  startSweep(intervalMs = 30_000): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref?.();
  }

  /** 可逐出 = 空闲（无进行中 run 且 SDK 空闲）：运行中的实例绝不逐出，避免打断事件流 */
  private isEvictable(live: LiveSession): boolean {
    return live.runSettled && live.session.isIdle === true;
  }

  /** 逐出前安全释放：unsubscribe（事件订阅）+ dispose（SDK 实例）；ensureLive 可重建 */
  private disposeLive(id: string, live: LiveSession): void {
    if (this.live.get(id) !== live) return;
    this.live.delete(id);
    try {
      live.unsubscribe();
    } catch {
      // 忽略
    }
    try {
      live.session.dispose();
    } catch {
      // 忽略
    }
  }

  /** 扫描列表（运行态注入：本进程优先 + 外部活动推断）。
   * TTL 缓存共享 + 并发去重：live 事件风暴下不重复全量解析全部 JSONL（曾致 CPU 打满/OOM） */
  listSessions(): Promise<SessionListItem[]> {
    const now = Date.now();
    if (this.listCache !== null && now - this.listCacheAt < SessionHub.LIST_TTL_MS) {
      return Promise.resolve(this.listCache);
    }
    if (this.listCacheInflight !== null) return this.listCacheInflight;
    this.listCacheInflight = scanSessions(this.sessionDir, {
      statusOf: (id, updatedMs) => this.statusWithInference(id, updatedMs),
    })
      .then((items) => {
        this.listCache = items;
        this.listCacheAt = Date.now();
        return items;
      })
      .finally(() => {
        this.listCacheInflight = null;
      });
    return this.listCacheInflight;
  }

  findSession(id: string): Promise<SessionListItem | null> {
    return this.listSessions().then((all) => {
      const hit = all.find((s) => s.id === id);
      // status 查询时重算（缓存里是扫描时刻值，与原 findSessionById 语义一致）
      return hit ? { ...hit, status: this.statusWithInference(hit.id, Date.parse(hit.updatedAt)) } : null;
    });
  }

  /** 写盘后失效清单缓存（fork/新建会话立即可见，不等 TTL） */
  invalidateList(): void {
    this.listCache = null;
    this.listCacheAt = 0;
  }

  async loadMessages(id: string): Promise<MessageDto[] | null> {
    const found = await this.findSession(id);
    if (!found) return null;
    return loadSessionMessages(found.sessionFile);
  }

  /** 跨会话搜索（active branch 消息文本，内存缓存） */
  search(query: string, limit: number = SEARCH_DEFAULT_LIMIT): Promise<SearchResultDto[]> {
    return this.searchService.search(query, limit);
  }

  /** 会话分支树（JSONL id/parentId 构树） */
  async loadTree(id: string): Promise<SessionTreeDto | null> {
    const found = await this.findSession(id);
    if (!found) return null;
    return loadSessionTree(found.sessionFile);
  }

  /** 会话文件变更（presence 回调）→ 搜索索引失效 */
  invalidateSearch(): void {
    this.searchService.invalidate();
  }

  /**
   * 新建会话：直接落盘 JSONL header（pi 的 SessionManager 在首条 assistant
   * 消息前不写盘，这里显式写文件保证列表立即可见且与 pi CLI 互通）。
   */
  async createSession(cwd: string, name?: string): Promise<SessionListItem> {
    if (typeof cwd !== "string" || cwd.trim() === "") {
      throw new HubError(ErrorCodes.INVALID_CWD, "cwd 必须是非空绝对路径");
    }
    let isDir = false;
    try {
      isDir = (await stat(cwd)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      throw new HubError(ErrorCodes.INVALID_CWD, `cwd 不存在或不是目录: ${cwd}`);
    }

    const sessionId = randomBytes(16).toString("hex");
    const timestamp = new Date().toISOString();
    const dir = join(this.sessionDir, encodeCwdDirName(cwd));
    await mkdir(dir, { recursive: true });
    const file = join(dir, sessionFileName(timestamp, sessionId));

    const lines: string[] = [JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp, cwd })];
    const trimmedName = typeof name === "string" ? name.trim() : "";
    if (trimmedName !== "") {
      lines.push(
        JSON.stringify({
          type: "session_info",
          id: randomBytes(4).toString("hex"),
          parentId: null,
          timestamp,
          name: trimmedName,
        }),
      );
    }
    await writeFile(file, `${lines.join("\n")}\n`, { flag: "wx" });

    return {
      id: sessionId,
      source: "pi",
      name: trimmedName === "" ? null : trimmedName,
      cwd,
      updatedAt: timestamp,
      messageCount: 0,
      status: "idle",
      lastUserMessage: null,
      lastAssistantMessage: null,
      sessionFile: file,
      // 手工创建的会话默认主会话；命名命中 `<type>#<id>` 规则时同样标记子代理
      isSubAgent: isSubAgentName(trimmedName === "" ? null : trimmedName),
      parentSessionId: null,
    };
  }

  /**
   * 复制会话（fork）：用 pi SDK 的 `SessionManager.createBranchedSession`（与 pi
   * `/fork` 命令同一实现）从 **active branch 末尾**（leaf）生成独立新会话文件：
   * - 新 session id / 新 JSONL 文件；header 带 `parentSession` 血缘指向原文件
   * - 消息历史 = 原会话 active branch（root→leaf，id/parentId 重链后完整保留）
   * - 继承 cwd 与 name（session_info entry 在 branch 上，随链复制）
   * - 原会话文件只读，绝不写回；新会话可独立继续对话
   *
   * SDK 对无 assistant 消息的 branch 延迟写盘（首次响应才落盘），这里用
   * `getEntries()` 兜底显式写盘，保证 fork 后立即在列表可见（契约：201 即可用）。
   */
  async forkSession(id: string): Promise<SessionListItem> {
    const found = await this.findSession(id);
    if (!found) {
      throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${id}`, 404);
    }
    const cwd = found.cwd !== "" ? found.cwd : process.cwd();
    const targetDir = join(this.sessionDir, encodeCwdDirName(cwd));
    let manager: SessionManager;
    try {
      manager = SessionManager.open(found.sessionFile, targetDir, cwd);
      const leafId = manager.getLeafId();
      if (leafId === null) {
        // 只有 header 的空会话：复制为新文件（同 forkFrom 语义，立即写盘）
        manager = SessionManager.forkFrom(found.sessionFile, cwd, targetDir);
      } else {
        manager.createBranchedSession(leafId);
        const newFile = manager.getSessionFile();
        if (newFile && !existsSync(newFile)) {
          const entries = manager.getEntries();
          writeFileSync(newFile, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, { flag: "wx" });
        }
      }
      this.invalidateList(); // fork 落盘：新会话立即可见
    } catch (err) {
      throw new HubError(
        ErrorCodes.INTERNAL,
        `会话复制失败: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    const created = await this.findSession(manager.getSessionId());
    if (!created) {
      throw new HubError(ErrorCodes.INTERNAL, "会话复制后未能读回新会话", 500);
    }
    return created;
  }

  /** 取得（或创建）该会话的 AgentSession 实例 */
  async ensureLive(id: string): Promise<AgentSession> {
    const existing = this.live.get(id);
    if (existing) {
      this.touch(existing);
      return existing.session;
    }
    if (this.disposed) {
      throw new HubError(ErrorCodes.INTERNAL, "server 正在关闭", 503);
    }

    const found = await this.findSession(id);
    if (!found) {
      throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${id}`, 404);
    }

    const manager = SessionManager.open(found.sessionFile);
    const { session } = await this.createSessionFn({
      sessionManager: manager,
      cwd: found.cwd !== "" ? found.cwd : undefined,
    });

    const liveSession: LiveSession = {
      session,
      currentMessageId: null,
      lastMessageId: null,
      currentMessageStartTs: null,
      toolResults: new Map(),
      seq: 0,
      runSettled: true,
      lastUsedMs: Date.now(),
      unsubscribe: () => undefined,
    };
    liveSession.unsubscribe = session.subscribe((event) => this.handleSdkEvent(id, liveSession, event));
    this.live.set(id, liveSession);
    // 插入后顺带清扫（惰性触发）：LRU 超限时逐出最久未用的空闲实例，新实例不会被逐出
    this.sweep();
    this.onLive?.(id);
    return session;
  }

  /** 发送消息；决策见 prompt-policy（正忙且 mode 缺省 → busy）；images 为上传图片附件（pi 直接附图，通道 b） */
  async prompt(id: string, text: unknown, modeRaw: unknown, images?: PromptImageAttachment[]): Promise<PromptResult> {
    if (typeof text !== "string" || text.trim() === "") {
      throw new HubError(ErrorCodes.INVALID_REQUEST, "text 必须是非空字符串");
    }
    const mode = parsePromptMode(modeRaw);
    if (mode === null) {
      throw new HubError(ErrorCodes.INVALID_REQUEST, `mode 必须是 prompt|steer|followUp 之一`);
    }

    const session = await this.ensureLive(id);
    const live = this.live.get(id);
    if (live === undefined) {
      throw new HubError(ErrorCodes.INVALID_REQUEST, "会话未初始化");
    }
    this.touch(live);
    const decision = decidePromptAction(!session.isIdle, mode);
    if (decision.kind === "busy") {
      return { accepted: false, mode: mode ?? "prompt", busy: true };
    }

    this.setStatus(id, "running");
    if (decision.kind === "steer" || decision.kind === "followUp") {
      // 插话/排队：通知聚合（kind=steering；摘要由 dashboard 统一清洗/截断）
      this.onActivity?.(id, {
        kind: "steering",
        text: truncateText(text, 80),
      });
    }
    // steer 是并发插话（不独立收尾，由主 run 或 SDK agent_settled 收尾）；
    // prompt/followUp 是一轮独立 run，必须自己兑底收尾（agent_settled 必达）
    const trackRun = decision.kind === "prompt" || decision.kind === "followUp";
    if (trackRun) live.runSettled = false;
    const run = (async () => {
      try {
        // pi 多模态通道 b：PromptOptions.images（message-types.md UserMessage 的 ImageContent 块）
        const piImages =
          images && images.length > 0
            ? images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }))
            : undefined;
        if (decision.kind === "steer") {
          await session.steer(text, piImages);
        } else if (decision.kind === "followUp") {
          await session.followUp(text, piImages);
        } else {
          await session.prompt(text, piImages ? { images: piImages } : undefined);
        }
      } catch (err) {
        // abort / SDK 已收尾：不报 error（不把“手动中止”变成红色错误）
        if (!live.runSettled) {
          live.runSettled = true;
          const message = err instanceof Error ? err.message : String(err);
          this.setStatus(id, "error");
          this.emit(id, { type: "error", code: ErrorCodes.PROMPT_FAILED, message });
        }
      } finally {
        // agent_settled 必达兑底：SDK 正常会发 agent_settled（置 runSettled）；
        // 异常路径（事件丢失/进程异常）由这里恢复 UI，避免“中止按钮残留”
        if (trackRun && !live.runSettled) {
          live.runSettled = true;
          this.emit(id, { type: "agent_settled" });
          this.setStatus(id, "idle");
        }
      }
    })();
    // 不阻塞 HTTP 响应：实际输出走 WS 事件流
    void run;

    return { accepted: true, mode: decision.kind };
  }

  /** 中止当前运行（幂等） */
  async abort(id: string): Promise<void> {
    const live = this.live.get(id);
    if (!live) return;
    this.touch(live);
    // abort 自己已收尾（status idle + done 活动）：抑制 run finally 的 agent_settled 兑底，
    // 避免中止后又冒出一条“干完了”通知
    live.runSettled = true;
    await live.session.abort();
    this.setStatus(id, "idle");
    this.onActivity?.(id, { kind: "done", text: "已手动中止本轮运行" });
  }

  /** 手动压缩上下文（可带自定义保留指令，透传 SDK session.compact()） */
  async compact(id: string, instructions?: string): Promise<void> {
    const session = await this.ensureLive(id);
    await session.compact(instructions === undefined || instructions === "" ? undefined : instructions);
  }

  /** 进程退出：dispose 所有 AgentSession 实例 */
  disposeAll(): void {
    this.disposed = true;
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const live of this.live.values()) {
      try {
        live.unsubscribe();
      } catch {
        // 忽略
      }
      try {
        live.session.dispose();
      } catch {
        // 忽略
      }
    }
    this.live.clear();
  }

  // ---- SDK 事件 → 契约 WS 事件 ----

  private handleSdkEvent(id: string, live: LiveSession, event: AgentSessionEvent): void {
    this.touch(live);
    switch (event.type) {
      case "agent_start": {
        this.setStatus(id, "running");
        break;
      }
      case "message_start": {
        const message = msgRecord(event.message);
        const role = dtoRole(message.role);
        // toolResult/system 的生命周期不单独推送（toolResult 折叠进 assistant）
        if (role === null || role === "toolResult") break;
        live.seq += 1;
        live.currentMessageId = `live-${live.seq}-${Date.now()}`;
        live.lastMessageId = live.currentMessageId;
        live.currentMessageStartTs = typeof message.timestamp === "number" ? message.timestamp : Date.now();
        live.toolResults.clear();
        this.emit(id, {
          type: "message_start",
          message: { id: live.currentMessageId, role, timestamp: live.currentMessageStartTs },
        });
        break;
      }
      case "message_update": {
        const ame = event.assistantMessageEvent as { type: string; delta?: string };
        if (!live.currentMessageId || typeof ame?.delta !== "string") break;
        if (ame.type === "text_delta") {
          this.emit(id, { type: "text_delta", messageId: live.currentMessageId, delta: ame.delta });
        } else if (ame.type === "thinking_delta") {
          this.emit(id, { type: "thinking_delta", messageId: live.currentMessageId, delta: ame.delta });
        }
        break;
      }
      case "tool_execution_start": {
        // 工具执行发生在携带 toolCall 的 assistant message_end 之后：归属最近一条消息
        const messageId = live.currentMessageId ?? live.lastMessageId ?? `live-${live.seq}`;
        this.emit(id, {
          type: "tool_start",
          messageId,
          toolCall: {
            name: event.toolName,
            summary: summarizeToolCall(event.toolName, event.args),
          },
        });
        break;
      }
      case "tool_execution_end": {
        const messageId = live.currentMessageId ?? live.lastMessageId ?? `live-${live.seq}`;
        const result = event.result as { content?: unknown } | undefined;
        const preview = truncateText(contentToText(result?.content), RESULT_PREVIEW_LIMIT);
        live.toolResults.set(event.toolCallId, { isError: event.isError === true, text: preview });
        this.emit(id, {
          type: "tool_end",
          messageId,
          toolCall: {
            name: event.toolName,
            summary: summarizeToolCall(event.toolName, (event as { args?: unknown }).args),
            status: (event.isError === true ? "error" : "done") as ToolCallStatus,
            resultPreview: preview === "" ? null : preview,
          },
        });
        break;
      }
      case "message_end": {
        const message = msgRecord(event.message);
        const role = dtoRole(message.role);
        if (role === null || role === "toolResult") break;
        const liveId = live.currentMessageId ?? `live-${live.seq}`;
        const dto = this.buildMessageDto(live, liveId, role, message);
        // id 保持与 message_start/text_delta 一致（前端按 id upsert 替换流式占位）；
        // 不回填持久化 entry id——那会让前端找不到流式条目而追加出重复气泡。
        // 权威 entry id 只在全量对账（GET /api/sessions/:id）时使用，届时整体替换，无残留。
        this.emit(id, { type: "message_end", message: dto });
        if (role === "assistant") {
          live.currentMessageId = null;
          live.currentMessageStartTs = null;
        }
        break;
      }
      case "agent_settled": {
        live.runSettled = true;
        this.emit(id, { type: "agent_settled" });
        this.setStatus(id, "idle");
        break;
      }
      case "compaction_end": {
        if (event.errorMessage) {
          this.emit(id, { type: "error", code: ErrorCodes.PROMPT_FAILED, message: event.errorMessage });
          this.setStatus(id, "error");
        }
        break;
      }
      default:
        break;
    }
  }

  private buildMessageDto(live: LiveSession, fallbackId: string, role: MessageRole, message: Record<string, unknown>): MessageDto {
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : (live.currentMessageStartTs ?? Date.now());
    const text = contentToText(message.content);
    const thinking = contentToThinking(message.content);
    const images = contentToImages(message.content) ?? undefined;
    if (role !== "assistant") {
      return { id: fallbackId, role, timestamp, text, thinking, toolCalls: [], ...(images ? { images } : {}) };
    }
    const { toolCalls, byCallId } = assistantToolCalls(message);
    for (const [callId, ref] of byCallId) {
      const result = live.toolResults.get(callId);
      if (result) {
        ref.dto.status = result.isError ? "error" : "done";
        ref.dto.resultPreview = result.text === "" ? null : result.text;
      }
    }
    return { id: fallbackId, role, timestamp, text, thinking, toolCalls, ...(images ? { images } : {}) };
  }

  /** 从已持久化 entries 中按消息对象 identity / 时间戳解析 entry id */
  private findEntryId(live: LiveSession, message: Record<string, unknown>): string | null {
    try {
      const entries = live.session.sessionManager.getEntries();
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i] as { type?: string; id?: string; message?: unknown };
        if (entry.type !== "message" && entry.type !== "custom_message") continue;
        if (entry.message === message) return typeof entry.id === "string" ? entry.id : null;
      }
      const ts = message.timestamp;
      if (typeof ts === "number") {
        for (let i = entries.length - 1; i >= 0; i -= 1) {
          const entry = entries[i] as { type?: string; id?: string; message?: { timestamp?: unknown } };
          if (entry.type !== "message") continue;
          if (entry.message?.timestamp === ts) return typeof entry.id === "string" ? entry.id : null;
        }
      }
    } catch {
      // 解析失败退回流内 id
    }
    return null;
  }
}
