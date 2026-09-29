/**
 * 首页工作台统计（docs/API_CONTRACT.md §4）与通知服务编排。
 *
 * 数字全部从会话扫描真实推导（无占位）：
 * - working        = 运行中会话数（现有 status 机制）
 * - needAttention  = settled（干完等你输入）/ error（出错）会话数
 * - todayDone      = 今日 agent_settled 次数（从消息时间推 run 边界）
 * - todayMessages  = 今日 user/assistant 消息数
 * - weekCommits    = workspaceRoot 下 git 仓库本周 commit 总数（无 git → 0）
 *
 * 纯推导函数（countSettledRuns / classifyAttention / deriveDashboard / …）
 * 与 IO（会话扫描、git execFile、read 标记文件）分层，便于单测。
 */
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  applyReadMarks,
  loadReadMarks,
  makeNotification,
  mergeNotifications,
  notificationSummary,
  saveReadMarks,
  seedNotificationsFromInsights,
  unreadCountOf,
  type NotificationDraft,
} from "./notifications.js";
import { scanSessionInsights, truncateText, type SessionInsight } from "./sessions/scan.js";
import type {
  AttentionSessionCard,
  DashboardStats,
  HubActivity,
  MessageDto,
  NotificationItem,
  NotificationKind,
  NotificationListResponse,
  ServerEvent,
  SessionStatus,
  WorkingSessionCard,
} from "./types.js";

/** settled/等输入 的会话进入“等你处理”的时间窗（更早的视为已处理） */
export const ATTENTION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_SECTION_CARDS = 20;
/** 会话扫描缓存 TTL：stats 与通知共用一次扫描 */
// 静止期长缓存（轮询命中缓存毫秒级）；文件变更由 presence 主动 invalidate
const INSIGHTS_CACHE_TTL_MS = 30_000;
const WEEK_COMMITS_CACHE_TTL_MS = 60_000;

// ---------- 时间窗（纯函数） ----------

/** 本地时区当天 00:00（毫秒） */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本地时区本周一 00:00（毫秒） */
export function startOfWeek(now: number): number {
  const d = new Date(startOfDay(now));
  const weekday = d.getDay(); // 0=周日
  const daysSinceMonday = (weekday + 6) % 7;
  d.setDate(d.getDate() - daysSinceMonday);
  return d.getTime();
}

/** 前一天的本地 00:00（毫秒；DST 安全，不用固定 24h 步长） */
export function prevDayStart(dayStart: number): number {
  const d = new Date(dayStart);
  d.setDate(d.getDate() - 1);
  return d.getTime();
}

/**
 * 连续活跃天数（streak）：活跃 = 当天有 user/assistant 消息。
 * 以「最近活跃日」为终点向前数连续天数：今日未活跃不渐裂（从昨天起算）。
 * 纯函数：dayStarts 为各活跃日的本地 00:00 毫秒集合。
 */
export function computeStreak(dayStarts: Iterable<number>, now: number): number {
  const days = new Set(dayStarts);
  if (days.size === 0) return 0;
  const today = startOfDay(now);
  let cursor = days.has(today) ? today : prevDayStart(today);
  if (!days.has(cursor)) return 0;
  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = prevDayStart(cursor);
  }
  return streak;
}

// ---------- 今日口径（纯函数） ----------

export interface DayWindow {
  dayStart: number;
  dayEnd: number;
  /** 会话是否仍在运行（最后一段 run 可能尚未 settled） */
  running: boolean;
}

/**
 * 今日 agent_settled 次数（从消息时间推 run 边界）：
 * active branch 里 assistant 消息若为「一轮 run 的最后一条」（后随 user/custom，
 * 或是末条且会话不在运行中），则算一次 settled；只计落在今日窗口内的。
 *
 * 注：steer 插话会把一轮 run 切成多段，v0 按边界近似计数（契约已注明）。
 */
export function countSettledRuns(messages: MessageDto[], window: DayWindow): number {
  let count = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const next = messages[i + 1];
    const isRunEnd = next === undefined ? !window.running : next.role === "user" || next.role === "custom";
    if (!isRunEnd) continue;
    if (m.timestamp >= window.dayStart && m.timestamp < window.dayEnd) count += 1;
  }
  return count;
}

/** 今日消息数（user + assistant） */
export function countTodayMessages(messages: MessageDto[], window: { dayStart: number; dayEnd: number }): number {
  let count = 0;
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (m.timestamp >= window.dayStart && m.timestamp < window.dayEnd) count += 1;
  }
  return count;
}

// ---------- “等你处理”分类（纯函数） ----------

