/**
 * 子代理活动聚合（反馈轮 3 #4）：
 * pi-subagents 派生子会话（parentSessionId 指向父会话）的工作状态，
 * 聚合为 GET /api/sessions/:id/agents 快照 + WS `subagent_activity` 增量事件，
 * 让父会话面板像 pi TUI 一样实时看到"子 agent 在干活"。
 *
 * - buildSubAgentActivity：会话元数据 + 消息 → 活动快照（纯函数，测试友好）
 * - activityEventFrom：子会话事件流 → 轻量增量（只推摘要级变化，delta 不推，动画克制）
 * - SubAgentRouter：子会话事件按 parentSessionId 路由到父会话通道（缓存血缘，miss 异步补）
 */
import type {
  MessageDto,
  ServerEvent,
  SessionListItem,
  SessionStatus,
  SubAgentActivityDto,
  SubAgentActivityUpdate,
  SubAgentsResponse,
} from "./types.js";
import type { ParsedClaudeSubAgent } from "./adapters/claude-transcript.js";

export type { SubAgentActivityDto, SubAgentActivityUpdate, SubAgentsResponse };

/** 摘要截断（面板卡片一行展示；完整内容看子代理会话页） */
export const SUMMARY_LIMIT = 160;

export function truncateSummary(text: string | null, limit = SUMMARY_LIMIT): string | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/** 活动是否已结束（status 离开 running；error 也算结束但保留状态展示） */
export function isDone(status: SessionStatus): boolean {
  return status !== "running";
}

/**
 * claude Task 子代理（sidechain 解析产物）→ 面板活动卡。
 * claude 子代理无独立会话文件：sessionId 指向父会话（前端「查看」回跳父会话，结果摘要已内联展示）。
 * 并行 Task 的 sidechain 行归属最近开启的记录（transcript 无显式归属标记，保守启发式）。
 */
export function buildClaudeSubAgentActivity(
  parentSessionId: string,
  subs: ParsedClaudeSubAgent[],
): SubAgentActivityDto[] {
  return subs.map((s) => ({
    sessionId: parentSessionId,
    name: `${s.type}#${s.id === "" ? "unknown" : s.id.slice(-8)}`,
    status: s.done ? (s.error ? "error" : "idle") : "running",
    currentTool: s.currentTool,
    toolRunning: s.toolRunning,
    lastOutput: truncateSummary(s.lastOutput),
    startedAt: s.startedAtMs,
    updatedAt: s.updatedAtMs ?? s.startedAtMs ?? 0,
    done: s.done,
    resultSummary: truncateSummary(s.resultSummary),
  }));
}

/**
 * 快照聚合：从会话元数据 + 全量消息推导活动卡内容。
 * - currentTool/toolRunning：最后一条带工具调用消息里最后一个 running / 最近完成的工具
 * - lastOutput/resultSummary：最后一条非空 assistant 文本（完成即结果摘要）
 * - startedAt：首条消息时间（无消息为 null）
 */
export function buildSubAgentActivity(session: SessionListItem, messages: MessageDto[]): SubAgentActivityDto {
  const name = session.name ?? session.id;
  let currentTool: string | null = null;
  let toolRunning = false;
  let lastOutput: string | null = truncateSummary(session.lastAssistantMessage);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (currentTool === null && m.toolCalls.length > 0) {
      const running = m.toolCalls.find((t) => t.status === "running" || t.status === "pending");
      const pick = running ?? m.toolCalls[m.toolCalls.length - 1];
      currentTool = truncateSummary(pick.summary !== "" ? pick.summary : pick.name);
      toolRunning = running !== undefined;
    }
    if (lastOutput === null && m.role === "assistant") {
      lastOutput = truncateSummary(m.text);
    }
    if (currentTool !== null && lastOutput !== null) break;
  }
  const startedAt = messages.length > 0 ? messages[0].timestamp : null;
  const done = isDone(session.status);
  return {
    sessionId: session.id,
    name,
    status: session.status,
    currentTool,
    toolRunning,
    lastOutput,
    startedAt,
    updatedAt: Date.parse(session.updatedAt) || Date.now(),
    done,
    resultSummary: done ? lastOutput : null,
  };
}

/**
 * 子会话事件 → 父会话通道的活动增量：
 * tool_start/tool_end 带工具摘要；message_end（仅 assistant 非空）带最新输出；
 * status/agent_settled 收尾置 done。text/thinking delta 不推（摘要级更新，动画克制）。
 */
