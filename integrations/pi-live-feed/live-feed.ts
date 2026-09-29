/**
 * live-feed：pi 扩展——把任意终端 pi 会话的实时事件流（思维链/流式回复/工具执行，token 级）
 * 推送给 agent-hub，手机 chat 页实时旁观。
 *
 * 架构：pi 事件 → 批量/节流（100ms 合并 delta）→ POST http://127.0.0.1:7700/api/live/:sessionId
 *      → server 转 WS /ws/sessions/:sessionId 广播 → 手机渲染（契约 docs/API_CONTRACT.md §4/§6）。
 *
 * 硬性要求：
 * - fire-and-forget，绝不阻塞 pi 运行；任何故障静默吞掉，绝不抛错
 * - 环境变量 AGENT_HUB_LIVE_URL 覆盖推送地址（默认 http://127.0.0.1:7700）
 * - 环境变量 AGENT_HUB_LIVE_TOKEN 非空时带 Authorization: Bearer（与 server auth.token 对齐）
 *
 * 安装（单文件自包含，直接拷贝即可）：
 *   cp integrations/pi-live-feed/live-feed.ts ~/.pi/agent/extensions/live-feed.ts
 *
 * 本文件同时导出纯函数（事件→契约 WS 事件映射），供单测直接引用；运行期零第三方依赖。
 */
import type {
  AgentSettledEvent,
  AgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  MessageStartEvent,
  MessageUpdateEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_LIVE_URL = "http://127.0.0.1:7700";
/** delta 合并窗口（毫秒）：窗口内多条 delta 合并为一次 POST 的一个事件 */
export const DELTA_FLUSH_MS = 100;
/** 单次 POST 超时（毫秒）：超时静默放弃，不影响 pi */
export const POST_TIMEOUT_MS = 1500;
export const RESULT_PREVIEW_LIMIT = 500;
export const SUMMARY_LIMIT = 120;

// ---- 契约 WS 事件（docs/API_CONTRACT.md §4，与 server/src/types.ts 的 ServerEvent 对齐） ----

export interface LiveToolCall {
  name: string;
  summary?: string;
  status?: "pending" | "running" | "done" | "error";
  resultPreview?: string | null;
}

export interface LiveMessage {
  id: string;
  role: string;
  timestamp: number;
  text?: string;
  thinking?: string | null;
  toolCalls?: LiveToolCall[];
}

export interface LiveWsEvent {
  type: "message_start" | "text_delta" | "thinking_delta" | "tool_start" | "tool_end" | "message_end" | "agent_settled" | "status";
  message?: LiveMessage;
  messageId?: string;
  delta?: string;
  toolCall?: LiveToolCall;
  status?: "idle" | "running" | "error";
}

/** pi 消息的最小结构（只取用到的字段，便于单测伪造） */
export interface PiMessageLike {
  role?: unknown;
  timestamp?: unknown;
  content?: unknown;
}

/** pi AssistantMessageEvent 的最小结构 */
export interface AssistantMessageEventLike {
  type: string;
  delta?: unknown;
  content?: unknown;
}

// ---- 小工具（与 server/src/sessions/scan.ts 同口径，独立自包含副本） ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function truncateText(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}…`;
}

/** content（string | (TextContent|ImageContent)[]）→ 纯文本 */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: "text"; text: string } => {
        return isRecord(block) && block.type === "text" && typeof block.text === "string";
      })
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

/** content 的 thinking 块 → 思维链全文（无则 null） */
export function contentToThinking(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((block): block is { type: "thinking"; thinking: string } => {
      return isRecord(block) && block.type === "thinking" && typeof block.thinking === "string";
    })
    .map((block) => block.thinking);
  return parts.length > 0 ? parts.join("\n") : null;
}