export type AttentionReason = "settled" | "error";

export function classifyAttention(
  insight: SessionInsight,
  options: { now: number; attentionWindowMs?: number },
): AttentionReason | null {
  const { summary, lastMessageRole } = insight;
  const windowMs = options.attentionWindowMs ?? ATTENTION_WINDOW_MS;
  if (summary.status === "error") return "error"; // 出错不设时间窗：必须浮出
  if (summary.status === "running") return null; // 运行中的在“工作中”
  if (lastMessageRole !== "assistant") return null; // 最后是用户消息：等 agent，不等你
  if (options.now - Date.parse(summary.updatedAt) > windowMs) return null;
  return "settled";
}

function workingCard(insight: SessionInsight): WorkingSessionCard {
  const s = insight.summary;
  return {
    id: s.id,
    name: s.name,
    cwd: s.cwd,
    status: s.status,
    startedAt: insight.lastRunStartedAt,
    currentTool: insight.lastToolSummary,
    lastOutput: s.lastAssistantMessage,
    updatedAt: s.updatedAt,
  };
}

function attentionCard(insight: SessionInsight, reason: AttentionReason): AttentionSessionCard {
  const s = insight.summary;
  return {
    id: s.id,
    name: s.name,
    cwd: s.cwd,
    status: s.status,
    reason,
    summary: s.lastAssistantMessage ?? s.lastUserMessage,
    updatedAt: s.updatedAt,
  };
}

// ---------- git 周提交数（IO 可注入） ----------

/** `git rev-list --count` 输出 → 数字（非法输出 0） */
export function parseRevListCount(stdout: string): number {
  const n = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function sumCommitCounts(counts: number[]): number {
  return counts.reduce((a, b) => a + b, 0);
}

export type ExecFileFn = typeof execFile;

export interface WeekCommitsOptions {
  now: number;
  execFileFn?: ExecFileFn;
  timeoutMs?: number;
  /** 递归找 git 仓库的最大深度（workspaceRoot 本身=0） */
  maxDepth?: number;
}

async function isGitDir(dir: string): Promise<boolean> {
  try {
    // .git 可以是目录（普通仓库）或文件（worktree），存在即视为仓库
    await stat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** 收集 workspaceRoot 下的 git 仓库（自身 + 子孙目录，含 worktree） */
export async function findGitRepos(root: string, maxDepth = 2): Promise<string[]> {
  const repos: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    if (await isGitDir(dir)) {
      repos.push(dir);
      return; // 仓库内部不再递归（子模块/嵌套仓库不在口径内）
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        await walk(join(dir, entry.name), depth + 1);
      }
    }
  }
  await walk(root, 0);
  return repos;
}

/** workspaceRoot 下所有 git 仓库本周（周一起）commit 总数；无 git/无仓库 → 0 */
export async function countWeekCommits(root: string, options: WeekCommitsOptions): Promise<number> {
  const execFileFn = options.execFileFn ?? execFile;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const since = new Date(startOfWeek(options.now)).toISOString();
  const repos = await findGitRepos(root, options.maxDepth ?? 2);
  const counts: number[] = [];
  for (const repo of repos) {
    const stdout = await new Promise<string>((resolve) => {
      try {
        execFileFn(
          "git",
          ["-C", repo, "rev-list", "--count", `--since=${since}`, "HEAD"],
          { timeout: timeoutMs, windowsHide: true },
          (error, out) => resolve(error === null ? String(out ?? "") : ""),
        );
      } catch {
        resolve("");
      }
    });
    if (stdout !== "") counts.push(parseRevListCount(stdout));
  }
  return sumCommitCounts(counts);
}

// ---------- 汇总（纯函数） ----------

export interface DeriveDashboardOptions {
  now: number;
  weekCommits: number;
  attentionWindowMs?: number;
  maxCards?: number;
}

/** 洞察列表 → 首页统计（纯函数，数字与分区卡片同源） */
export function deriveDashboard(insights: SessionInsight[], options: DeriveDashboardOptions): DashboardStats {
  const dayStart = startOfDay(options.now);
  const window: { dayStart: number; dayEnd: number; running: boolean } = {
    dayStart,
    dayEnd: options.now + 1,
    running: false,
  };
  const maxCards = options.maxCards ?? MAX_SECTION_CARDS;

  let todayDone = 0;
  let todayMessages = 0;
  let weekMessages = 0;
  let weekDone = 0;
  let working = 0;
  let needAttention = 0;
  const todayDoneSessions: string[] = [];
  const activeDayStarts = new Set<number>();
  const workingSessions: WorkingSessionCard[] = [];
  const attentionSessions: AttentionSessionCard[] = [];
  const weekStart = startOfWeek(options.now);

  for (const insight of insights) {
    const running = insight.summary.status === "running";
    const settledToday = countSettledRuns(insight.messages, { ...window, running });
    todayDone += settledToday;
    if (settledToday > 0) todayDoneSessions.push(insight.summary.id);
    const settledThisWeek = countSettledRuns(insight.messages, {
      dayStart: weekStart,
      dayEnd: options.now + 1,
      running,
    });
    if (settledThisWeek > 0) weekDone += 1;
    todayMessages += countTodayMessages(insight.messages, window);
    weekMessages += countTodayMessages(insight.messages, { dayStart: weekStart, dayEnd: options.now + 1 });
    for (const m of insight.messages) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      if (m.timestamp > 0) activeDayStarts.add(startOfDay(m.timestamp));
    }
    if (running) {
      working += 1;
      if (workingSessions.length < maxCards) workingSessions.push(workingCard(insight));
    }
    const reason = classifyAttention(insight, {
      now: options.now,
      attentionWindowMs: options.attentionWindowMs,
    });
    if (reason !== null) {
      needAttention += 1;
      if (attentionSessions.length < maxCards) attentionSessions.push(attentionCard(insight, reason));
    }
  }

  return {
    working,
    needAttention,
    todayDone,
    todayMessages,
    weekCommits: options.weekCommits,
    streak: computeStreak(activeDayStarts, options.now),
    weekMessages,
    weekDone,
    todayDoneSessions,
    workingSessions,
    attentionSessions,
  };
}

