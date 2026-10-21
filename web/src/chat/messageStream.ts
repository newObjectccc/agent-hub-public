/**
 * WS 事件流 → 消息列表的纯 reducer（docs/API_CONTRACT.md 第 4 节）。
 *
 * - message_start：占位消息（打字机从空文本开始）
 * - text_delta：追加文本（打字机）
 * - thinking_delta：追加思维链（累积到消息 thinking 字段）
 * - tool_start / tool_end：更新/追加 toolCalls
 * - message_end：用权威消息替换（同 id 覆盖）
 * - 其余事件由 UI 层另行处理（status / agent_settled / error）
 */
import type { SessionMessage, ToolCall } from "../api/types";

export interface WsEvent {
  type: string;
  message?: Partial<SessionMessage> & { id: string };
  messageId?: string;
  delta?: string;
  toolCall?: Partial<ToolCall> & { name: string };
  status?: string;
  code?: string;
  [key: string]: unknown;
}

function normalizeMessage(m: Partial<SessionMessage> & { id: string }): SessionMessage {
  return {
    id: m.id,
    role: m.role ?? "assistant",
    timestamp: m.timestamp ?? Date.now(),
    text: m.text ?? "",
    thinking: typeof m.thinking === "string" ? m.thinking : null,
    toolCalls: m.toolCalls ?? [],
    streaming: m.streaming === true,
    // 错误随消息保留（白名单式 normalize：不加这一行 server 透出的 error 会被静默丢弃，
    // 前端就只剩一个空气泡渲染成「（无内容）」）
    ...(m.error ? { error: m.error } : {}),
    // 图片随消息保留（WS 权威回填丢图 bug：手机发图后 message_end 不带 images 时气泡图片消失）
    ...(m.images ? { images: m.images } : {}),
    ...(m.turnId ? { turnId: m.turnId } : {}),
  };
}

/**
 * 权威消息替换时保留前端本地已展示内容（权威数据缺省不抹掉增量累积）：
 * - thinking：未带思维链时保留流式累积的 thinking
 * - images：未带图片时保留占位/流式已展示的图片（手机发图 → server 落盘后 WS 权威回填不再丢图）
 */
