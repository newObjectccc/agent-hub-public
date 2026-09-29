/**
 * POST /api/live/:sessionId：pi 扩展 live-feed 事件接入（docs/API_CONTRACT.md §6）。
 *
 * - normalizeLiveEvents（纯函数）：原始事件数组 → 契约 WS 事件（非法/未知项静默丢弃，绝不 500）
 * - coalesceDeltas（纯函数）：相邻同 messageId 的 text/thinking delta 合并，减少广播帧数
 * - LiveIngest：delta 节流窗口（默认 100ms）+ onLive 回调（会话转 live，停文件 tail 防双推送）
 */
import type { MessageDto, MessageRole, ServerEvent, ToolCallDto, ToolCallStatus } from "./types.js";

export const LIVE_EVENT_TYPES = new Set([
  "message_start",
  "text_delta",
  "thinking_delta",
  "tool_start",
  "tool_end",
  "message_end",
  "agent_settled",
  "status",
]);

const MESSAGE_ROLES = new Set<MessageRole>(["user", "assistant", "toolResult", "custom"]);
const TOOL_STATUSES = new Set<ToolCallStatus>(["pending", "running", "done", "error"]);
const SESSION_STATUSES = new Set(["idle", "running", "error"]);

export interface LiveIngestLike {
  /** 接收一批扩展事件，返回接受条数（非法项丢弃） */
  ingest(sessionId: string, raw: unknown): { accepted: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toEventList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw)) {
    if (Array.isArray(raw.events)) return raw.events;
    if (typeof raw.type === "string") return [raw];
  }
  return [];
}

function normalizeToolCall(raw: unknown): { name: string; summary: string; status: ToolCallStatus; resultPreview: string | null } | null {
  if (!isRecord(raw)) return null;
  const name = asString(raw.name);
  if (name === null || name === "") return null;
  const statusRaw = asString(raw.status);
  return {
    name,
    summary: asString(raw.summary) ?? "",
    status: statusRaw !== null && TOOL_STATUSES.has(statusRaw as ToolCallStatus) ? (statusRaw as ToolCallStatus) : "done",
    resultPreview: asString(raw.resultPreview),
  };
}

function normalizeMessageDto(raw: unknown, nowMs: number): MessageDto | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  const role = asString(raw.role);
  if (id === null || id === "" || role === null || !MESSAGE_ROLES.has(role as MessageRole)) return null;
  const toolCallsRaw = Array.isArray(raw.toolCalls) ? raw.toolCalls : [];
  const toolCalls: ToolCallDto[] = [];
  for (const item of toolCallsRaw) {
    const toolCall = normalizeToolCall(item);
    if (toolCall) toolCalls.push(toolCall);
  }
  return {
    id,
    role: role as MessageRole,
    timestamp: asNumber(raw.timestamp) ?? nowMs,
    text: asString(raw.text) ?? "",
    thinking: asString(raw.thinking),
    toolCalls,
  };
}

/**
 * 原始请求体 → 事件数组：支持 `[...]`、`{events:[...]}`、单事件 `{type:...}` 三种形态；
 * 未知 type、缺关键字段、类型不符的条目静默丢弃（live 接入是 fire-and-forget，不能因坏数据失败）。
 */
export function normalizeLiveEvents(raw: unknown, nowMs = Date.now()): ServerEvent[] {
  const list = toEventList(raw);
  const out: ServerEvent[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const type = asString(item.type);
    if (type === null || !LIVE_EVENT_TYPES.has(type)) continue;

    switch (type) {
      case "message_start": {
        const message = normalizeMessageDto(item.message, nowMs);
        if (!message) continue;
        out.push({ type: "message_start", message: { id: message.id, role: message.role, timestamp: message.timestamp } });
        break;
      }
      case "text_delta":
      case "thinking_delta": {
        const messageId = asString(item.messageId);
        const delta = asString(item.delta);
        if (messageId === null || messageId === "" || delta === null || delta === "") continue;
        out.push({ type, messageId, delta });
        break;
      }
      case "tool_start": {
        const messageId = asString(item.messageId);
        const toolCall = normalizeToolCall(item.toolCall);
        if (messageId === null || messageId === "" || !toolCall) continue;
        out.push({ type: "tool_start", messageId, toolCall: { name: toolCall.name, summary: toolCall.summary } });
        break;
      }
      case "tool_end": {
        const messageId = asString(item.messageId);
        const toolCall = normalizeToolCall(item.toolCall);
        if (messageId === null || messageId === "" || !toolCall) continue;
        out.push({
          type: "tool_end",
          messageId,
          toolCall: {
            name: toolCall.name,
            summary: toolCall.summary,
            status: toolCall.status,
            resultPreview: toolCall.resultPreview,
          },
        });
        break;
      }
      case "message_end": {
        const message = normalizeMessageDto(item.message, nowMs);
        if (!message) continue;
        out.push({ type: "message_end", message });
        break;
      }
      case "agent_settled": {
        out.push({ type: "agent_settled" });
        break;
      }
      case "status": {
        const status = asString(item.status);
        if (status === null || !SESSION_STATUSES.has(status)) continue;
        out.push({ type: "status", status: status as "idle" | "running" | "error" });
        break;
      }
      default:
        continue;
    }
  }
  return out;
}