export function activityEventFrom(sessionId: string, event: ServerEvent): SubAgentActivityUpdate | null {
  const now = Date.now();
  switch (event.type) {
    case "tool_start":
      return {
        sessionId,
        currentTool: truncateSummary(event.toolCall.summary !== "" ? event.toolCall.summary : event.toolCall.name),
        toolRunning: true,
        updatedAt: now,
      };
    case "tool_end":
      return {
        sessionId,
        currentTool: truncateSummary(event.toolCall.summary !== "" ? event.toolCall.summary : event.toolCall.name),
        toolRunning: false,
        updatedAt: now,
      };
    case "message_end": {
      if (event.message.role !== "assistant") return null;
      const text = truncateSummary(event.message.text);
      // tail 路径无 tool_start/tool_end：从消息 toolCalls 回填"当前工具"（卡片不滞后）
      const toolCalls = event.message.toolCalls ?? [];
      const lastTool = toolCalls.length > 0 ? toolCalls[toolCalls.length - 1] : undefined;
      const toolPart = lastTool
        ? { currentTool: truncateSummary(lastTool.summary !== "" && lastTool.summary !== null ? lastTool.summary : lastTool.name), toolRunning: false }
        : {};
      if (text === null && lastTool === undefined) return null;
      return {
        sessionId,
        ...(text !== null ? { lastOutput: text } : {}),
        ...toolPart,
        updatedAt: event.message.timestamp || now,
      };
    }
    case "status":
      return { sessionId, status: event.status, done: isDone(event.status), updatedAt: now };
    case "agent_settled":
      return { sessionId, status: "idle", done: true, updatedAt: now };
    default:
      return null;
  }
}

/** WS 路由结果：要把活动增量广播到父会话通道 */
export interface RoutedSubAgentEvent {
  parentSessionId: string;
  event: ServerEvent;
}

type SessionLookup = (id: string) => Promise<SessionListItem | null>;

/** 首波事件缓存队列（含全文事件，有界 + TTL，不永久驻留） */
interface PendingQueue {
  /** 队列创建时间（TTL 起点） */
  queuedAt: number;
  items: Array<{ sessionId: string; event: ServerEvent }>;
}

/**
 * 子会话事件 → 父会话通道路由器：
 * 血缘（sessionId → parentSessionId）缓存解析；miss 时异步补缓存（当次事件跳过，
 * 下一条事件即生效——活动面板是"最新状态"语义，丢一帧无害）。
 * 只为 isSubAgent 的子代理路由（fork 分支虽带 parentSessionId 但不是"子代理在干活"）。
 */
export class SubAgentRouter {
  private readonly parents = new Map<string, string>();
  private readonly names = new Map<string, string>();
  /** 解析失败负缓存：到点前的事件不重试 lookup（避免每事件触发全量扫描） */
  private readonly retryAfter = new Map<string, number>();
  static readonly RETRY_AFTER_MS = 30_000;
  /** 追踪会话数上限（OOM 审计 AC4）：parents/names/retryAfter/pending 均有上界，插入序 LRU 淘汰 */
  static readonly MAX_TRACKED = 1024;
  /** 首波缓存 TTL：血缘解析长期失败时到期丢弃（明确语义：不永久驻留）；正常路径 <1s 即 flush，首条输出不丢 */
  static readonly PENDING_TTL_MS = 5 * 60_000;
  /** 清扫节流：route 热路径上最多每 60s 全量清一次 */
  static readonly SWEEP_INTERVAL_MS = 60_000;
  private readonly resolving = new Set<string>();
  private lastSweepAt = 0;
  private readonly lookup: SessionLookup;

  /** 血缘未解析期间的首波事件缓存（resolve 后 flush，≤8 条/会话） */
  private readonly pending = new Map<string, PendingQueue>();

  constructor(
    lookup: SessionLookup,
    /** flush 出口：resolve 后补投首波事件（与 route() 同一广播通道） */
    private readonly onDrain?: (routed: RoutedSubAgentEvent) => void,
  ) {
    this.lookup = lookup;
  }

  /** 外部预热血缘（如会话扫描后），减少首帧 miss */
  remember(sessionId: string, parentSessionId: string, name?: string): void {
    SubAgentRouter.setBounded(this.parents, sessionId, parentSessionId);
    if (name !== undefined) SubAgentRouter.setBounded(this.names, sessionId, name);
  }

