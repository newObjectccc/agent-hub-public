/**
 * WS 事件流 → 消息列表的纯 reducer（docs/API_CONTRACT.md 第 4 节）。
 *
 * - message_start：占位消息（打字机从空文本开始）
 * - text_delta：追加文本（打字机）
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
    toolCalls: m.toolCalls ?? [],
  };
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

/** message_end 内容级去重的时间接近阈值（占位开始 vs 权威结束的合理时间差） */
const DEDUP_TIME_WINDOW_MS = 5 * 60_000;

/**
 * message_end 防御性去重（重复气泡 bug 的内容级兜底）：
 * 权威 id 找不到时，若已有「相同 role + 相同非空 text + （位置相邻 或 时间接近）」
 * 的另一条消息（不同 id，典型为流式占位），则就地合并为一条并保留权威 id/字段，
 * 不再 append 造成重复气泡。
 */
function findContentDuplicate(
  messages: SessionMessage[],
  authoritative: SessionMessage,
): number {
  return messages.findIndex((m, i) => {
    if (m.role !== authoritative.role) return false;
    if (!m.text || m.text !== authoritative.text) return false;
    // 「相邻」：候选是列表最后一条（权威消息 append 后与它紧邻）；
    // 或「时间接近」：两条消息时间戳差在阈值内。
    const nearTail = i === messages.length - 1;
    const nearTime = Math.abs(m.timestamp - authoritative.timestamp) <= DEDUP_TIME_WINDOW_MS;
    return nearTail || nearTime;
  });
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
    case "tool_start": {
      if (!event.messageId || !event.toolCall) return messages;
      const tc: ToolCall = {
        name: event.toolCall.name,
        summary: event.toolCall.summary ?? "",
        status: event.toolCall.status ?? "running",
        resultPreview: event.toolCall.resultPreview ?? null,
      };
      return updateMessage(messages, event.messageId, (m) => ({
        ...m,
        toolCalls: [...m.toolCalls, tc],
      }));
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
        next[idx] = authoritative;
        return next;
      }
      // 内容级去重兜底：id 不一致但内容一致的重复投递 → 合并为一条（保留权威 id）
      const dupIdx = findContentDuplicate(messages, authoritative);
      if (dupIdx >= 0) {
        const next = messages.slice();
        next[dupIdx] = authoritative;
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