/** delta 事件（可合并） */
type DeltaEvent = { type: "text_delta" | "thinking_delta"; messageId: string; delta: string };

function isDeltaEvent(event: ServerEvent): event is ServerEvent & DeltaEvent {
  return event.type === "text_delta" || event.type === "thinking_delta";
}

/** 合并相邻同 (type, messageId) 的 delta 事件，减少广播帧数 */
export function coalesceDeltas(events: ServerEvent[]): ServerEvent[] {
  const out: ServerEvent[] = [];
  for (const event of events) {
    const last = out[out.length - 1];
    if (
      last &&
      isDeltaEvent(event) &&
      isDeltaEvent(last) &&
      last.type === event.type &&
      last.messageId === event.messageId
    ) {
      out[out.length - 1] = { type: event.type, messageId: event.messageId, delta: last.delta + event.delta };
      continue;
    }
    out.push(event);
  }
  return out;
}

export interface LiveIngestDeps {
  emit: (sessionId: string, event: ServerEvent) => void;
  /**
   * 会话收到 live 事件（每批调用，可作心跳）。
   * index.ts 接到 hub.markLiveFeed：首个事件触发 hub.onLive 停文件 tail（防双推送）。
   */
  onLive?: (sessionId: string) => void;
  /** 该会话已由本进程 SDK 接管时丢弃 live 事件（SDK 流是权威源，防双推送） */
  isSdkLive?: (sessionId: string) => boolean;
  /** delta 广播节流窗口（毫秒，默认 100） */
  throttleMs?: number;
}

interface PendingBucket {
  events: ServerEvent[];
  timer: ReturnType<typeof setTimeout> | null;
}

/** live 事件接入器：delta 节流合并 + 生命周期事件即时广播（保序） */
export class LiveIngest implements LiveIngestLike {
  private readonly deps: LiveIngestDeps;
  private readonly throttleMs: number;
  private readonly pending = new Map<string, PendingBucket>();
  private closed = false;

  constructor(deps: LiveIngestDeps) {
    this.deps = deps;
    this.throttleMs = deps.throttleMs ?? 100;
  }

  ingest(sessionId: string, raw: unknown): { accepted: number } {
    if (this.closed) return { accepted: 0 };
    if (this.deps.isSdkLive?.(sessionId)) return { accepted: 0 };
    const events = normalizeLiveEvents(raw);
    if (events.length === 0) return { accepted: 0 };
    this.deps.onLive?.(sessionId);

    for (const event of events) {
      if (isDeltaEvent(event)) {
        this.enqueue(sessionId, event);
      } else {
        // 生命周期事件即时冲刷 + 广播，保证 delta 不越过 message_end 等边界
        this.enqueue(sessionId, event);
        this.flushSession(sessionId);
      }
    }
    return { accepted: events.length };
  }

  private enqueue(sessionId: string, event: ServerEvent): void {
    let bucket = this.pending.get(sessionId);
    if (!bucket) {
      bucket = { events: [], timer: null };
      this.pending.set(sessionId, bucket);
    }
    bucket.events.push(event);
    if (bucket.timer === null) {
      bucket.timer = setTimeout(() => {
        bucket.timer = null;
        this.flushSession(sessionId);
      }, this.throttleMs);
      bucket.timer.unref?.();
    }
  }

  /** 冲刷某会话的节流缓冲（测试/关闭前可显式调用） */
  flushSession(sessionId: string): void {
    const bucket = this.pending.get(sessionId);
    if (!bucket) return;
    this.pending.delete(sessionId);
    if (bucket.timer !== null) clearTimeout(bucket.timer);
    for (const event of coalesceDeltas(bucket.events)) {
      this.deps.emit(sessionId, event);
    }
  }

  /** 停止接入并清空节流定时器（进程退出前调用） */
  close(): void {
    this.closed = true;
    for (const [sessionId] of this.pending) this.flushSession(sessionId);
    this.pending.clear();
  }
}
