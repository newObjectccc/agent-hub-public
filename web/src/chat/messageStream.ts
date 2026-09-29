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
  };
}

/** 权威消息替换时保留已流式的思维链（权威数据未带 thinking 时不抹掉增量累积） */
function withThinkingFallback(authoritative: SessionMessage, previous: SessionMessage): SessionMessage {
  const thinking = authoritative.thinking && authoritative.thinking !== "" ? authoritative.thinking : (previous.thinking ?? null);
  return { ...authoritative, thinking };
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
      const msg = normalizeMessage(event.message);
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
          next[dupIdx] = { ...next[dupIdx], id: msg.id, timestamp: msg.timestamp };
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
        const idx = toolCalls.findIndex((t) => t.name === event.toolCall!.name);
        const merged: ToolCall = {
          name: event.toolCall!.name,
          summary: event.toolCall!.summary ?? (idx >= 0 ? toolCalls[idx].summary : ""),
          status: event.toolCall!.status ?? "done",
          resultPreview: event.toolCall!.resultPreview ?? (idx >= 0 ? toolCalls[idx].resultPreview : null),
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
        const next = messages.slice();
        next[idx] = withThinkingFallback(authoritative, messages[idx]);
        return next;
      }
      // 纯防御去重：合并尾部连续同文本占位段内最早一条（同 role+同非空 text），
      // 覆盖三类真实场景：流式占位 id 与权威 id 不一致的重复投递、user 乐观占位（local-）
      // 回填、连续两条同文本的 FIFO 对应回填（各自独立显示，不误合并）
      const dupIdx = findTailPlaceholder(messages, authoritative);
      if (dupIdx >= 0) {
        const next = messages.slice();
        next[dupIdx] = withThinkingFallback(authoritative, messages[dupIdx]);
        return next;
      }
      return [...messages, authoritative];
    }
    default:
      return messages;
  }
}

/** 全量对账：用 GET /api/sessions/:id 的权威消息整体替换 */
export function reconcileMessages(_prev: SessionMessage[], fresh: SessionMessage[]): SessionMessage[] {
  return fresh;
}