function withLocalFallbacks(authoritative: SessionMessage, previous: SessionMessage): SessionMessage {
  const thinking = authoritative.thinking && authoritative.thinking !== "" ? authoritative.thinking : (previous.thinking ?? null);
  const images = authoritative.images !== undefined ? authoritative.images : previous.images;
  // 错误以权威为准，权威未带时保留已展示的（对账/tail 路径不一定重带 error，不能把错误条闪没）
  const error = authoritative.error !== undefined ? authoritative.error : previous.error;
  return {
    ...authoritative,
    thinking,
    ...(images !== undefined ? { images } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

/**
 * 权威替换时保留前端本地打点的工具执行时长（server DTO 不带 startedAt/endedAt）：
 * 按 name+序号对应回填，不改变其余字段。
 */
function withToolTiming(authoritative: SessionMessage, previous: SessionMessage): SessionMessage {
  if (previous.toolCalls.length === 0) return authoritative;
  const toolCalls = authoritative.toolCalls.map((tc, i) => {
    const old = previous.toolCalls[i] ?? previous.toolCalls.find((t) => t.name === tc.name);
    if (!old) return tc;
    return {
      ...tc,
      ...(old.startedAt !== undefined ? { startedAt: old.startedAt } : {}),
      ...(old.endedAt !== undefined ? { endedAt: old.endedAt } : {}),
    };
  });
  return { ...authoritative, toolCalls };
}

/** 事件打点时间：带 timestamp 用之（可重放/可测），否则本地时钟 */
function eventTime(event: WsEvent): number {
  return typeof event.timestamp === "number" ? event.timestamp : Date.now();
}

function updateMessage(
  messages: SessionMessage[],
  messageId: string,
  updater: (m: SessionMessage) => SessionMessage,
): SessionMessage[] {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return messages;
  const next = messages.slice();
  next[idx] = updater(messages[idx]);
  return next;
}

/**
 * 空 assistant 终态判定：无文本、无工具卡、无思维链/图片/错误——渲染出来只会是「（无内容）」空气泡。
 * codex 接管真机实测：工具调用轮的中间产物会发 message_end role=assistant text=""
 * （driver endItem 对空 agentMessage 也发终态）；server 快照层（codex-rollout）已过滤同类空消息，
 * WS live 路径对齐同一口径。有 toolCalls 必须保留（工具卡片载体）；有 error 必须保留（错误条载体）。
 */
function isEmptyAssistant(m: SessionMessage): boolean {
  return (
    m.role === "assistant" &&
    m.text.trim() === "" &&
    m.toolCalls.length === 0 &&
    !m.thinking &&
    (m.images?.length ?? 0) === 0 &&
    !m.error
  );
}

/** 流式/乐观占位 id 形态（仅这些候选允许被权威消息合并） */
function isPlaceholderId(id: string): boolean {
  return id.startsWith("local-") || id.startsWith("live-") || id.startsWith("stream-");
}

/**
 * message_end 纯防御性去重（重复气泡 bug 的内容级兜底）：
 * 从尾部向前收集「连续的同 role+同非空 text 流式/乐观占位」，FIFO 合并其中最早一条
 * （权威消息按到达顺序对应回填）。
 * - 连续两条同文本（快速连发）：两条占位各自按序回填、独立显示，不错位/不残留
 * - 占位段外（中间隔有其它消息/权威消息）不动：绝不误合并合法重复消息
 *   （live-* 形态 id 也可能是 hub 已完成消息的最终 id，只能合并尾部未回填区）
 */
function findTailPlaceholder(messages: SessionMessage[], authoritative: SessionMessage): number {
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    const match =
      isPlaceholderId(m.id) &&
      m.role === authoritative.role &&
      m.text !== "" &&
      m.text === authoritative.text;
    if (!match) break;
    start = i;
  }
  return start === messages.length ? -1 : start;
}

/**
 * user 乐观占位回填目标：尾部最近一条「user + 非空 text + 占位形态 id」消息。
 * user 的 message_start/message_end 总在该轮 assistant 之前到达，此时尾部最近的
 * user 占位必然是本轮未回填的乐观占位（新发送的占位恒在尾部）。
 */
function findTailUserPlaceholder(messages: SessionMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (isPlaceholderId(m.id) && m.role === "user" && m.text !== "") return i;
  }
  return -1;
}

export function applyWsEvent(messages: SessionMessage[], event: WsEvent): SessionMessage[] {
  switch (event.type) {
    case "message_start": {
      if (!event.message?.id) return messages;
      // 流式占位/重复 message_start 均标记 streaming（空内容时前端渲染"回复中"活占位）
      const msg = { ...normalizeMessage(event.message), streaming: true };
      if (messages.some((m) => m.id === msg.id)) {
        return updateMessage(messages, msg.id, (m) => ({ ...m, ...msg, text: m.text, toolCalls: m.toolCalls }));
      }
      // user 消息也有 message_start 流式占位（pi SDK 路径）：不回填乐观占位会变成
      // 「local- 乐观占位 + live- 流式占位」双条重复（手机实测 bug）。
      // 只对 user 生效（assistant 新流式绝不吞并已有消息）；回填保留占位已显示的文本。
      if (msg.role === "user") {
        const dupIdx = findTailUserPlaceholder(messages);
        if (dupIdx >= 0) {
          const next = messages.slice();
          next[dupIdx] = { ...next[dupIdx], id: msg.id, timestamp: msg.timestamp, streaming: true };
          return next;
        }
      }
      return [...messages, msg];
    }
    case "text_delta": {
      if (!event.messageId) return messages;
      return updateMessage(messages, event.messageId, (m) => ({
        ...m,
        text: m.text + (event.delta ?? ""),
      }));
    }
    case "thinking_delta": {
      if (!event.messageId) return messages;
      return updateMessage(messages, event.messageId, (m) => ({
        ...m,
        thinking: (m.thinking ?? "") + (event.delta ?? ""),
      }));
    }
    case "tool_start": {
      if (!event.messageId || !event.toolCall) return messages;
      const tc: ToolCall = {
        name: event.toolCall.name,
        summary: event.toolCall.summary ?? "",
        status: event.toolCall.status ?? "running",
        resultPreview: event.toolCall.resultPreview ?? null,
        startedAt: eventTime(event),
      };
      return updateMessage(messages, event.messageId, (m) => {
        // message_end（权威）已带 pending 工具卡时，tool_start 是同一张卡的“开始执行”，
        // 合并进首个同名 pending 卡而非重复追加（双卡 bug）；没有才追加新卡
        const idx = m.toolCalls.findIndex((t) => t.name === tc.name && t.status === "pending");
        if (idx >= 0) {
          const toolCalls = m.toolCalls.slice();
          const old = toolCalls[idx];
          toolCalls[idx] = {
            name: tc.name,
            summary: tc.summary !== "" ? tc.summary : old.summary,
            status: tc.status,
            resultPreview: tc.resultPreview ?? old.resultPreview,
            startedAt: tc.startedAt,
          };
          return { ...m, toolCalls };
        }
        return { ...m, toolCalls: [...m.toolCalls, tc] };
      });
    }
    case "tool_end": {
      if (!event.messageId || !event.toolCall) return messages;
      return updateMessage(messages, event.messageId, (m) => {
        const toolCalls = m.toolCalls.slice();
        // 同名多工具卡（bash × N）：从尾部找未完结（running/pending）的同名卡回填结果，
        // 否则最后一张同名卡；不能再用 findIndex（会永远覆盖第一张，后续卡永留“运行中”）
        let idx = -1;
        for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
          const t = toolCalls[i];
          if (t.name !== event.toolCall!.name) continue;
          if (idx === -1) idx = i;
          if (t.status === "running" || t.status === "pending") {
            idx = i;
            break;
          }
        }
        const merged: ToolCall = {
          name: event.toolCall!.name,
          summary: event.toolCall!.summary ?? (idx >= 0 ? toolCalls[idx].summary : ""),
          status: event.toolCall!.status ?? "done",
          resultPreview: event.toolCall!.resultPreview ?? (idx >= 0 ? toolCalls[idx].resultPreview : null),
          startedAt: idx >= 0 ? toolCalls[idx].startedAt : undefined,
          endedAt: eventTime(event),
        };
        if (idx >= 0) toolCalls[idx] = merged;
        else toolCalls.push(merged);
        return { ...m, toolCalls };
      });
    }
    case "message_end": {
      if (!event.message?.id) return messages;
      const authoritative = normalizeMessage(event.message);
      const idx = messages.findIndex((m) => m.id === authoritative.id);
      if (idx >= 0) {
        const merged = withToolTiming(withLocalFallbacks(authoritative, messages[idx]), messages[idx]);
        // 空 assistant 终态：连同已展示的流式占位一起移除——留着要么渲染「（无内容）」，
        // 要么（占位还带 streaming 标志时）永远转「✍️ 回复中」活占位，两者都是脏 UI。
        // 判空基于合并后的消息：占位已累积的 thinking/images/error 不会被误删。
        if (isEmptyAssistant(merged)) {
          const next = messages.slice();
          next.splice(idx, 1);
          return next;
        }
        const next = messages.slice();
        next[idx] = merged;
        return next;
      }
      // 纯防御去重：合并尾部连续同文本占位段内最早一条（同 role+同非空 text），
      // 覆盖三类真实场景：流式占位 id 与权威 id 不一致的重复投递、user 乐观占位（local-）
      // 回填、连续两条同文本的 FIFO 对应回填（各自独立显示，不误合并）
      const dupIdx = findTailPlaceholder(messages, authoritative);
      if (dupIdx >= 0) {
        const next = messages.slice();
        next[dupIdx] = withToolTiming(withLocalFallbacks(authoritative, messages[dupIdx]), messages[dupIdx]);
        return next;
      }
      // 空 assistant 不新增气泡（codex 工具轮中间产物；快照层已过滤，live 路径同口径）
      if (isEmptyAssistant(authoritative)) return messages;
      return [...messages, authoritative];
    }
    default:
      // 防新增事件静默丢：dev 环境对未知事件 type 告警（已知非消息流事件由 UI 层另行处理，不告警）
      if (import.meta.env.DEV && !KNOWN_NON_MESSAGE_EVENTS.has(event.type)) {
        console.warn(`[messageStream] 未知 WS 事件被忽略：${event.type}`);
      }
      return messages;
  }
}