/** 工具调用摘要：bash→command，读写类→路径，其余紧凑 JSON */
export function summarizeToolCall(name: string, args: unknown): string {
  void name;
  if (isRecord(args)) {
    for (const key of ["command", "path", "filePath", "file_path", "pattern", "url"]) {
      const v = args[key];
      if (typeof v === "string" && v.trim() !== "") return truncateText(v, SUMMARY_LIMIT);
    }
  }
  try {
    return truncateText(JSON.stringify(args ?? {}), SUMMARY_LIMIT);
  } catch {
    return "";
  }
}

// ---- 映射状态（镜像 server/src/sessions/hub.ts 的 LiveSession 流内 id 语义） ----

export interface FeedState {
  seq: number;
  currentMessageId: string | null;
  /** 最近一条推送过 message_start 的消息 id（工具执行发生在 assistant message_end 之后，归属它） */
  lastMessageId: string | null;
  currentMessageStartTs: number | null;
  /** 当前消息的思维链增量累积（message_end 时兜底合并） */
  thinkingText: string;
  /** toolCallId → 摘要（update/end 复用） */
  toolArgs: Map<string, { name: string; summary: string }>;
  /** toolCallId → 结果（折叠进 message_end 的 toolCalls） */
  toolResults: Map<string, { isError: boolean; text: string }>;
}

export function createFeedState(): FeedState {
  return {
    seq: 0,
    currentMessageId: null,
    lastMessageId: null,
    currentMessageStartTs: null,
    thinkingText: "",
    toolArgs: new Map(),
    toolResults: new Map(),
  };
}

function messageIdOf(state: FeedState): string {
  return state.currentMessageId ?? state.lastMessageId ?? `live-${state.seq}`;
}

/** message_start（toolResult/system 不进 chat 流） */
export function mapMessageStart(state: FeedState, message: PiMessageLike, now = Date.now()): LiveWsEvent[] {
  const role = message.role;
  if (role !== "user" && role !== "assistant" && role !== "custom") return [];
  state.seq += 1;
  state.currentMessageId = `live-${state.seq}-${now}`;
  state.lastMessageId = state.currentMessageId;
  state.currentMessageStartTs = typeof message.timestamp === "number" ? message.timestamp : now;
  state.thinkingText = "";
  state.toolResults.clear();
  return [
    {
      type: "message_start",
      message: { id: state.currentMessageId, role: role as string, timestamp: state.currentMessageStartTs },
    },
  ];
}

/** message_update：text_delta / thinking_delta（其余事件类型忽略） */
export function mapMessageUpdate(state: FeedState, event: AssistantMessageEventLike): LiveWsEvent[] {
  if (!state.currentMessageId) return [];
  const delta = event.delta;
  if (typeof delta !== "string" || delta === "") return [];
  if (event.type === "text_delta") {
    return [{ type: "text_delta", messageId: state.currentMessageId, delta }];
  }
  if (event.type === "thinking_delta") {
    state.thinkingText += delta;
    return [{ type: "thinking_delta", messageId: state.currentMessageId, delta }];
  }
  return [];
}

/**
 * tool_execution_start。注意 pi 的真实时序：工具执行发生在携带 toolCall 的 assistant
 * message_end 之后，因此归属 lastMessageId（该 assistant 消息），而非已复位的 currentMessageId。
 */
export function mapToolStart(state: FeedState, toolCallId: string, toolName: string, args: unknown): LiveWsEvent[] {
  const summary = summarizeToolCall(toolName, args);
  state.toolArgs.set(toolCallId, { name: toolName, summary });
  return [{ type: "tool_start", messageId: messageIdOf(state), toolCall: { name: toolName, summary } }];
}

/**
 * tool_execution_update → tool_end 执行中快照（status:"running" + 部分结果预览）。
 * server 原样广播，web 端按 name 合并进工具卡，实现工具执行实时更新。
 */
export function mapToolUpdate(state: FeedState, toolCallId: string, toolName: string, partialResult: unknown): LiveWsEvent[] {
  const summary = state.toolArgs.get(toolCallId)?.summary ?? "";
  const preview = truncateText(contentToText(isRecord(partialResult) ? partialResult.content : undefined), RESULT_PREVIEW_LIMIT);
  return [
    {
      type: "tool_end",
      messageId: messageIdOf(state),
      toolCall: { name: toolName, summary, status: "running", resultPreview: preview === "" ? null : preview },
    },
  ];
}

