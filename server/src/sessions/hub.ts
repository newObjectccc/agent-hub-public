/**
 * SessionHub：pi SDK 集成核心。
 * - 每个活跃会话一个 AgentSession 实例（内存记录运行态 idle|running|error）
 * - prompt 正忙且 mode 缺省 → SESSION_BUSY（由 prompt-policy 决策）
 * - 事件翻译为 docs/API_CONTRACT.md §6 的 WS 事件
 * - 进程退出时 disposeAll() 回收全部实例
 */
import { randomBytes } from "node:crypto";
import { constants, existsSync, writeFileSync } from "node:fs";
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { ErrorCodes, HubError } from "../errors.js";
import { EventThrottle } from "../live.js";
import type { HubActivity, MessageDto, MessageErrorDto, MessageRole, PiModelCatalog, PiModelRef, PromptImageAttachment, SearchResultDto, ServerEvent, SessionListItem, SessionStatus, SessionTreeDto, ToolCallStatus } from "../types.js";
import { modelRef, PiModels, recordedPiModel } from "./models.js";
import { decidePromptAction, parsePromptMode, type PromptMode } from "./prompt-policy.js";
import { SearchService, SEARCH_DEFAULT_LIMIT } from "./search.js";
import { inferExternalStatus, registerTailStatusSink } from "./tail.js";
import { loadSessionTree } from "./tree.js";
import {
  assistantToolCalls,
  contentToImages,
  contentToText,
  contentToThinking,
  encodeCwdDirName,
  extractMessageError,
  isSubAgentName,
  RESULT_PREVIEW_LIMIT,
  scanSessions,
  sessionFileName,
  summarizeToolCall,
  truncateText,
  loadSessionMessages,
  readSessionFile,
  parseSessionJsonl,
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
  /**
   * 本轮 run 遇到的模型错误（stopReason==="error"）：SDK 不抛异常，只把错误放在
   * assistant 消息上，agent_settled 时据此把状态置 error 并补发一条 error 事件
   * （否则前端会把失败的一轮当正常结束，只剩一个「（无内容）」气泡）。
   */
  runError: MessageErrorDto | null;
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
  /**
   * 终端 pi 是否在线持有该会话（index.ts 注入 AgentCommandHub.isOnline，即 pi-command 扩展心跳）。
   * 平行发送的外部活跃闸门用：终端进程活着就意味着它持有自己的 leafId，server 内 SDK 实例
   * 同时 append 会让 JSONL 分叉（详见 errors.ts 的 EXTERNAL_ACTIVE 注释）。
   */
  externalActive?: (id: string) => boolean;
  /** 出站 delta 节流窗口（毫秒，缺省 100）；测试注入小值免等定时器 */
  throttleMs?: number;
  models?: PiModels;
}

/**
 * 外部活跃判定窗口（live-feed 信号）：与 tail 的 mtime 静默窗同口径 60s——
 * 覆盖工具间思考的写盘间隙，又不至于在终端早已退出后长期锁死手机发送。
 */
export const EXTERNAL_FEED_WINDOW_MS = 60_000;

/**
 * 「本进程实例最后活动 → 文件写入」的容差：SDK 事件与写盘的先后顺序不保证，
 * 给 5s 容差避免把自己 run 的尾巴误判成外部写入。外部单次写入若 <5s 完成会被放过，
 * 但 60s 静默窗本来就是启发式，这个取舍与之一致。
 */
export const OWN_WRITE_SLACK_MS = 5_000;

/**
 * 把 SDK/FS 的裸错误翻译成用户可行动的中文。
 *
 * 为何必需：`SessionManager.open` 招 "Session file is not a valid pi session"、
 * cwd 被删招 ENOENT/chdir、SDK 初始化失败招裸 Error——这些此前一路冒到
 * `toErrorEnvelope` 变成英文 `internal error`（5xx 一律隐藏真实 message），
 * 手机端只闪 6s 就消失、零出路。这里统一转成 4xx 中文，并**保留原始错误尾巴**
 * （用户提 issue 需要真实原因，不能只剩“失败了”）。
 */
export function describeSessionOpenError(
  err: unknown,
  found: { sessionFile: string; cwd: string },
): string {
  const raw = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "ENOENT" || /ENOENT/.test(raw)) {
    // 两种可能：会话文件被删，或 cwd 已不存在（SDK 建实例时 chdir 失败）
    if (/chdir|cwd/i.test(raw)) {
      return `工作目录已不存在或无法进入：${found.cwd || "(未记录)"}——目录被删除/改名后无法继续这个会话（原始错误：${raw}）`;
    }
    return `会话文件已不存在（可能已被清理）：${found.sessionFile}（原始错误：${raw}）`;
  }
  if (code === "EACCES" || /EACCES|permission denied/i.test(raw)) {
    return `没有权限读取会话文件：${found.sessionFile}（原始错误：${raw}）`;
  }
  if (/not a valid .*session|invalid session|unexpected token|JSON/i.test(raw)) {
    return `会话文件已损坏或不是有效的 pi 会话格式，无法继续：${found.sessionFile}（原始错误：${raw}）`;
  }
  return `无法唤醒这个会话（原始错误：${raw}）`;
}

