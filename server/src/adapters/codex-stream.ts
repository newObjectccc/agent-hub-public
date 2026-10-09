/**
 * codex CLI `codex exec --json` 事件流 → 契约 WS 事件（纯函数状态机）。
 *
 * ── 调研结论（2026-10-09，codex-cli 0.143 实测 + 二进制 serde tag 表枚举）────────
 * stdout 每行一个 JSON（EventMsg 流，snake_case tag）：
 * - `{"type":"thread.started","thread_id":…}`：握手
 * - `{"type":"turn.started"}` / `{"type":"task_started", turn_id, …}`：一轮开始
 * - `{"type":"agent_message_content_delta", item_id, delta, …}`：助手文本增量
 * - `{"type":"agent_message", message|content, …}`：助手消息（全文，commentary /
 *   final_answer 都是可见输出）
 * - `{"type":"item.started"|"item.updated"|"item.completed","item":{id, type, …}}`：
 *   条目生命周期。item.type（snake_case）有 agent_message / user_message /
 *   command_execution（command/aggregated_output/exit_code/status…）/ mcp_tool_call /
 *   file_change / web_search / dynamic_tool_call / reasoning / error …
 * - `{"type":"user_message", message, …}`：用户输入回显（适配层已合成 user 消息，跳过防重复）
 * - `{"type":"task_complete", last_agent_message, …}` / `{"type":"turn.completed"}`：轮终态
 * - `{"type":"error", message}` / `{"type":"turn.failed", error:{message}}`：失败
 * 其它行（token_count / reasoning* / plan_delta / hook_* / 非 JSON 行）一律优雅跳过。
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 映射规则（docs/API_CONTRACT.md §4，与 claude-stream 同契约）：
 * - thread.started / turn.started / task_started → status:"running"
 * - agent_message_content_delta → message_start（懒开）+ text_delta（打字机）
 * - agent_message → 当前消息全文覆盖（不发 message_end，收尾由 item.completed/轮终态负责）
 * - item.started（工具类）→ tool_start；item.completed（工具类）→ tool_end（结果折叠回消息）
 * - item.completed（agent_message）→ message_end
 * - task_complete / turn.completed → message_end（兜底）+ status:"idle" + agent_settled
 * - error / turn.failed → error 事件（每轮至多一条，重复终态不重复弹）+ message_end +
 *   status:"error" + agent_settled（status/收尾统一由轮终态发）
 */
import { ErrorCodes } from "../errors.js";
import type { MessageDto, ServerEvent, ToolCallDto } from "../types.js";
import { RESULT_PREVIEW_LIMIT, summarizeToolCall, truncateText } from "../sessions/scan.js";
import { summarizeCodexToolCall } from "./codex-rollout.js";

