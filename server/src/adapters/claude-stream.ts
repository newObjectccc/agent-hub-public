/**
 * claude CLI `--output-format stream-json` 事件流 → 契约 WS 事件（纯函数状态机）。
 *
 * ── 调研结论（2026-09-29，claude 2.1.267 实测 `claude -p … --output-format stream-json
 *    --include-partial-messages --verbose`）────────────────────────────────────
 * stdout 每行一个 JSON：
 * - `{"type":"system","subtype":"init", session_id, cwd, tools, model, permissionMode…}`：握手
 * - `{"type":"system","subtype":"status"|"thinking_tokens"}`：噪音，跳过
 * - `{"type":"stream_event","event":<Anthropic 原始流事件>}`：
 *   `message_start` → `content_block_start`（thinking|text|tool_use）→
 *   `content_block_delta`（thinking_delta|text_delta|input_json_delta|signature_delta）→
 *   `content_block_stop` → … → `message_delta` → `message_stop`
 * - `{"type":"assistant","message":{id,role,content:[block]}, uuid, timestamp}`：
 *   **每个 content block 一条**权威记录（与 transcript 落盘行同构，uuid 一致）
 * - `{"type":"user","message":{content:[{tool_use_id,type:"tool_result",content,is_error}]}}`：
 *   工具结果（-p 模式不回显用户 prompt）
 * - `{"type":"result", subtype:"success"|"error_max_turns"…, is_error, result, …}`：终态
 * 其它行（含非 JSON 行，如 `[claude-code:xxx]` 提示）一律优雅跳过。
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 映射规则（docs/API_CONTRACT.md §4）：
 * - system/init → status:"running"
 * - stream_event text_delta → text_delta（打字机体验）
 * - assistant 行 → 聚合为一条 assistant 消息（text + toolCalls），首个 block 触发 message_start，
 *   tool_use block 触发 tool_start
 * - user 行 tool_result → tool_end（折叠结果也回填进聚合消息的 toolCalls）
 * - stream_event message_stop → message_end（该条 API 消息聚合完毕）
 * - result → message_end（兜底 flush）+ agent_settled + status（idle|error）
 */
import { ErrorCodes } from "../errors.js";
import type { MessageDto, ServerEvent, ToolCallDto } from "../types.js";
import { RESULT_PREVIEW_LIMIT, contentToText, summarizeToolCall, truncateText } from "../sessions/scan.js";