/** tool_execution_end */
export function mapToolEnd(state: FeedState, toolCallId: string, toolName: string, result: unknown, isError: boolean): LiveWsEvent[] {
  const summary = state.toolArgs.get(toolCallId)?.summary ?? "";
  const preview = truncateText(contentToText(isRecord(result) ? result.content : undefined), RESULT_PREVIEW_LIMIT);
  state.toolResults.set(toolCallId, { isError, text: preview });
  return [
    {
      type: "tool_end",
      messageId: messageIdOf(state),
      toolCall: {
        name: toolName,
        summary,
        status: isError ? "error" : "done",
        resultPreview: preview === "" ? null : preview,
      },
    },
  ];
}

interface ToolCallBlock {
  id: string;
  name: string;
  arguments: unknown;
}

function toolCallsFromContent(content: unknown): ToolCallBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ToolCallBlock[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "toolCall") {
      out.push({
        id: typeof block.id === "string" ? block.id : "",
        name: typeof block.name === "string" ? block.name : "unknown",
        arguments: block.arguments,
      });
    }
  }
  return out;
}

/** message_end：权威消息（含 thinking + 折叠了结果的 toolCalls） */
export function mapMessageEnd(state: FeedState, message: PiMessageLike, now = Date.now()): LiveWsEvent[] {
  const role = message.role;
  if (role !== "user" && role !== "assistant" && role !== "custom") return [];
  const id = messageIdOf(state);
  const timestamp = typeof message.timestamp === "number" ? message.timestamp : (state.currentMessageStartTs ?? now);
  const text = contentToText(message.content);
  const thinking = contentToThinking(message.content) ?? (state.thinkingText !== "" ? state.thinkingText : null);

  const toolCalls: LiveToolCall[] = [];
  if (role === "assistant") {
    for (const block of toolCallsFromContent(message.content)) {
      const result = block.id !== "" ? state.toolResults.get(block.id) : undefined;
      toolCalls.push({
        name: block.name,
        summary: summarizeToolCall(block.name, block.arguments),
        status: result ? (result.isError ? "error" : "done") : "pending",
        resultPreview: result && result.text !== "" ? result.text : null,
      });
    }
    state.currentMessageId = null;
    state.currentMessageStartTs = null;
    state.thinkingText = "";
  }

  return [{ type: "message_end", message: { id, role: role as string, timestamp, text, thinking, toolCalls } }];
}

/** agent_start → status:running */
export function mapAgentStart(): LiveWsEvent[] {
  return [{ type: "status", status: "running" }];
}

/** agent_settled → agent_settled + status:idle */
export function mapAgentSettled(): LiveWsEvent[] {
  return [{ type: "agent_settled" }, { type: "status", status: "idle" }];
}

/** 推送地址：AGENT_HUB_LIVE_URL 覆盖；尾部斜杠归一 */
export function resolveLiveUrl(baseUrl: string | undefined, sessionId: string): string {
  const base = (baseUrl && baseUrl.trim() !== "" ? baseUrl.trim() : DEFAULT_LIVE_URL).replace(/\/+$/, "");
  return `${base}/api/live/${encodeURIComponent(sessionId)}`;
}

// ---- 扩展入口（事件订阅 + 批量/节流 + fire-and-forget POST） ----

interface LivePostDeps {
  url: string;
  token?: string;
}

/** fire-and-forget POST：失败/超时静默，绝不抛错阻塞 pi */
function postEvents(deps: LivePostDeps, sessionId: string, events: LiveWsEvent[]): void {
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (deps.token) headers.authorization = `Bearer ${deps.token}`;
    const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(POST_TIMEOUT_MS) : undefined;
    const request = fetch(resolveLiveUrl(deps.url, sessionId), {
      method: "POST",
      headers,
      body: JSON.stringify({ events }),
      signal,
    });
    void Promise.resolve(request).catch(() => undefined);
  } catch {
    // 静默：扩展故障不影响 pi
  }
}