interface LiveMessage {
  /** 契约事件用的流内 id（live-* 形态，前端按 id upsert） */
  id: string;
  timestamp: number;
  text: string;
  toolCalls: ToolCallDto[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** item.type → 工具名（exec_command 与 rollout function_call.name 同名，前端折叠一致） */
const TOOL_ITEM_NAMES: Record<string, string> = {
  command_execution: "exec_command",
  mcp_tool_call: "mcp_tool_call",
  file_change: "apply_patch",
  web_search: "web_search",
  dynamic_tool_call: "dynamic_tool_call",
  collab_agent_tool_call: "collab_agent_tool_call",
  image_generation: "image_generation",
  sub_agent_activity: "spawn_agent",
  sleep: "sleep",
};

export class CodexStreamTranslator {
  private seq = 0;
  private current: LiveMessage | null = null;
  /** item.id → 已开启的工具调用（tool_end 配对 + 防重复 tool_start） */
  private readonly toolOwners = new Map<string, { messageId: string; dto: ToolCallDto }>();
  private sawTurnEnd = false;
  /** 每轮至多一条 error（top-level error 与 turn.failed 带同一错误，防重复弹） */
  private errorEmitted = false;

  /** 是否已收到轮终态（进程退出兜底判断用） */
  get finished(): boolean {
    return this.sawTurnEnd;
  }

  /** stdin 一行 → 契约 WS 事件（未识别行返回 []） */
  feed(line: string): ServerEvent[] {
    const trimmed = line.trim();
    if (trimmed === "") return [];
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      return []; // 非 JSON 行跳过
    }
    if (!isRecord(row) || typeof row.type !== "string") return [];

    switch (row.type) {
      case "thread.started":
      case "turn.started":
      case "task_started":
        return [{ type: "status", status: "running" }];
      case "user_message":
        return []; // 适配层已合成 user 消息（-p 同口径），跳过回显防重复气泡
      case "agent_message": {
        const text = itemText(row);
        if (text === "") return [];
        return this.upsertMessage(text);
      }
      case "agent_message_content_delta": {
        const delta = typeof row.delta === "string" ? row.delta : typeof row.text === "string" ? row.text : "";
        if (delta === "") return [];
        return this.upsertMessage(delta, true);
      }
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = row.item;
        if (!isRecord(item)) return [];
        return this.handleItem(row.type, item);
      }
      case "task_complete":
      case "turn.completed": {
        return this.settle("idle");
      }
      case "turn_aborted": {
        return this.settle("idle"); // 用户中止：进程可能还活着，UI 先恢复可输入
      }
      case "turn.failed": {
        const err = row.error;
        const detail = isRecord(err) && typeof err.message === "string" ? err.message : typeof row.message === "string" ? row.message : "";
        return this.settle("error", detail);
      }
      case "error": {
        const detail = typeof row.message === "string" ? row.message : "";
        if (this.errorEmitted) return [];
        this.errorEmitted = true;
        // 只发错误消息；status/agent_settled 由随后的 turn.failed 等终态统一发（每轮一条）
        return [{ type: "error", code: ErrorCodes.PROMPT_FAILED, message: truncateText(detail === "" ? "codex 运行失败" : detail, 500) }];
      }
      default:
        // token_count / reasoning* / plan_delta / hook_* / session_configured 等：跳过
        return [];
    }
  }

  /** 进程退出（未收到轮终态）时的兜底 flush */
  flush(): ServerEvent[] {
    const events: ServerEvent[] = [];
    const ended = this.endMessage();
    if (ended) events.push(ended);
    return events;
  }

  // ---- 内部 ----

  /** 当前消息文本更新（delta 为 true 时 text 是增量）；无消息则懒开一条 */
  private upsertMessage(text: string, isDelta = false): ServerEvent[] {
    const events: ServerEvent[] = [];
    if (!this.current) {
      this.seq += 1;
      const id = `live-${this.seq}-${Date.now()}`;
      this.current = { id, timestamp: Date.now(), text: "", toolCalls: [] };
      events.push({ type: "message_start", message: { id, role: "assistant", timestamp: this.current.timestamp } });
    }
    if (isDelta) {
      this.current.text += text;
      events.push({ type: "text_delta", messageId: this.current.id, delta: text });
    } else {
      // 全文事件：覆盖累计文本（可能与 delta 交替出现，取权威全文）
      this.current.text = text;
    }
    return events;
  }

  private handleItem(eventType: string, item: Record<string, unknown>): ServerEvent[] {
    const itemType = typeof item.type === "string" ? item.type : "";
    const itemId = typeof item.id === "string" ? item.id : "";
    if (itemType === "agent_message") {
      if (eventType === "item.started") {
        // 新消息条目：先收尾可能未关的上一条，再开新消息（不发空 delta）
        const events: ServerEvent[] = [];
        const ended = this.endMessage();
        if (ended) events.push(ended);
        events.push(...this.upsertMessage(""));
        return events;
      }
      if (eventType === "item.updated") {
        return this.applyItemText(item);
      }
      // item.completed：权威全文收尾
      const text = itemText(item);
      const events: ServerEvent[] = text === "" ? [] : this.upsertMessage(text);
      const ended = this.endMessage();
      if (ended) events.push(ended);
      return events;
    }
    const toolName = TOOL_ITEM_NAMES[itemType];
    if (toolName === undefined) return []; // user_message/reasoning/error 等条目：跳过
    if (eventType === "item.updated") return [];
    const existing = itemId !== "" ? this.toolOwners.get(itemId) : undefined;
    if (eventType === "item.started") {
      if (existing) return []; // 同一 item 不重复 tool_start
      const started: ServerEvent[] = [];
      this.startTool(itemId, toolName, item, started);
      return started;
    }
    // item.completed
    const events: ServerEvent[] = [];
    const owner = existing ?? this.startTool(itemId, toolName, item, events);
    const preview = truncateText(itemResultText(item), RESULT_PREVIEW_LIMIT);
    owner.dto.status = itemFailed(item) ? "error" : "done";
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
    return events;
  }

