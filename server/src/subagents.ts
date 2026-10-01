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
  private readonly resolving = new Set<string>();
  private readonly lookup: SessionLookup;

  /** 血缘未解析期间的首波事件缓存（resolve 后 flush，≤8 条/会话） */
  private readonly pending = new Map<string, Array<{ sessionId: string; event: ServerEvent }>>();

  constructor(
    lookup: SessionLookup,
    /** flush 出口：resolve 后补投首波事件（与 route() 同一广播通道） */
    private readonly onDrain?: (routed: RoutedSubAgentEvent) => void,
  ) {
    this.lookup = lookup;
  }

  /** 外部预热血缘（如会话扫描后），减少首帧 miss */
  remember(sessionId: string, parentSessionId: string, name?: string): void {
    this.parents.set(sessionId, parentSessionId);
    if (name !== undefined) this.names.set(sessionId, name);
  }

  route(sessionId: string, event: ServerEvent): RoutedSubAgentEvent | null {
    const parentId = this.parents.get(sessionId);
    if (parentId === undefined) {
      // 首波事件缓存（血缘解析是异步全量扫描，直接丢会漏掉第一条输出/完成态）
      const q = this.pending.get(sessionId) ?? [];
      if (q.length < 8) q.push({ sessionId, event });
      this.pending.set(sessionId, q);
      if ((this.retryAfter.get(sessionId) ?? 0) <= Date.now()) this.resolveAsync(sessionId);
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
    this.resolving.add(sessionId);
    void this.lookup(sessionId)
      .then((session) => {
        const parentId = session?.parentSessionId;
        if (session?.isSubAgent === true && typeof parentId === "string" && parentId !== "") {
          this.parents.set(sessionId, parentId);
          const name = session.name ?? session.id;
          this.names.set(sessionId, name);
          // 补投首波缓存（此刻血缘已知，重新走 route 产出正确路由）
          const queued = this.pending.get(sessionId);
          this.pending.delete(sessionId);
          if (queued && this.onDrain) {
            for (const item of queued) {
              const routed = this.route(item.sessionId, item.event);
              if (routed) this.onDrain(routed);
            }
          }
        } else {
          // 非子代理会话记为"无父"（空串哨兵），避免反复解析；缓存作废
          this.parents.set(sessionId, "");
          this.pending.delete(sessionId);
        }
      })
      .catch(() => {
        // 解析失败（扫描异常）：负缓存限速重试，不清 pending（事件不丢，到期后补解析）
        this.retryAfter.set(sessionId, Date.now() + SubAgentRouter.RETRY_AFTER_MS);
      })
      .finally(() => {
        this.resolving.delete(sessionId);
      });
  }
}