// ---------- 服务编排（IO） ----------

/** 路由层依赖接口（测试可注入 fake） */
export interface DashboardServiceLike {
  getStats(): Promise<DashboardStats>;
  listNotifications(): Promise<NotificationListResponse>;
  markAllRead(): Promise<void>;
  /** 单条/多条已读（ids 缺省=全部已读）；返回剩余未读数 */
  markRead(ids?: string[]): Promise<number>;
}

export interface DashboardServiceOptions {
  sessionDir: string;
  workspaceRoot: string;
  /** read 标记持久化文件（JSON） */
  storeFile: string;
  /** 注入运行态（如 SessionHub.statusFor） */
  statusOf?: (id: string, updatedMs: number) => SessionStatus;
  execFileFn?: ExecFileFn;
  now?: () => number;
  /** 新通知回调（用于 WS 实时推送） */
  onNotification?: (item: NotificationItem) => void;
}

export class DashboardService implements DashboardServiceLike {
  private readonly options: DashboardServiceOptions;
  private cachedInsights: SessionInsight[] | null = null;
  private cachedAt = 0;
  private weekCommits: number | null = null;
  private weekCommitsAt = 0;
  private refreshing = false;
  private readonly liveItems = new Map<string, NotificationItem>();
  private readonly lastAssistantText = new Map<string, string>();
  private readonly lastUserText = new Map<string, string>();
  private readIds = new Set<string>();
  private readMarksLoaded = false;

  constructor(options: DashboardServiceOptions) {
    this.options = options;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /** 会话洞察：stale-while-revalidate——旧数据秒回，过期/失效时后台静默重扫（永不阻塞请求） */
  async getInsights(force = false): Promise<SessionInsight[]> {
    const now = this.now();
    const fresh = this.cachedInsights && now - this.cachedAt < INSIGHTS_CACHE_TTL_MS;
    if (!force && fresh) return this.cachedInsights!;
    if (this.cachedInsights) {
      // 有旧数据：立即返回，后台刷新（不并发重复）
      if (!this.refreshing) void this.refreshInsights();
      return this.cachedInsights;
    }
    // 首次冷扫描（无任何缓存可回）：仅启动/首查一次
    await this.refreshInsights();
    // 冷扫描失败（缓存仍空）回退空列表：通知/概览接口不 500
    return this.cachedInsights ?? [];
  }

  private async refreshInsights(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      this.cachedInsights = await scanSessionInsights(this.options.sessionDir, {
        statusOf: this.options.statusOf,
      });
      this.cachedAt = this.now();
    } catch {
      // 扫描失败保留旧缓存
    } finally {
      this.refreshing = false;
    }
  }