interface LiveMessage {
  /** 契约事件用的流内 id（live-* 形态，前端按 id upsert） */
  id: string;
  /** claude API message.id（msg_…），与 transcript 聚合口径一致 */
  apiId: string;
  timestamp: number;
  text: string;
  toolCalls: ToolCallDto[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class ClaudeStreamTranslator {
  private seq = 0;
  private current: LiveMessage | null = null;
  private readonly callOwners = new Map<string, { messageId: string; dto: ToolCallDto }>();
  private sawResult = false;

  /** 是否已收到 result 终态（进程退出兜底判断用） */
  get finished(): boolean {
    return this.sawResult;
  }

  /** stdin 一行 → 契约 WS 事件（未识别行返回 []） */
  feed(line: string): ServerEvent[] {
    const trimmed = line.trim();
    if (trimmed === "") return [];
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      return []; // 非 JSON 行（如 [claude-code:unrecognized_model] 提示）跳过
    }
    if (!isRecord(row) || typeof row.type !== "string") return [];

    switch (row.type) {
      case "system": {
        return row.subtype === "init" ? [{ type: "status", status: "running" }] : [];
      }
      case "stream_event": {
        const ev = row.event;
        if (!isRecord(ev)) return [];
        return this.handleStreamEvent(ev);
      }
      case "assistant": {
        return this.handleAssistant(row);
      }
      case "user": {
        return this.handleUser(row);
      }
      case "result": {
        return this.handleResult(row);
      }
      default:
        return [];
    }
  }

  /** 进程退出（未收到 result）时的兜底 flush */
  flush(): ServerEvent[] {
    const events: ServerEvent[] = [];
    const flushed = this.endMessage();
    if (flushed) events.push(flushed);
    return events;
  }

  // ---- 内部 ----

  private handleStreamEvent(ev: Record<string, unknown>): ServerEvent[] {
    switch (ev.type) {
      case "message_start": {
        const message = ev.message;
        const apiId = isRecord(message) && typeof message.id === "string" ? message.id : "";
        const events: ServerEvent[] = [];
        this.startMessage(apiId, Date.now(), events);
        return events;
      }
      case "content_block_delta": {
        // 原始 Anthropic delta：仅 text_delta 进打字机流（thinking_delta/input_json_delta 等跳过）
        const delta = ev.delta;
        if (!isRecord(delta) || delta.type !== "text_delta" || typeof delta.text !== "string") return [];
        if (!this.current) return [];
        return [{ type: "text_delta", messageId: this.current.id, delta: delta.text }];
      }
      case "message_stop": {
        const ended = this.endMessage();
        return ended ? [ended] : [];
      }
      default:
        // content_block_start/stop、input_json_delta、message_delta、thinking_delta 等：
        // 权威内容由 assistant 行聚合，这里只做流式体验与生命周期
        return [];
    }
  }

  private handleAssistant(row: Record<string, unknown>): ServerEvent[] {
    const message = row.message;
    if (!isRecord(message)) return [];
    const apiId = typeof message.id === "string" && message.id !== "" ? message.id : typeof row.uuid === "string" ? row.uuid : "";
    const timestamp = typeof row.timestamp === "string" ? Date.parse(row.timestamp) || Date.now() : Date.now();
    const events: ServerEvent[] = [];
    this.startMessage(apiId, timestamp, events);

    const blocks = Array.isArray(message.content) ? message.content : [];
    const textParts: string[] = [];
    if (this.current && this.current.text !== "") textParts.push(this.current.text);
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        const name = typeof block.name === "string" && block.name !== "" ? block.name : "unknown";
        const dto: ToolCallDto = {
          name,
          summary: summarizeToolCall(name, block.input),
          status: "running",
          resultPreview: null,
        };
        if (this.current) {
          this.current.toolCalls.push(dto);
          if (typeof block.id === "string") this.callOwners.set(block.id, { messageId: this.current.id, dto });
          events.push({
            type: "tool_start",
            messageId: this.current.id,
            toolCall: { name, summary: dto.summary },
          });
        }
      }
    }
    if (this.current) this.current.text = textParts.join("\n");
    return events;
  }

  private handleUser(row: Record<string, unknown>): ServerEvent[] {
    const message = row.message;
    if (!isRecord(message)) return [];
    const content = message.content;
    if (!Array.isArray(content)) return [];
    const events: ServerEvent[] = [];
    const textParts: string[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "tool_result" || typeof block.tool_use_id === "string") {
        const toolCallId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        const owner = this.callOwners.get(toolCallId);
        if (!owner) continue; // 孤儿 tool_result：跳过（无所属消息）
        const preview = truncateText(contentToText(block.content), RESULT_PREVIEW_LIMIT);
        owner.dto.status = block.is_error === true ? "error" : "done";
        owner.dto.resultPreview = preview === "" ? null : preview;
        events.push({
          type: "tool_end",
          messageId: owner.messageId,
          toolCall: {
            name: owner.dto.name,
            summary: owner.dto.summary,
            status: owner.dto.status,
            resultPreview: owner.dto.resultPreview,
          },
        });
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") textParts.push(block.text);
    }
    // 输入流回显的用户消息（--input-format stream-json + --replay-user-messages 场景）
    const text = textParts.join("\n").trim();
    if (text !== "") {
      this.seq += 1;
      events.push({
        type: "message_end",
        message: {
          id: `live-user-${this.seq}-${Date.now()}`,
          role: "user",
          timestamp: Date.now(),
          text,
          toolCalls: [],
        },
      });
    }
    return events;
  }

  private handleResult(row: Record<string, unknown>): ServerEvent[] {
    this.sawResult = true;
    const events: ServerEvent[] = [];
    const ended = this.endMessage();
    if (ended) events.push(ended);
    const isError = row.is_error === true || (typeof row.subtype === "string" && row.subtype !== "success");
    if (isError) {
      const detail = typeof row.result === "string" ? row.result : "claude 运行失败";
      events.push({ type: "error", code: ErrorCodes.PROMPT_FAILED, message: truncateText(detail, 500) });
      events.push({ type: "status", status: "error" });
    } else {
      events.push({ type: "status", status: "idle" });
    }
    events.push({ type: "agent_settled" });
    return events;
  }

  /** 开启新 API 消息（apiId 变化时先 flush 上一条） */
  private startMessage(apiId: string, timestamp: number, events: ServerEvent[] = []): void {
    if (this.current && (apiId === "" || this.current.apiId === apiId)) return;
    const ended = this.endMessage();
    if (ended) events.push(ended);
    this.seq += 1;
    const id = `live-${this.seq}-${Date.now()}`;
    this.current = {
      id,
      apiId,
      timestamp,
      text: "",
      toolCalls: [],
    };
    events.push({
      type: "message_start",
      message: { id, role: "assistant", timestamp },
    });
  }

  private endMessage(): Extract<ServerEvent, { type: "message_end" }> | null {
    const current = this.current;
    if (!current) return null;
    this.current = null;
    const dto: MessageDto = {
      id: current.id,
      role: "assistant",
      timestamp: current.timestamp,
      text: current.text,
      // 快照克隆：后续 tool_result 不得回写已发出去的 message_end payload
      toolCalls: current.toolCalls.map((t) => ({ ...t })),
    };
    return { type: "message_end", message: dto };
  }
}