  /** 有界 Map 写入（插入序 LRU）：淘汰最旧条目，防无上界增长 */
  private static setBounded<V>(map: Map<string, V>, key: string, value: V): void {
    if (map.has(key)) map.delete(key); // 刷新插入序（近用后出）
    map.set(key, value);
    if (map.size > SubAgentRouter.MAX_TRACKED) {
      const oldest = map.keys().next();
      if (!oldest.done) map.delete(oldest.value);
    }
  }

  /**
   * 周期清扫（OOM 审计 AC4）：
   * - pending 超 TTL 丢弃（明确语义：血缘长期解析失败时首波缓存不永久驻留；成功路径仍 flush，首条输出不丢）
   * - retryAfter 到期条目清理（删除 ≡ 已过期，下次事件可重试）
   */
  sweep(now = Date.now()): void {
    this.lastSweepAt = now;
    for (const [sessionId, queue] of [...this.pending]) {
      if (now - queue.queuedAt > SubAgentRouter.PENDING_TTL_MS) this.pending.delete(sessionId);
    }
    for (const [sessionId, at] of [...this.retryAfter]) {
      if (now >= at) this.retryAfter.delete(sessionId);
    }
  }

  route(sessionId: string, event: ServerEvent): RoutedSubAgentEvent | null {
    const nowMs = Date.now();
    if (nowMs - this.lastSweepAt > SubAgentRouter.SWEEP_INTERVAL_MS) this.sweep(nowMs);
    const parentId = this.parents.get(sessionId);
    if (parentId === undefined) {
      // 首波事件缓存（血缘解析是异步全量扫描，直接丢会漏掉第一条输出/完成态）
      let queue = this.pending.get(sessionId);
      if (queue === undefined) {
        queue = { queuedAt: nowMs, items: [] };
        SubAgentRouter.setBounded(this.pending, sessionId, queue);
      }
      if (queue.items.length < 8) queue.items.push({ sessionId, event });
      if ((this.retryAfter.get(sessionId) ?? 0) <= nowMs) this.resolveAsync(sessionId);
      return null;
    }
    // 空串哨兵 = 已解析为非子代理（无父），不再路由
    if (parentId === "") return null;
    const update = activityEventFrom(sessionId, event);
    if (update === null) return null;
    // 增量自带子代理名：快照未命中（冷启动 SWR 空窗）时增量仍能正确显示卡片
    const name = this.names.get(sessionId);
    const activity: SubAgentActivityUpdate = name !== undefined ? { ...update, name } : update;
    return {
      parentSessionId: parentId,
      event: { type: "subagent_activity", sessionId, parentSessionId: parentId, activity },
    };
  }

  private resolveAsync(sessionId: string): void {
    if (this.resolving.has(sessionId) || this.parents.has(sessionId)) return;
    if (this.resolving.size >= SubAgentRouter.MAX_TRACKED) return; // 解析风暴保护：在途 lookup 也有上界
    this.resolving.add(sessionId);
    void this.lookup(sessionId)
      .then((session) => {
        const parentId = session?.parentSessionId;
        if (session?.isSubAgent === true && typeof parentId === "string" && parentId !== "") {
          SubAgentRouter.setBounded(this.parents, sessionId, parentId);
          const name = session.name ?? session.id;
          SubAgentRouter.setBounded(this.names, sessionId, name);
          // 补投首波缓存（此刻血缘已知，重新走 route 产出正确路由；首条输出不丢）
          const queue = this.pending.get(sessionId);
          this.pending.delete(sessionId);
          if (queue && this.onDrain) {
            for (const item of queue.items) {
              const routed = this.route(item.sessionId, item.event);
              if (routed) this.onDrain(routed);
            }
          }
        } else {
          // 非子代理会话记为“无父”（空串哨兵），避免反复解析；缓存作废
          SubAgentRouter.setBounded(this.parents, sessionId, "");
          this.pending.delete(sessionId);
        }
      })
      .catch(() => {
        // 解析失败（扫描异常）：负缓存限速重试；pending 保留至 PENDING_TTL（到期 sweep 丢弃，不永久驻留），
        // retryAfter 到期后下一条事件触发重试，成功即按序 flush（首波语义不变）
        SubAgentRouter.setBounded(this.retryAfter, sessionId, Date.now() + SubAgentRouter.RETRY_AFTER_MS);
      })
      .finally(() => {
        this.resolving.delete(sessionId);
      });
  }
}