  async getStats(): Promise<DashboardStats> {
    const insights = await this.getInsights();
    const now = this.now();
    if (this.weekCommits === null) {
      this.weekCommits = await countWeekCommits(this.options.workspaceRoot, {
        now,
        execFileFn: this.options.execFileFn,
      });
      this.weekCommitsAt = now;
    } else if (now - this.weekCommitsAt > WEEK_COMMITS_CACHE_TTL_MS) {
      this.weekCommitsAt = now;
      void countWeekCommits(this.options.workspaceRoot, {
        now,
        execFileFn: this.options.execFileFn,
      }).then((v) => {
        this.weekCommits = v;
      }).catch(() => undefined);
    }
    return deriveDashboard(insights, { now, weekCommits: this.weekCommits });
  }

  /** 文件变更（presence）时标记过期：保留旧值秒回，后台刷新（SWR） */
  invalidate(): void {
    this.cachedAt = 0;
    this.weekCommitsAt = 0;
  }

  private async ensureReadMarks(): Promise<Set<string>> {
    if (!this.readMarksLoaded) {
      this.readIds = await loadReadMarks(this.options.storeFile);
      this.readMarksLoaded = true;
    }
    return this.readIds;
  }

  async listNotifications(): Promise<NotificationListResponse> {
    const insights = await this.getInsights();
    const readIds = await this.ensureReadMarks();
    const seeded = seedNotificationsFromInsights(insights);
    // live 条目覆盖同 id 的历史回填（近重复由 mergeNotifications 折叠）
    const merged = mergeNotifications([seeded, [...this.liveItems.values()]]);
    // 补全会话名与子代理标记（live 事件只知道 sessionId）
    const names = new Map<string, string | null>();
    const subAgentIds = new Set<string>();
    for (const insight of insights) {
      names.set(insight.summary.id, insight.summary.name);
      if (insight.summary.isSubAgent) subAgentIds.add(insight.summary.id);
    }
    const named = merged.map((item) => ({
      ...(item.sessionName === null && names.has(item.sessionId)
        ? { ...item, sessionName: names.get(item.sessionId) ?? null }
        : item),
      isSubAgent: item.isSubAgent === true || subAgentIds.has(item.sessionId),
    }));
    const notifications = applyReadMarks(named, readIds);
    return { notifications, unreadCount: unreadCountOf(notifications) };
  }

  async markAllRead(): Promise<void> {
    await this.markRead();
  }

  /** 单条/多条已读（ids 缺省=全部已读）；返回剩余未读数（与前端角标/列表未读同口径） */
  async markRead(ids?: string[]): Promise<number> {
    const readIds = await this.ensureReadMarks();
    if (ids === undefined) {
      const { notifications } = await this.listNotifications();
      for (const item of notifications) readIds.add(item.id);
    } else {
      for (const id of ids) readIds.add(id);
    }
    await saveReadMarks(this.options.storeFile, readIds);
    const { unreadCount } = await this.listNotifications();
    return unreadCount;
  }

  /** 记录一条通知（live 事件 → 内存 + 回调推送） */
  private record(sessionId: string, kind: NotificationKind, text: string): void {
    const draft: NotificationDraft = {
      sessionId,
      kind,
      text,
      timestamp: new Date(this.now()).toISOString(),
    };
    const item = makeNotification(draft);
    this.liveItems.set(item.id, item);
    if (this.liveItems.size > 200) {
      const oldest = this.liveItems.keys().next().value;
      if (oldest !== undefined) this.liveItems.delete(oldest);
    }
    this.options.onNotification?.(item);
  }

  /** WS/会话事件 → 通知（agent_settled / error）+ 最后输出摘要跟踪 */
  recordEvent(sessionId: string, event: ServerEvent): void {
    switch (event.type) {
      case "message_end": {
        if (event.message.text.trim() === "") break;
        if (event.message.role === "assistant") {
          this.lastAssistantText.set(sessionId, event.message.text);
        } else if (event.message.role === "user") {
          // 任务名语义：settled/steering 摘要优先用本轮最后一条 user 消息
          this.lastUserText.set(sessionId, event.message.text);
        }
        break;
      }
      case "agent_settled": {
        this.record(
          sessionId,
          "settled",
          notificationSummary({
            kind: "settled",
            lastUserText: this.lastUserText.get(sessionId),
            lastAssistantText: this.lastAssistantText.get(sessionId),
            fallback: "agent 已完成本轮工作，等你确认",
          }),
        );
        break;
      }
      case "error": {
        this.record(sessionId, "error", event.message);
        break;
      }
      default:
        break;
    }
  }

  /** 会话运行活动（steering=插话/排队；done=手动中止） */
  recordActivity(sessionId: string, activity: HubActivity): void {
    const text =
      activity.kind === "steering"
        ? notificationSummary({ kind: "steering", lastUserText: activity.text, fallback: "收到插话" })
        : activity.text;
    this.record(sessionId, activity.kind, text);
  }
}
