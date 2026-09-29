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
 * 仅允许合并「列表最后一条流式/乐观占位」（id 为占位形态 且 role+非空 text 一致），
 * 典型：占位 id 与权威 id 不一致的重复投递、user 乐观占位（local-）回填。
 * 不扫描历史、不用时间窗——绝不误合并合法的重复消息。
 */
function findTailPlaceholder(messages: SessionMessage[], authoritative: SessionMessage): number {
  const lastIdx = messages.length - 1;
  if (lastIdx < 0) return -1;
  const last = messages[lastIdx];
  if (!isPlaceholderId(last.id)) return -1;
  if (last.role !== authoritative.role) return -1;
  if (!last.text || last.text !== authoritative.text) return -1;
  return lastIdx;
}

export function applyWsEvent(messages: SessionMessage[], event: WsEvent): SessionMessage[] {
  switch (event.type) {
    case "message_start": {
      if (!event.message?.id) return messages;
      const msg = normalizeMessage(event.message);
      if (messages.some((m) => m.id === msg.id)) {
        return updateMessage(messages, msg.id, (m) => ({ ...m, ...msg, text: m.text, toolCalls: m.toolCalls }));
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
      // 纯防御去重：仅合并列表末尾的流式/乐观占位（同 role+同非空 text），
      // 覆盖两类真实场景：流式占位 id 与权威 id 不一致的重复投递、user 乐观占位（local-）回填
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