/** UI 层另行处理的已知非消息流事件（不参与消息 reducer，也不算未知事件） */
const KNOWN_NON_MESSAGE_EVENTS = new Set([
  "status",
  "agent_settled",
  "error",
  "subagent_activity",
  "attach_state",
  "command_ack",
  "host_request",
  "host_request_resolved",
  "pong",
  "sessions_changed",
  "notification",
  "session_status",
]);

/** 全量对账：用 GET /api/sessions/:id 的权威消息整体替换；
 *  在途流式消息（prev.streaming）按 id 保留已累积内容与标志：
 *  - GET 快照落后于已到达的 delta 时取更长文本（不丢字/不重影），等 message_end 权威替换
 *  - 快照里还没有的在途消息留在尾部（进行中的回复不消失） */
export function reconcileMessages(prev: SessionMessage[], fresh: SessionMessage[], recentIds: ReadonlySet<string> = new Set()): SessionMessage[] {
  const inFlight = new Map(prev.filter((m) => m.streaming === true).map((m) => [m.id, m] as const));
  const withImages = prev.filter((m) => m.images !== undefined);
  if (inFlight.size === 0 && withImages.length === 0) return preserveRecentMessages(prev, fresh, recentIds);
  const previousById = new Map(withImages.map((m) => [m.id, m] as const));
  const freshIds = new Set(fresh.map((m) => m.id));
  const imageFallbacks = new Map<string, SessionMessage>();
  // live-user-* 与落盘 UUID 不同：优先匹配发送时间最近的同正文消息，并且一对一消费。
  // 普通历史消息只按 id 回填，避免相同正文的旧图片套给新消息。
  for (const old of withImages) {
    if (!isPlaceholderId(old.id) || old.role !== "user" || old.text === "" || freshIds.has(old.id)) continue;
    let closest: SessionMessage | undefined;
    let distance = 60_001;
    for (const candidate of fresh) {
      if (previousById.has(candidate.id) || imageFallbacks.has(candidate.id)
        || candidate.role !== old.role || candidate.text !== old.text) continue;
      const difference = Math.abs(old.timestamp - candidate.timestamp);
      if (difference < distance) {
        closest = candidate;
        distance = difference;
      }
    }
    if (closest) imageFallbacks.set(closest.id, old);
  }
  let changed = false;
  const merged = fresh.map((m) => {
    let next = m;
    const previous = previousById.get(m.id) ?? imageFallbacks.get(m.id);
    if (previous && m.images === undefined) {
      next = { ...m, images: previous.images };
      changed = true;
    }
    const live = inFlight.get(m.id);
    if (!live) return next;
    changed = true;
    const text = live.text.length > m.text.length ? live.text : m.text;
    const thinking = (live.thinking?.length ?? 0) > (m.thinking?.length ?? 0) ? live.thinking : m.thinking;
    return { ...next, text, thinking, streaming: true };
  });
  const tail = prev.filter((m) => m.streaming === true && !freshIds.has(m.id));
  return preserveRecentMessages(prev, tail.length === 0 ? (changed ? merged : fresh) : [...merged, ...tail], recentIds);
}

/** GET 开始后的 WS 更新由接收版本保护，不能用消息创建时间推断已删除。
 * 压缩后的下一次 GET 会重新建立版本基线；此前已完成的消息不再属于 recentIds。
 * 时间戳只参与显示顺序，不参与判断消息是否存在。 */
function preserveRecentMessages(prev: SessionMessage[], merged: SessionMessage[], recentIds: ReadonlySet<string>): SessionMessage[] {
  if (recentIds.size === 0) return merged;
  const recent = new Map(prev.filter((message) => recentIds.has(message.id)).map((message) => [message.id, message] as const));
  const ids = new Set(merged.map((message) => message.id));
  const result = merged.map((message) => recent.get(message.id) ?? message);
  for (const message of prev) {
    if (!recent.has(message.id) || ids.has(message.id)) continue;
    // 按时序插入：从尾部找第一个 timestamp <= 本条的位置（相等时排在其后，保持既有相对顺序）；
    // 典型竞态里本条就是最新的，扫描立即命中末尾，等价旧行为的 append（常见路径零额外开销）
    let at = result.length;
    while (at > 0 && result[at - 1].timestamp > message.timestamp) at -= 1;
    result.splice(at, 0, message);
  }
  return result;
}