export class SessionHub {
  private readonly sessionDir: string;
  private readonly emit: EmitFn;
  /** 出站事件节流合并器（与 attach 路径 LiveIngest 共用 EventThrottle 实现） */
  private readonly throttle: EventThrottle;
  private readonly live = new Map<string, LiveSession>();
  private readonly statuses = new Map<string, { status: SessionStatus; at: number; source?: "own" | "tail" }>();
  /** 会话清单 TTL 缓存（listSessions/findSession 共享一次扫描） */
  private listCache: SessionListItem[] | null = null;
  private listCacheAt = 0;
  private listCacheInflight: Promise<SessionListItem[]> | null = null;
  private readonly searchService: SearchService;
  private readonly createSessionFn: typeof createAgentSession;
  private readonly models: PiModels;
  private readonly modelChanges = new Set<string>();
  /** 终端 pi 在线探测（构造注入；缺省恒不在线 = 只靠 feed/mtime 两路信号） */
  private readonly externalActive: ((id: string) => boolean) | null;
  /** ensureLive 并发去重：per-id inflight（参照 listCacheInflight，防并发 prompt 双开 AgentSession） */
  private readonly ensureLiveInflight = new Map<string, Promise<AgentSession>>();
  /** 扩展 live-feed 推送过的会话：id → 最后事件时间（10 分钟内视为 live，防文件 tail 双推送） */
  private readonly feedSessions = new Map<string, number>();
  /**
   * 本进程造成的会话文件写入时刻（id → 写后 mtime）：外部活跃闸门据此识别「这次写盘
   * 是自己干的」。必需：`SessionManager.open` 在版本不一致时会走 migrateToCurrentVersion
   * → `_rewriteFile()`（openSync(f,"w") 截断重写），把 mtime 刷成 now；不记下来就会把
   * 自己建实例的写入当成「终端正在跑」，下一条消息被自锁 60s（实测踩到）。
   */
  private readonly ownWrites = new Map<string, number>();
  /**
   * 已受理但尚未收尾的 run（id 集）：ensureLive 挪到 run 内部后，prompt 返回时实例可能还没建成，
   * 此时用户点「停止」会撞上 `live.get(id) === undefined`——靠这个集合识别“确实有一轮在飞”。
   */
  private readonly pendingRuns = new Set<string>();
  /** 实例建成前收到的中止请求：run 拿到实例后立即跳过执行（绝不让停止变空操作） */
  private readonly abortRequested = new Set<string>();
  private disposed = false;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** tail 状态回写注销（disposeAll 时解除） */
  private readonly unregisterTailStatus: () => void;
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
  /** live.toolResults 上限（P2-6）：单 run 数千工具调用 × preview 文本防无上界驻留，保留最近 N 条 */
  static readonly TOOL_RESULTS_MAX = 200;