export default function liveFeed(pi: ExtensionAPI): void {
  const state = createFeedState();
  let pending: LiveWsEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let currentSessionId: string | null = null;

  const sessionUrlBase = (): LivePostDeps => ({
    url: (process.env.AGENT_HUB_LIVE_URL ?? DEFAULT_LIVE_URL).replace(/\/+$/, ""),
    token: process.env.AGENT_HUB_LIVE_TOKEN,
  });

  const flush = (): void => {
    const events = pending;
    pending = [];
    if (events.length === 0 || currentSessionId === null) return;
    postEvents(sessionUrlBase(), currentSessionId, events);
  };

  const schedule = (): void => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, DELTA_FLUSH_MS);
    timer.unref?.();
  };

  /** urgent：生命周期事件立即冲刷（连同缓冲 delta，保序）；否则进 100ms 合并窗口 */
  const push = (events: LiveWsEvent[], urgent: boolean): void => {
    if (events.length === 0) return;
    pending.push(...events);
    if (urgent) {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      flush();
    } else {
      schedule();
    }
  };

  const touch = (ctx: ExtensionContext): void => {
    try {
      currentSessionId = ctx.sessionManager.getSessionId();
    } catch {
      // 拿不到 sessionId 就丢弃本批（宁可少推，不能报错）
    }
  };

  /** 扩展处理器铁律：任何异常静默吞掉，绝不影响 pi 运行 */
  const safe = <E>(fn: (event: E, ctx: ExtensionContext) => void) => {
    return (event: E, ctx: ExtensionContext): void => {
      try {
        fn(event, ctx);
      } catch {
        // 静默
      }
    };
  };

  pi.on(
    "agent_start",
    safe((_event: AgentStartEvent, ctx: ExtensionContext) => {
      touch(ctx);
      push(mapAgentStart(), true);
    }),
  );

  pi.on(
    "agent_settled",
    safe((_event: AgentSettledEvent, ctx: ExtensionContext) => {
      touch(ctx);
      push(mapAgentSettled(), true);
    }),
  );

  pi.on(
    "message_start",
    safe((event: MessageStartEvent, ctx: ExtensionContext) => {
      touch(ctx);
      push(mapMessageStart(state, event.message as PiMessageLike), true);
    }),
  );

  pi.on(
    "message_update",
    safe((event: MessageUpdateEvent, ctx: ExtensionContext) => {
      touch(ctx);
      push(mapMessageUpdate(state, event.assistantMessageEvent as AssistantMessageEventLike), false);
    }),
  );

  pi.on(
    "tool_execution_start",
    safe((event: ToolExecutionStartEvent, ctx: ExtensionContext) => {
      touch(ctx);
      push(mapToolStart(state, event.toolCallId, event.toolName, event.args), true);
    }),
  );

  pi.on(
    "tool_execution_update",
    safe((event: ToolExecutionUpdateEvent, ctx: ExtensionContext) => {
      touch(ctx);
      // 执行中快照走合并窗口（工具流式输出可能很密）
      push(mapToolUpdate(state, event.toolCallId, event.toolName, event.partialResult), false);
    }),
  );

  pi.on(
    "tool_execution_end",
    safe((event: ToolExecutionEndEvent, ctx: ExtensionContext) => {
      touch(ctx);
      push(mapToolEnd(state, event.toolCallId, event.toolName, event.result, event.isError === true), true);
    }),
  );

  pi.on(
    "message_end",
    safe((event: MessageEndEvent, ctx: ExtensionContext) => {
      touch(ctx);
      push(mapMessageEnd(state, event.message as PiMessageLike), true);
    }),
  );

  pi.on(
    "session_shutdown",
    safe(() => {
      // 退出前冲刷残余 delta（尽力而为）
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      flush();
    }),
  );
}