  /** 开启工具调用（挂到当前 assistant 消息；无消息则建空消息承接，与解析层同口径） */
  private startTool(
    itemId: string,
    name: string,
    item: Record<string, unknown>,
    events: ServerEvent[] = [],
  ): { messageId: string; dto: ToolCallDto } {
    if (!this.current) {
      this.seq += 1;
      const id = `live-${this.seq}-${Date.now()}`;
      this.current = { id, timestamp: Date.now(), text: "", toolCalls: [] };
      events.push({ type: "message_start", message: { id, role: "assistant", timestamp: this.current.timestamp } });
    }
    const summary = toolSummary(name, item);
    const dto: ToolCallDto = { name, summary, status: "running", resultPreview: null };
    this.current.toolCalls.push(dto);
    const owner = { messageId: this.current.id, dto };
    if (itemId !== "") this.toolOwners.set(itemId, owner);
    events.push({ type: "tool_start", messageId: this.current.id, toolCall: { name, summary } });
    return owner;
  }

  /** item.updated 的 agent_message 文本增长 → text_delta（无 content_delta 事件的版本兜底） */
  private applyItemText(item: Record<string, unknown>): ServerEvent[] {
    const text = itemText(item);
    if (text === "" || !this.current) return [];
    if (text === this.current.text) return [];
    const delta = text.startsWith(this.current.text) ? text.slice(this.current.text.length) : text;
    this.current.text = text;
    return [{ type: "text_delta", messageId: this.current.id, delta }];
  }

  /** 轮终态：兜底收尾 + status + agent_settled */
  private settle(status: "idle" | "error", detail = ""): ServerEvent[] {
    this.sawTurnEnd = true;
    const events: ServerEvent[] = [];
    const ended = this.endMessage();
    if (ended) events.push(ended);
    if (status === "error" && !this.errorEmitted) {
      this.errorEmitted = true;
      events.push({
        type: "error",
        code: ErrorCodes.PROMPT_FAILED,
        message: truncateText(detail === "" ? "codex 运行失败" : detail, 500),
      });
    }
    events.push({ type: "status", status });
    events.push({ type: "agent_settled" });
    return events;
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
      // 快照克隆：后续工具结果不得回写已发出去的 message_end payload
      toolCalls: current.toolCalls.map((t) => ({ ...t })),
    };
    return { type: "message_end", message: dto };
  }
}

/** item/事件 → 文本（message/text/content 三形态兜底：字段名随版本漂移） */
function itemText(item: Record<string, unknown>): string {
  if (typeof item.message === "string") return item.message;
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) {
    const parts: string[] = [];
    for (const block of item.content) {
      if (isRecord(block) && typeof block.text === "string") parts.push(block.text);
    }
    return parts.join("\n");
  }
  return "";
}

/** 工具结果文本（aggregated_output/stdout/output 兜底，stderr 补尾） */
function itemResultText(item: Record<string, unknown>): string {
  for (const key of ["aggregated_output", "output", "stdout", "result"]) {
    const v = item[key];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  if (typeof item.stderr === "string" && item.stderr.trim() !== "") return item.stderr;
  return "";
}

/** 工具摘要（command_execution 用 command，其余走 args 摘要同口径） */
function toolSummary(name: string, item: Record<string, unknown>): string {
  if (typeof item.command === "string") {
    return summarizeToolCall(name, { command: item.command });
  }
  const args = isRecord(item.arguments) ? item.arguments : {};
  return summarizeCodexToolCall(name, args, typeof item.input === "string" ? item.input : "");
}

/** 工具失败判定：status:"failed" 或 exit_code 非 0（无字段视为成功） */
function itemFailed(item: Record<string, unknown>): boolean {
  if (item.status === "failed") return true;
  const exit = item.exit_code;
  return typeof exit === "number" && exit !== 0;
}