  constructor(sessionDir: string, emit: EmitFn, options: SessionHubOptions = {}) {
    this.sessionDir = sessionDir;
    // 所有出站事件统一经节流合并器：token 级 delta 在 100ms 窗口内合并成一帧，
    // 生命周期事件（message_end/status/agent_settled…）即时冲刷保序。
    // 与 attach 路径的 LiveIngest 共用同一实现（防两套节流口径漂移）。
    // 此前 parallel 路径每个 SDK chunk 直接 emit、一帧不合并，而 parallel 恰恰是
    // 「手机继续不活跃会话」走的路：弱网下帧数放大数十倍，慢客户端发送缓冲无上界。
    this.throttle = new EventThrottle((sid, event) => emit(sid, event), options.throttleMs);
    this.emit = (id, event) => this.throttle.push(id, event);
    this.searchService = new SearchService(sessionDir);
    this.createSessionFn = options.createAgentSession ?? createAgentSession;
    this.models = options.models ?? new PiModels();
    this.externalActive = options.externalActive ?? null;
    // tail 的 status 事件只走 WS 广播，不回写 statuses 会让 API 返回陈旧状态（双状态源分叉）：
    // 这里回写内存状态源，getStatus/findSession 与 WS 显示同源
    this.unregisterTailStatus = registerTailStatusSink((id, status) => {
      // source="tail"：这是文件活动的**启发式推断**（供列表/详情展示），不是权威运行态。
      // 两个约束：① 外部活跃闸门只信 source==="own"——否则 tail 对「只有 user 消息、尚无
      // assistant 回复」的文件启发式置 idle 并回写后，闸门会把 idle 当成本进程登记而放行
      // （浏览器实测：WS 握手启动 tail → 116ms 后同窗口内 409 变 202）；
      // ② 不覆盖本进程权威登记——run 进行中若被 tail 回写盖掉 running，闸门与状态显示都会错乱。
      const current = this.statuses.get(id);
      if (current?.source === "own") return;
      this.statuses.set(id, { status, at: Date.now(), source: "tail" });
    });
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
  /**
   * 本进程状态优先（含显式 idle）：刚创建/刚 settled 的会话文件 mtime 必然新鲜，
   * 丢弃 idle 走时间推断会误判 running 60s（实测 bug：新建会话进 chat 页即显示
   * 「思考中」+ 停止按钮）。无本进程记录（外部 CLI 会话）才按文件活动推断。
   */
  private statusWithInference(id: string, updatedMs: number): SessionStatus {
    const own = this.statuses.get(id)?.status;
    if (own) return own;
    return inferExternalStatus(updatedMs);
  }

  /** 对外暴露的状态推断（dashboard 统计注入运行态用） */
  statusFor(id: string, updatedMs: number): SessionStatus {
    return this.statusWithInference(id, updatedMs);
  }

  private setStatus(id: string, status: SessionStatus): void {
    if (this.getStatus(id) === status) return;
    this.statuses.set(id, { status, at: Date.now(), source: "own" });
    this.emit(id, { type: "status", status });
  }

  /**
   * 周期清扫（OOM 审计 AC2/AC3）：live LRU/TTL 逐出 + feedSessions/statuses 过期清理。
   * 只逐出空闲实例（isIdle && 已收尾），运行中的会话绝不打断（事件流语义不变）。
   */
  sweep(now = Date.now()): void {
    for (const [id, live] of [...this.live]) {
      if (!this.modelChanges.has(id) && this.isEvictable(live) && now - live.lastUsedMs > SessionHub.LIVE_IDLE_TTL_MS) {
        this.disposeLive(id, live);
      }
    }
    if (this.live.size > SessionHub.LIVE_MAX) {
      // LRU：最久未用的空闲实例先逐出，直到回到上限（全部运行中则容忍暂时超限）
      const idle = [...this.live.entries()]
        .filter(([id, live]) => !this.modelChanges.has(id) && this.isEvictable(live))
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
      // idle 条目同样走 STATE_TTL（不再随时清）：秒清会让刚 settled/刚创建的会话
      // 很快又落回时间推断而误判 running，丢失本进程的权威 idle 记录
      if (now - entry.at > SessionHub.STATE_TTL_MS) this.statuses.delete(id);
    }
    for (const [id, at] of [...this.ownWrites]) {
      // 存的是写后 mtime（≈写入时刻）；它只在 60s 静默窗内有意义，随 STATE_TTL 淘汰防无界增长
      // （丢了也只是退回时间推断，而那时 mtime 早已陈旧 → 不会误拦）
      if (now - at > SessionHub.STATE_TTL_MS) this.ownWrites.delete(id);
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
    // 逐出前冲刷节流缓冲：否则尾巴上的 delta 会随实例一起丢掉（前端文字缺最后一截）
    this.throttle.flushSession(id);
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
  async createSession(cwd: string, name?: string, model?: PiModelRef): Promise<SessionListItem> {
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
    if (model) await this.models.resolve(model);

    const sessionId = randomBytes(16).toString("hex");
    const timestamp = new Date().toISOString();
    const dir = join(this.sessionDir, encodeCwdDirName(cwd));
    await mkdir(dir, { recursive: true });
    const file = join(dir, sessionFileName(timestamp, sessionId));

    const lines: string[] = [JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp, cwd })];
    const modelEntryId = model ? randomBytes(4).toString("hex") : null;
    if (model) lines.push(JSON.stringify({ type: "model_change", id: modelEntryId, parentId: null, timestamp, provider: model.provider, modelId: model.id }));
    const trimmedName = typeof name === "string" ? name.trim() : "";
    if (trimmedName !== "") {
      lines.push(
        JSON.stringify({
          type: "session_info",
          id: randomBytes(4).toString("hex"),
          parentId: modelEntryId,
          timestamp,
          name: trimmedName,
        }),
      );
    }
    await writeFile(file, `${lines.join("\n")}\n`, { flag: "wx" });
    // 显式登记 idle：空会话文件 mtime=now，不登记会被时间推断误判 running 60s
    // （实测 bug：新建会话进 chat 页即显示「思考中」+ 停止按钮）
    this.statuses.set(sessionId, { status: "idle", at: Date.now(), source: "own" });
    // 失效清单缓存：新建会话立即可见（否则 TTL 窗口内 findSession 查不到，chat 页加载落空）
    this.invalidateList();

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

  async getModels(cwd: string, id?: string): Promise<PiModelCatalog> {
    const found = id ? await this.findSession(id) : null;
    if (id && !found) throw new HubError(ErrorCodes.SESSION_NOT_FOUND, "会话不存在", 404);
    const live = id ? this.live.get(id)?.session : undefined;
    if (id && live?.isIdle && !this.pendingRuns.has(id) && !this.modelChanges.has(id)) {
      try { await live.modelRuntime?.refresh?.({ allowNetwork: false }); }
      catch { throw new HubError(ErrorCodes.MODEL_UNAVAILABLE, "模型目录刷新失败，请检查本机 pi 配置后重试。", 400); }
    }
    const current = live ? modelRef(live.model) : found ? recordedPiModel(await readSessionFile(found.sessionFile)).model : null;
    return this.models.catalog(found?.cwd || cwd, current, live?.modelRuntime);
  }

  /** Change one idle session only; never rewrite global pi settings or replay a failed prompt. */
  async setModel(id: string, choice: PiModelRef): Promise<PiModelRef> {
    if (this.modelChanges.has(id) || this.pendingRuns.has(id) || this.ensureLiveInflight.has(id) || this.live.get(id)?.session.isIdle === false) {
      throw new HubError(ErrorCodes.SESSION_BUSY, "会话正在运行或切换模型，请结束当前任务后再切换", 409);
    }
    this.modelChanges.add(id);
    try {
      const external = await this.externalBusyReason(id);
      if (external !== null) throw new HubError(ErrorCodes.EXTERNAL_ACTIVE, external, 409);
      const found = await this.findSession(id);
      if (!found) throw new HubError(ErrorCodes.SESSION_NOT_FOUND, "会话不存在", 404);
      const live = this.live.get(id)?.session;
      try { await live?.modelRuntime?.refresh?.({ allowNetwork: false }); }
      catch { throw new HubError(ErrorCodes.MODEL_UNAVAILABLE, "模型目录刷新失败，请检查本机 pi 配置后重试。", 400); }
      const { model } = await this.models.resolve(choice, live?.modelRuntime);
      const externalAfterResolve = await this.externalBusyReason(id);
      if (externalAfterResolve !== null) throw new HubError(ErrorCodes.EXTERNAL_ACTIVE, externalAfterResolve, 409);
      if (live) {
        try { await live.setModel(model, { persist: false }); }
        catch { throw new HubError(ErrorCodes.MODEL_UNAVAILABLE, "模型切换未完成，请刷新并检查本机 pi 的 provider 配置。", 400); }
      } else {
        let content = await readSessionFile(found.sessionFile);
        // Old flat sessions need the SDK's ID/parent migration before appending
        // a tree entry, otherwise the new selection could orphan their history.
        if ((parseSessionJsonl(content).header?.version ?? 1) < 3) {
          try { SessionManager.open(found.sessionFile); }
          catch (err) { throw new HubError(ErrorCodes.SESSION_CORRUPT, describeSessionOpenError(err, found), 409); }
          content = await readSessionFile(found.sessionFile);
        }
        const { leafId } = recordedPiModel(content);
        const line = JSON.stringify({ type: "model_change", id: randomBytes(4).toString("hex"), parentId: leafId,
          timestamp: new Date().toISOString(), provider: choice.provider, modelId: choice.id });
        const file = await open(found.sessionFile, constants.O_WRONLY | constants.O_APPEND);
        try {
          await file.write(`${content.length > 0 && !content.endsWith("\n") ? "\n" : ""}${line}\n`);
        } finally { await file.close(); }
      }
      const after = await stat(found.sessionFile);
      this.ownWrites.set(id, Math.ceil(after.mtimeMs));
      this.setStatus(id, "idle");
      this.invalidateList();
      return { provider: choice.provider, id: choice.id };
    } finally { this.modelChanges.delete(id); }
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
      // 消息 leaf 判定（SDK getLeafId 的坑）：session_info（改名）等 meta 行也是树节点，会被算作叶子——
      // 带 name 的空会话走 createBranchedSession(session_info) 会产出无 session header 的残缺文件 → 读回抛 500。
      // 统一口径（同消息解析的 type 过滤）：只有真实消息（message/custom_message）才是有效 leaf；
      // meta 叶子沿 parentId 回溯到最近的消息（消息后改名的会话同样安全）。
      let leafId = manager.getLeafId();
      while (leafId !== null) {
        const entry = manager.getEntry(leafId);
        if (!entry) break;
        if (entry.type === "message" || entry.type === "custom_message") break;
        leafId = entry.parentId;
      }
      if (leafId === null) {
        // 无消息的空会话（含仅 header + session_info 改名）：复制为新文件（同 forkFrom 语义，立即写盘）
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
    // 显式登记 idle：fork 新文件 mtime=now（历史新鲜时 updatedAt 也新鲜），不登记会被
    // 时间推断误判 running 60s（与 createSession 同根因：fork 后进 chat 页即显示「思考中」）
    this.statuses.set(manager.getSessionId(), { status: "idle", at: Date.now(), source: "own" });
    const created = await this.findSession(manager.getSessionId());
    if (!created) {
      throw new HubError(ErrorCodes.INTERNAL, "会话复制后未能读回新会话", 500);
    }
    return created;
  }

  /**
   * 重命名会话（pi）：SDK `SessionManager.appendSessionInfo` 追加 session_info entry
   * （append-only 与 pi CLI 互通，最新一条为当前名；空名显式清空）。
   *
   * ⚠️ mtime 陷阱（与 createSession/forkSession 同根因）：改名写盘会把文件 mtime 刷成
   * now，不登记会被 inferExternalStatus 的 60s 时间窗误判 running（改名后会话卡片/聊天页
   * 误显示「工作中/思考中」）。这里把**改名瞬间的推断状态快照**显式登记进 statuses
   * （不改变真实状态）：快照为 running 且本进程无记录时不落登记——那是外部活动的
   * 真实推断，登记反而会让外部停止后无法随 mtime 老化自愈回落 idle。
   */
  async renameSession(id: string, name: string): Promise<SessionListItem> {
    const found = await this.findSession(id);
    if (!found) {
      throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${id}`, 404);
    }
    // 快照必须在写盘前取：写盘后 mtime=now 必然推断成 running，快照就失去意义；
    // 且必须用实时 mtime 现算——listCache ≤5s 陈旧会漏掉刚发生的外部写入，
    // 把真实 running 错误快照成 idle 后会压制后续状态自愈（竞态）
    let updatedMs = Date.parse(found.updatedAt);
    try {
      updatedMs = (await stat(found.sessionFile)).mtimeMs;
    } catch {
      // stat 失败回退缓存时间戳（保守推断）
    }
    const hadOwn = this.statuses.has(id);
    const snapshot = this.statusWithInference(id, updatedMs);
    const manager = SessionManager.open(found.sessionFile);
    manager.appendSessionInfo(typeof name === "string" ? name : "");
    if (hadOwn || snapshot !== "running") {
      this.statuses.set(id, { status: snapshot, at: Date.now(), source: "own" });
    }
    // 失效清单缓存：改名立即可见（否则 TTL 窗口内列表/详情还是旧名）
    this.invalidateList();
    const updated = await this.findSession(id);
    if (!updated) {
      throw new HubError(ErrorCodes.INTERNAL, "改名后未能读回会话", 500);
    }
    return updated;
  }

  /** 取得（或创建）该会话的 AgentSession 实例（per-id inflight 互斥：并发调用只创建一个） */
  async ensureLive(id: string): Promise<AgentSession> {
    if (this.modelChanges.has(id)) {
      throw new HubError(ErrorCodes.SESSION_BUSY, "正在切换模型，请完成后再操作", 409);
    }
    const existing = this.live.get(id);
    if (existing) {
      this.touch(existing);
      return existing.session;
    }
    const inflight = this.ensureLiveInflight.get(id);
    if (inflight !== undefined) return inflight;
    const creating = this.createLive(id).finally(() => {
      this.ensureLiveInflight.delete(id);
    });
    this.ensureLiveInflight.set(id, creating);
    return creating;
  }

  /** 实际创建（仅由 ensureLive 的 inflight 单实例路径调用） */
  private async createLive(id: string): Promise<AgentSession> {
    if (this.disposed) {
      throw new HubError(ErrorCodes.INTERNAL, "server 正在关闭", 503);
    }

    const found = await this.findSession(id);
    if (!found) {
      throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${id}`, 404);
    }

    // SDK/FS 的裸错误统一翻译成可行动中文 4xx（HTTP 与 WS 两条路径同时受益）
    let manager: SessionManager;
    try {
      manager = SessionManager.open(found.sessionFile);
    } catch (err) {
      throw new HubError(ErrorCodes.SESSION_CORRUPT, describeSessionOpenError(err, found), 409);
    }
    // open 可能已触发迁移重写（mtime=now）：记下实际 mtime，让闸门认得出这是本进程的写入
    try {
      const afterOpen = await stat(found.sessionFile);
      this.ownWrites.set(id, Math.ceil(afterOpen.mtimeMs));
    } catch {
      // 记不上也不致命：最多退化到时间推断（可能多拦 60s）
    }
    let session: AgentSession;
    try {
      const saved = recordedPiModel(await readSessionFile(found.sessionFile)).model;
      // The SDK restores a saved model only after the first message. Explicitly
      // pin an empty session's choice, rather than silently using global defaults.
      const pinned = saved && manager.buildSessionContext().messages.length === 0
        ? await this.models.resolve(saved) : null;
      const created = await this.createSessionFn({
        sessionManager: manager,
        cwd: found.cwd !== "" ? found.cwd : undefined,
        ...(pinned ? { model: pinned.model, modelRuntime: pinned.runtime as AgentSession["modelRuntime"] } : {}),
      });
      session = created.session;
      const actual = modelRef(session.model);
      if (saved && (!actual || actual.provider !== saved.provider || actual.id !== saved.id)) {
        session.dispose();
        throw new HubError(ErrorCodes.MODEL_UNAVAILABLE, "原会话的模型在 Hub 环境中不可用。请在会话的模型入口选择可用模型；已阻止自动切换到其他 provider。", 400);
      }
    } catch (err) {
      if (err instanceof HubError) throw err;
      throw new HubError(ErrorCodes.SESSION_CORRUPT, describeSessionOpenError(err, found), 409);
    }

    const liveSession: LiveSession = {
      session,
      currentMessageId: null,
      lastMessageId: null,
      currentMessageStartTs: null,
      toolResults: new Map(),
      seq: 0,
      runSettled: true,
      runError: null,
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

  /**
   * 外部（电脑终端）是否正在持有/写这个会话——平行发送的双写闸门。
   *
   * 三路信号（任一命中即视为外部活跃）：
   * a) 终端 pi-command 扩展心跳在线：终端 pi 进程活着就持有自己的 leafId，
   *    即便它此刻空闲，平行 append 也会让 JSONL 出现同 parent 分叉 → 拒绝并引导切接管。
   * b) live-feed 扩展 60s 内推过事件：终端确实在跑，但没装 pi-command 无法接管 → 拒绝并说明等待。
   * c) 会话文件 mtime 在 60s 静默窗内：外部 CLI 在写（未装任何扩展，server 无信号）→ 拒绝。
   *
   * 防自锁（本判定最容易踩的坑，四条缺一不可）：
   * - 本进程实例的**最后活动时刻**不早于文件写入（`mtime <= live.lastUsedMs + 5s`）→ 放行。
   *   不能用 `live.has(id)` 无条件放行：abort 后实例仍驻留（10min 才逐出），那段窗口外部
   *   写盘必须能拦；也不能在 run 进行中拦（SDK 边跑边 append，拦了 steer/followUp 就自锁）。
   * - `statuses` 只信 `source === "own"` 的登记：tail 的启发式 idle 回写若被采信，闸门会在
   *   同窗口内先 409 后 202 且消息真被执行（浏览器实测）。
   * - mtime 与 own 登记比较用 `mtime <= own.at`（登记更晚 = 这次写盘是自己造成的）。
   * - `ownWrites` 记录 open 可能触发的迁移重写时刻，否则新建会话发第一条会被自己拦死。
   *
   * 返回 null = 不忙；否则返回可直接展示给用户的中文原因（给出路，不只说"不行"）。
   */
  async externalBusyReason(id: string, nowMs = Date.now()): Promise<string | null> {
    // a) 终端 pi 在线（可接管）：引导用户切 🖥 接管模式，而不是干等
    if (this.externalActive?.(id) === true) {
      return "电脑终端正持有这个会话（终端 pi 在线）。手机平行发送会与终端双写同一会话文件、导致历史分叉，请切 🖥 接管终端模式发送，或先在电脑上退出该会话。";
    }
    // b) live-feed 近期有事件：终端在跑但无法接管（未装 pi-command）
    const lastFeed = this.feedSessions.get(id);
    if (lastFeed !== undefined && nowMs - lastFeed <= EXTERNAL_FEED_WINDOW_MS) {
      return "电脑终端正在运行这个会话（实时事件仍在推送）。为防止双写已暂停手机发送；终端停下约 1 分钟后自动恢复，或给终端 pi 装上 pi-command 扩展以启用 🖥 接管模式。";
    }
    // c) 仅有写盘痕迹：外部 CLI 在跑（无任何扩展信号）
    const found = await this.findSession(id);
    if (!found) return null;
    try {
      const st = await stat(found.sessionFile);
      // 自写识别①：建实例时 open/迁移重写过的文件，mtime 就是本进程刷的
      const ownWriteAt = this.ownWrites.get(id);
      if (ownWriteAt !== undefined && st.mtimeMs <= ownWriteAt) return null;
      // 自锁防护（精确版）：本进程实例的**最后活动时刻**不早于文件写入 = 这次写盘是自己造成的。
      // 不能用 `live.has(id)` 无条件放行：abort 后实例仍驻留（10min 才逐出）但已空闲，
      // 那时外部终端开始写就必须能拦住（浏览器实测：驻留实例让闸门形同虚设）。
      // 也不能在 run 进行中拦截：SDK 边跑边 append，mtime 一直新鲜，拦了 steer/followUp 就自锁。
      const live = this.live.get(id);
      if (live !== undefined && st.mtimeMs <= live.lastUsedMs + OWN_WRITE_SLACK_MS) return null;
      // 口径对齐 claude 侧 isEffectivelyBusy：不能裸用 inferExternalStatus，也不能无条件 own 优先。
      // - 裸用时间推断：createSession/forkSession/renameSession 写盘会把 mtime 刷成 now，
      //   结果「手机新建会话后发第一条消息」被自己的闸门拦死（实测踩到：hub-settled 4 红）。
      // - 无条件 own 优先（pi 列表展示用的 statusWithInference 口径）：新建时登记的 idle 会永久
      //   压制后来终端 resume 的真实写入 → 闸门失效。
      // 正解：比时间。mtime <= own.at 说明这次写入是本进程造成的（用 own）；
      // mtime > own.at 说明登记之后文件又被写过 = 外部在写（走时间推断）。
      const own = this.statuses.get(id);
      // 只信本进程权威登记（source==="own"）：tail 的启发式回写（source="tail"）不得作为
      // 放行依据——它会对「尚无 assistant 回复」的文件置 idle，正是闸门要防的外部写入场景
      const inferred =
        own !== undefined && own.source === "own" && Math.floor(st.mtimeMs) <= own.at
          ? own.status
          : inferExternalStatus(st.mtimeMs, nowMs);
      if (inferred === "running") {
        return "电脑上似乎仍在运行这个会话（会话文件刚被写入）。为防止双写已暂停手机发送；若已停止，约 1 分钟后可重试。";
      }
    } catch {
      // stat 失败（文件被删/不可读）：不拦，交给后续 findSession/SDK 报准确错误
    }
    return null;
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

    // 外部活跃闸门（防双写）：必须在 ensureLive 之前——白建实例要数百毫秒，
    // 且 createLive 的 onLive 会停掉文件 tail，把终端侧输出推送一起搞丢。
    // 外部正在跑时三种 mode 一律 409（steer/followUp 也无处投递：队列只对 attach 生效），
    // 与 claude 平行路径的口径一致（docs/API_CONTRACT.md §12 冲突保护）。
    const externalReason = await this.externalBusyReason(id);
    if (externalReason !== null) {
      throw new HubError(ErrorCodes.EXTERNAL_ACTIVE, externalReason, 409);
    }

    if (this.modelChanges.has(id)) {
      throw new HubError(ErrorCodes.SESSION_BUSY, "正在切换模型，请完成后再发送", 409);
    }

    // busy 判定**不**为它 await ensureLive：createAgentSession 实测会同步阻塞事件循环
    // ~600ms（24.9MB 会话），卡在 HTTP 响应路径上 = 手机等半秒才收到 202，且期间所有
    // 客户端的 WS/HTTP 一起卡。无 live 实例 ⇒ 必然空闲：sweep 的 isEvictable 只逐出
    // 「已收尾且 isIdle」的实例，运行中的绍不打断，所以实例不在就等于没有正在跑的 run。
    const existing = this.live.get(id);
    const decision = decidePromptAction(existing !== undefined ? !existing.session.isIdle : false, mode);
    if (decision.kind === "busy") {
      return { accepted: false, mode: mode ?? "prompt", busy: true };
    }
    if (existing !== undefined) this.touch(existing);

    this.setStatus(id, "running");
    // 登记「已受理但未收尾」+ 作废旧的中止请求（上一轮残留的 abortRequested 不得误杀本轮）
    this.pendingRuns.add(id);
    this.abortRequested.delete(id);
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
    if (existing !== undefined && trackRun) existing.runSettled = false;
    const run = (async () => {
      // live 要等 ensureLive 之后才有：建实例阶段就失败时它是 undefined，收尾得自己兜
      let live = existing;
      try {
        // 建实例挠到受理之后（202 已返回）：会话历史越大这步越慢，不该让用户干等
        const session = await this.ensureLive(id);
        live = this.live.get(id);
        if (live === undefined) {
          throw new HubError(ErrorCodes.INTERNAL, "会话实例创建后丢失（可能刚被逐出）", 500);
        }
        this.touch(live);
        if (trackRun) live.runSettled = false;
        // 建实例期间用户已点停止：跳过这一轮。否则「停止」是空操作——
        // 实例一建好就照样把整轮跑完（大会话建实例可达数百毫秒，窗口真实存在）。
        if (this.abortRequested.has(id)) {
          this.abortRequested.delete(id);
          // abort 已自行收尾（idle + agent_settled + done），finally 不得再补一次
          live.runSettled = true;
          return;
        }
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
        const message = err instanceof Error ? err.message : String(err);
        // HubError 自带可行动中文与新错误码（SESSION_CORRUPT / CONTEXT_OVERFLOW），原样透出
        const code = err instanceof HubError ? err.code : ErrorCodes.PROMPT_FAILED;
        if (live === undefined) {
          // 建实例就失败（会话文件损坏/被删、cwd 失效）：没有 SDK 事件流，必须自己报
          this.setStatus(id, "error");
          this.emit(id, { type: "error", code, message });
        } else if (!live.runSettled) {
          // abort / SDK 已收尾：不报 error（不把“手动中止”变成红色错误）
          live.runSettled = true;
          this.setStatus(id, "error");
          this.emit(id, { type: "error", code, message });
        }
      } finally {
        this.pendingRuns.delete(id);
        // agent_settled 必达兜底：SDK 正常会发 agent_settled（置 runSettled）；
        // 异常路径（建实例失败/事件丢失/进程异常）由这里恢复 UI，避免“中止按钮残留”/永久转圈
        if (trackRun) {
          if (live === undefined) {
            // 实例从未建成：SDK 的 agent_settled 永不会来。状态保留 catch 里的 error，不覆盖成 idle
            this.emit(id, { type: "agent_settled" });
          } else if (!live.runSettled) {
            live.runSettled = true;
            this.emit(id, { type: "agent_settled" });
            this.setStatus(id, "idle");
          }
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
    if (!live) {
      // 实例还在建（prompt 已受理、ensureLive 在飞）：登记中止请求并立即恢复 UI。
      // 此前这里直接 return——用户点「停止」是空操作，run 建成实例后照样跑完整轮。
      if (this.pendingRuns.has(id)) {
        this.abortRequested.add(id);
        this.setStatus(id, "idle");
        // 没有 SDK 实例就没有人会发 agent_settled，这里自己补（防中止按钮残留）
        this.emit(id, { type: "agent_settled" });
        this.onActivity?.(id, { kind: "done", text: "已手动中止本轮运行" });
      }
      return;
    }
    this.abortRequested.delete(id);
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
    // 与 prompt 同一道双写闸门：compact 会往会话文件追加 compaction entry，
    // 外部终端正在写时同样会分叉（attach 接管期间另由 routes 的 rejectIfAttached 拦）
    const externalReason = await this.externalBusyReason(id);
    if (externalReason !== null) {
      throw new HubError(ErrorCodes.EXTERNAL_ACTIVE, externalReason, 409);
    }
    const session = await this.ensureLive(id);
    await session.compact(instructions === undefined || instructions === "" ? undefined : instructions);
  }

  /** 进程退出：dispose 所有 AgentSession 实例 */
  disposeAll(): void {
    this.disposed = true;
    this.unregisterTailStatus();
    // 进程退出前把节流缓冲里的尾巴 delta 全部冲刷出去
    this.throttle.flushAll();
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
        // 新一轮开始：清掉上一轮错误，避免陈旧错误把本轮 settled 误判成 error
        live.runError = null;
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
        this.rememberToolResult(live, event.toolCallId, { isError: event.isError === true, text: preview });
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
          // 记下本轮错误（aborted 不算：用户主动中止，已有 done 活动与 idle 收尾）
          if (dto.error && dto.error.kind !== "aborted") live.runError = dto.error;
        }
        break;
      }
      case "agent_settled": {
        live.runSettled = true;
        this.emit(id, { type: "agent_settled" });
        // 模型错误收尾：状态置 error + 补发一条 error 事件（前端 notice 常驻，不只靠气泡）
        const runError = live.runError;
        live.runError = null;
        if (runError !== null) {
          this.emit(id, {
            type: "error",
            code: runError.kind === "contextOverflow" ? ErrorCodes.CONTEXT_OVERFLOW : ErrorCodes.PROMPT_FAILED,
            message: runError.message,
          });
          this.setStatus(id, "error");
        } else {
          this.setStatus(id, "idle");
        }
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

  /**
   * 登记工具结果 preview（P2-6 限容）：单 run 数千工具调用时只留最近 TOOL_RESULTS_MAX 条
   * （Map 插入序 FIFO 逐出）；被逐出的老 callId 在 message_end 折叠时降级为无 preview，
   * 不再随 LiveSession 无上界驻留。
   */
  private rememberToolResult(live: LiveSession, callId: string, result: { isError: boolean; text: string }): void {
    live.toolResults.delete(callId);
    live.toolResults.set(callId, result);
    while (live.toolResults.size > SessionHub.TOOL_RESULTS_MAX) {
      const oldest = live.toolResults.keys().next();
      if (oldest.done) break;
      live.toolResults.delete(oldest.value);
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
    // 错误透出（与 scan.ts buildMessages 同口径，否则刷新页面后错误条消失）：
    // SDK 的流式失败/余额耗尽/上下文溢出落在 stopReason+errorMessage 且不抛异常
    const error = extractMessageError(message);
    return {
      id: fallbackId,
      role,
      timestamp,
      text,
      thinking,
      toolCalls,
      ...(images ? { images } : {}),
      ...(error ? { error } : {}),
    };
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
