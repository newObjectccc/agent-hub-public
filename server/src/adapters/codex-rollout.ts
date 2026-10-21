/**
 * Codex rollout（~/.codex/sessions/YYYY/MM/DD/rollout-<ISO时间>-<uuid>.jsonl）解析。
 *
 * ── 调研结论（2026-10-09，基于本机 codex-cli 0.130~0.159 真实 rollout + 0.143 实测）──
 * 1. 目录布局：`~/.codex/sessions/YYYY/MM/DD/rollout-<ISO 时间>-<session-uuid>.jsonl`，
 *    桌面 app 与 CLI 共享此目录；会话文件可达数百个，列表扫描必须走 mtime 快照缓存
 *    （见 scanCodexSessions）。归档会话在平铺的 `~/.codex/archived_sessions/
 *    rollout-*.jsonl`（与 sessions/ 同级，非日期子目录）：扫描合并进列表，标
 *    `archived: true` 并排列表尾部（scanCodexSessions options.archivedDir）。
 *    ⚠️ 分段坑（实测）：同一会话可跨多个 rollout 文件（续写/压缩后轮转新文件，段内只含
 *    新增轮次）：命名 `rollout-<ts>-<uuid>[_<uuid2>].jsonl` 或换新实例 uuid 的普通命名，
 *    段内 session_meta.session_id 始终是同一会话 id（文件名 uuid 可能只是实例 id）。
 *    故会话身份一律以 session_meta 为准，列表/详情按 id 归并分段（groupCodexSegments）。
 * 2. 一行一个 JSON：`{timestamp, ordinal?, type, payload}`。顶层 type 至少有：
 *    - `session_meta`：payload 含 `session_id`/`id`（同一 uuid）、`timestamp`、`cwd`、
 *      `originator`（codex-tui/codex_exec/codex_work_desktop）、`cli_version`
 *    - `response_item`：消息与工具调用（见下）
 *    - `event_msg`：app/CLI 的活动流（见 2.1）
 *    - `token_usage_record`：每次 API 调用的 token 用量（见 2.2）
 *    - `compacted`：上下文压缩边界（见 2.3）
 *    - `turn_context` / `world_state`：上下文快照，跳过
 *    未识别 type 一律优雅跳过。
 * 2.1. `event_msg`（实测桌面 app rollout 占比最大的行）payload.type 有 item_completed /
 *    task_started / task_complete / token_count / turn_aborted / thread_settings_applied。
 *    其中 `item_completed` 的 `payload.item` 是活动流（桌面 app 的「正在运行命令/已读取
 *    文件」来源）：`CommandExecution`（shell 命令，`parsed_cmd` 带语义 read/write…、
 *    path、cmd；`command` 为 ["/bin/zsh","-lc","<shell>"]；status completed/failed；
 *    stdout/stderr）、`FileChange`（apply_patch 结果，changes: {path: {type,
 *    unified_diff}}）、`McpToolCall`（server/tool/arguments/status/result）、`Extension`
 *    （kind:"web.search"、query）。这些映射为活动 toolCalls 折叠进所属 assistant
 *    （与 pi/claude 的工具活动同口径，见 activityFromEventPayload）；Reasoning /
 *    AgentMessage / UserMessage / ImageView / ContextCompaction 与 response_item
 *    重复或非活动，跳过；其余 event_msg（生命周期）不进 chat。
 * 2.2. `token_usage_record` payload.usage 是**本次调用**用量（input_tokens /
 *    cached_input_tokens / cache_write_input_tokens / output_tokens /
 *    reasoning_output_tokens / total_tokens），逐条求和即会话总量（与 pi 的
 *    message.usage 同口径）；turn_token_usage / thread_token_usage 是累计值，不求和。
 *    事件流里的 token_count 是同数据的 UI 快照，不重复计数。
 * 2.3. `compacted`：上下文压缩边界（payload.replacement_history 是压缩后的上下文快照，
 *    与压缩前已解析的 response_item 重复，**不再解析为消息**）。识别到边界时清空
 *    call_id 折叠状态（防 output 归并跨越压缩点挂错 assistant），并插一条 `[context
 *    compacted]` 轻量 custom 条目（与 pi 的 compaction 条目同口径）。
 * 3. `response_item` payload.type === "message"：`{role:"user"|"assistant"|"developer",
 *    content:[{type:"input_text"|"output_text"|"input_image", text|image_url}], phase?}`。
 *    - developer 角色是注入的指令/上下文（permissions instructions、AGENTS.md…），跳过
 *    - user 角色混有注入上下文包装（`<environment_context>`、`# Files mentioned by
 *      the user:…## My request:` 等），真实输入经 cleanUserText 剥离（详见函数注释）
 *    - assistant 的 phase（commentary/final_answer）都是可见输出，全部渲染；
 *      assistant 行先于其工具调用出现（实测确认），工具折叠进「最近一条 assistant」
 * 4. 工具调用两套形态（实测确认字段名）：
 *    - `function_call`：`{name:"exec_command"…, arguments:"<JSON 字符串>", call_id}` +
 *      `function_call_output`：`{call_id, output: string | block[]}`（block[] 常见
 *      input_image，取 text 块作文本预览）
 *    - `custom_tool_call`：`{name:"apply_patch"/"exec"…, input:"<自由文本>", call_id,
 *      status}` + `custom_tool_call_output`：`{call_id, output}`
 *    call_id 配对折叠进所属 assistant 消息的 toolCalls；孤儿 output 转 toolResult 消息。
 * 5. 时间戳：行 timestamp 为 ISO 8601；updatedAtMs 取最后一条合法时间。
 * 6. 会话名索引：`~/.codex/session_index.jsonl` 每行 `{id, thread_name, updated_at}`，
 *    列表页 name 优先取这里（parseCodexSessionIndex），缺失回退首条 user 文本。
 * ─────────────────────────────────────────────────────────────────────────
 */
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MessageDto, MessageImage, SessionListItem, ToolCallDto, ToolCallStatus } from "../types.js";
import type { UsageSample } from "../usage.js";
import {
  LAST_MESSAGE_LIMIT,
  MAX_MESSAGE_IMAGES,
  RESULT_PREVIEW_LIMIT,
  isSubAgentName,
  summarizeToolCall,
  truncateText,
} from "../sessions/scan.js";

/**
 * rollout 文件名：`rollout-<ISO 时间>-<uuid>[_<uuid>].jsonl`。
 * 尾部 `_<uuid>` 是同一会话的续写分段标记（实测：段内只含新增轮次）。
 */
const CODEX_ROLLOUT_FILE_RE = /^rollout-.+-[0-9a-f-]{36}(_[0-9a-f-]{36})?\.jsonl$/i;

export function isCodexRolloutFileName(name: string): boolean {
  return CODEX_ROLLOUT_FILE_RE.test(name);
}

/**
 * 文件名 → 首个 uuid（`<uuid>[_<uuid2>]` 取第一个）；仅作 session_meta 缺失时的兜底，
 * 会话身份的真源是 session_meta.session_id（实测存在文件名 uuid ≠ session_id 的段）。
 */
export function sessionIdFromRolloutFileName(name: string): string | null {
  const base = name.replace(/\.jsonl$/i, "");
  const withoutPrefix = base.startsWith("rollout-") ? base.slice("rollout-".length) : base;
  const main = withoutPrefix.split("_")[0];
  const uuid = main.slice(-36);
  return /^[0-9a-f-]{36}$/i.test(uuid) && main.endsWith(`-${uuid}`) ? uuid.toLowerCase() : null;
}

/** 短 hash（FNV-1a 32bit）：分段文件 → 稳定消息 id 前缀（单文件/归并解析 id 一致） */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 文件路径 → 消息 id 前缀（同文件无论单段解析还是归并解析，id 都一致） */
export function idPrefixForFile(file: string): string {
  return shortHash(file.split("/").pop() ?? file);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * user 角色里的注入上下文前缀（非用户输入，不进 chat 渲染）：
 * 环境快照 / AGENTS.md 注入 / 中断通知 / 插件推荐 / 内部上下文等（实测枚举）。
 */
const USER_META_TEXT_PREFIXES = [
  "<environment_context>",
  "<in-app-browser-context",
  "<turn_aborted>",
  "<recommended_plugins>",
  "<send_user_message_question_reply>",
  "<external_codex_apps_open_page>",
  "<codex_internal_context",
  "# AGENTS.md instructions",
  "# Files mentioned by the user:",
  "# Files pasted by the user:",
  "<image_resize_notice>",
];

function isMetaText(text: string): boolean {
  const t = text.trimStart();
  return USER_META_TEXT_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * 用户真实输入分隔标记（两种拼写，实测均存在）：
 * 注入包装（files mentioned / in-app-browser-context…）与真实输入以
 * `## My request:` / `## My request for Codex:` 分隔，取标记之后的部分。
 * 取首个出现位置——用户正文若引用该标记字符串，保留完整正文不被截断。
 */
const USER_REQUEST_MARKER_RE = /## My request(?: for Codex)?:/;

/** 图片声明标签（`<image name=[Image #1]>…</image>`），只是图片占位声明，剥掉（图走 images） */
const IMAGE_TAG_RE = /<\/?image\b[^>]*>/g;

/** 纯图消息的占位文本（与 pi/claude 同口径） */
const IMAGE_PLACEHOLDER = "[image]";

export interface ParsedCodexRollout {
  /** 按文件顺序排列的消息（工具折叠进所属 assistant 后） */
  messages: MessageDto[];
  /** token_usage_record 采样（每次 API 调用一条，逐条求和即会话用量） */
  usageSamples: UsageSample[];
  /** session_meta 的 session_id/id（同 uuid）；缺失时 null */
  sessionId: string | null;
  /** session_meta 的 cwd */
  cwd: string | null;
  /** 首条真实 user 文本（截断）；无 user 消息时 null（列表层优先用索引名覆盖） */
  name: string | null;
  /** 最后一条有合法 timestamp 的行时间（毫秒）；无则 null */
  updatedAtMs: number | null;
}

/**
 * rollout 内容 → 会话消息（纯函数）。
 * 不识别的行/块优雅跳过；损坏行跳过；绝不抛错（风格照 claude-transcript.ts）。
 */
export function parseCodexRollout(
  content: string,
  fallback: { sessionId?: string; cwd?: string; name?: string; idPrefix?: string } = {},
): ParsedCodexRollout {
  let sessionId: string | null = fallback.sessionId ?? null;
  let cwd: string | null = fallback.cwd ?? null;
  let name: string | null = fallback.name ?? null;
  let updatedAtMs: number | null = null;
  const messages: MessageDto[] = [];
  const usageSamples: UsageSample[] = [];
  // call_id → 所属 assistant 消息的 toolCall DTO（折叠 output 用）
  const toolCallOwners = new Map<string, ToolCallDto>();
  // 当前 assistant 消息（最近一条 user 之后）：工具调用/活动折叠进它；无则新建空消息承接
  let currentAssistant: MessageDto | null = null;
  let activeTurnId: string | null = null;
  let autoId = 0;

  const nextId = (prefix: string): string => {
    autoId += 1;
    // idPrefix = 文件级稳定前缀（idPrefixForFile）：同一文件在单段解析/归并解析下 id 一致，
    // 多段合并后全局唯一（tail 增量与全量加载不会因 id 漂移重复气泡）
    return fallback.idPrefix ? `codex-${fallback.idPrefix}-${prefix}-${autoId}` : `codex-${prefix}-${autoId}`;
  };

  /** 当前 assistant（无则建空消息承接工具/活动，与 pi/claude 同口径） */
  const ensureAssistant = (ts: number, turnId = activeTurnId): MessageDto => {
    if (currentAssistant === null || (turnId && currentAssistant.turnId && currentAssistant.turnId !== turnId)) {
      currentAssistant = { id: nextId("asst"), role: "assistant", timestamp: ts, text: "", toolCalls: [], ...(turnId ? { turnId } : {}) };
      messages.push(currentAssistant);
    }
    return currentAssistant;
  };

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue; // 损坏行跳过
    }
    if (!isRecord(row) || typeof row.type !== "string") continue;

    if (typeof row.timestamp === "string") {
      const t = Date.parse(row.timestamp);
      if (!Number.isNaN(t)) updatedAtMs = t;
    }
    const timestamp = typeof row.timestamp === "string" ? Date.parse(row.timestamp) || 0 : 0;

    if (row.type === "session_meta") {
      const payload = isRecord(row.payload) ? row.payload : {};
      const id = typeof payload.session_id === "string" ? payload.session_id : typeof payload.id === "string" ? payload.id : "";
      if (id !== "") sessionId = id;
      if (typeof payload.cwd === "string" && payload.cwd !== "" && cwd === null) cwd = payload.cwd;
      continue;
    }
    if (row.type === "turn_context") {
      const turnId = isRecord(row.payload) ? nonemptyTurnId(row.payload.turn_id) : null;
      if (turnId !== null) {
        if (activeTurnId !== turnId) currentAssistant = null;
        activeTurnId = turnId;
      }
      continue;
    }
    // event_msg.item_completed：app/CLI 活动流（正在运行命令/已读取文件…）→ 活动 toolCalls
    if (row.type === "event_msg") {
      const payload = isRecord(row.payload) ? row.payload : {};
      if (payload.type === "task_started") {
        activeTurnId = nonemptyTurnId(payload.turn_id);
        currentAssistant = null;
      }
      const activity = activityFromEventPayload(row.payload);
      if (activity !== null) ensureAssistant(timestamp, nonemptyTurnId(payload.turn_id) ?? activeTurnId).toolCalls.push(activity);
      if ((payload.type === "task_complete" || payload.type === "turn_aborted")
        && (!nonemptyTurnId(payload.turn_id) || payload.turn_id === activeTurnId)) {
        activeTurnId = null;
        currentAssistant = null;
      }
      continue;
    }
    // token_usage_record：每次 API 调用的 token 用量采样（usage 体系逐条求和）
    if (row.type === "token_usage_record") {
      const sample = usageSampleFromTokenUsageRow(row);
      if (sample !== null) usageSamples.push(sample);
      continue;
    }
    // compacted：上下文压缩边界（replacement_history 是压缩后上下文快照，与压缩前已解析的
    // response_item 重复，不再解析）——清空 call_id 折叠状态防 output 归并跨压缩点挂错，
    // 并插一条与 pi 同口径的 `[context compacted]` 轻量条目标记边界（消息连续性可见）
    if (row.type === "compacted") {
      toolCallOwners.clear();
      currentAssistant = null;
      messages.push({ id: nextId("compacted"), role: "custom", timestamp, text: "[context compacted]", toolCalls: [] });
      continue;
    }
    // world_state 等上下文快照不进 chat 渲染。
    if (row.type !== "response_item") continue;

    const payload = row.payload;
    if (!isRecord(payload)) continue;
    // 对应导出 schema 的 ResponseItem.InternalChatMessageMetadataPassthrough。
    const metadata = isRecord(payload.internal_chat_message_metadata_passthrough) ? payload.internal_chat_message_metadata_passthrough : {};
    const messageTurnId = nonemptyTurnId(metadata.turn_id) ?? activeTurnId;

    switch (payload.type) {
      case "message": {
        const role = payload.role;
        const contentBlocks = payload.content;
        if (role === "developer") break; // 注入的指令/上下文，不是对话
        if (role === "user") {
          const text = extractUserText(contentBlocks);
          const images = extractUserImages(contentBlocks);
          if (text === "" && images === null) break;
          messages.push({
            id: nextId("user"),
            role: "user",
            timestamp,
            text: text === "" ? IMAGE_PLACEHOLDER : text,
            toolCalls: [],
            ...(messageTurnId ? { turnId: messageTurnId } : {}),
            ...(images ? { images } : {}),
          });
          currentAssistant = null;
          // name 兜底：首条真实 user 文本（列表层优先用 session_index 的 thread_name 覆盖）
          if (name === null && text !== "") name = truncateText(text, LAST_MESSAGE_LIMIT);
          break;
        }
        if (role === "assistant") {
          const text = joinTextBlocks(contentBlocks).trim();
          // 不展示空 analysis/plan 占位；后续真实工具会按需创建自己的承接消息，
          // 保留仅有工具调用的轮次。
          if (text === "") {
            currentAssistant = null;
            break;
          }
          const dto: MessageDto = {
            id: nextId("asst"),
            role: "assistant",
            timestamp,
            text,
            toolCalls: [],
            ...(messageTurnId ? { turnId: messageTurnId } : {}),
          };
          messages.push(dto);
          currentAssistant = dto;
        }
        break;
      }
      case "function_call":
      case "custom_tool_call": {
        const name2 = codexToolName(payload);
        // function_call.arguments 是 JSON 字符串；custom_tool_call.input 是自由文本（patch 等）
        const raw = typeof payload.arguments === "string" ? payload.arguments : typeof payload.input === "string" ? payload.input : "";
        const args = raw === "" ? {} : tryParseJson(raw);
        const call: ToolCallDto = {
          name: name2,
          summary: summarizeCodexToolCall(name2, args, raw),
          status: "pending",
          resultPreview: null,
        };
        ensureAssistant(timestamp, messageTurnId).toolCalls.push(call);
        const callId = typeof payload.call_id === "string" ? payload.call_id : "";
        if (callId !== "") toolCallOwners.set(callId, call);
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const preview = truncateText(outputToText(payload.output), RESULT_PREVIEW_LIMIT);
        const callId = typeof payload.call_id === "string" ? payload.call_id : "";
        const owner = toolCallOwners.get(callId);
        if (owner) {
          // output 无 is_error 字段（实测 key 集仅 call_id/output）：成功/失败都 done，报错文本在预览里
          owner.status = "done";
          owner.resultPreview = preview === "" ? null : preview;
        } else {
          // 孤儿 output：保留为 toolResult 消息（与 pi/claude 同口径）
          messages.push({
            id: nextId("toolresult"),
            role: "toolResult",
            timestamp,
            text: preview,
            toolCalls: [],
            ...(messageTurnId ? { turnId: messageTurnId } : {}),
          });
        }
        break;
      }
      default:
        // reasoning / agent_message（子代理消息）/ web_search_call / tool_search_call 等：契约不承载，跳过
        break;
    }
  }

  return { messages, usageSamples, sessionId, cwd, name, updatedAtMs };
}

function nonemptyTurnId(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

// ---------- event_msg 活动映射（实测结构见文件头 2.1） ----------

/** 命令输出文本（stdout/stderr 是 string；宽容取值） */
function outputText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * event_msg.payload → 活动 toolCall（对齐 pi/claude 的工具活动语义，折叠进所属 assistant）。
 * 只认 item_completed 的活动项；其余（生命周期 / Reasoning / AgentMessage / UserMessage /
 * ImageView / ContextCompaction 等，与 response_item 重复或非活动）返回 null 不进 chat。
 */
export function activityFromEventPayload(payload: unknown): ToolCallDto | null {
  if (!isRecord(payload) || payload.type !== "item_completed") return null;
  const item = payload.item;
  if (!isRecord(item)) return null;
  // item_completed 是完成事件：failed → error，其余 → done
  const status: ToolCallStatus = item.status === "failed" ? "error" : "done";
  switch (item.type) {
    case "CommandExecution":
      return commandExecutionActivity(item, status);
    case "FileChange":
      return fileChangeActivity(item, status);
    case "McpToolCall":
      return mcpToolCallActivity(item, status);
    case "Extension":
      return extensionActivity(item, status);
    default:
      return null;
  }
}

/**
 * CommandExecution → 活动：parsed_cmd[0] 带语义（read/write…、path、cmd）取语义工具名 + 路径
 * （「read_file /path/file」即「已读取文件」语义，工具名对齐 pi 口径）；无 parsed_cmd / 未知
 * 语义退化为 type 原文或 exec_command + shell 文本。预览取 stdout（失败取 stderr）。
 */
function commandExecutionActivity(item: Record<string, unknown>, status: ToolCallStatus): ToolCallDto {
  const parsed = Array.isArray(item.parsed_cmd) ? item.parsed_cmd.filter(isRecord) : [];
  const first = parsed[0];
  const cmdType = first !== undefined && typeof first.type === "string" && first.type !== "" ? first.type : "";
  // 语义工具名（pi 口径）：read/write/delete → read_file/write_file/delete_file；未知 type 原文；无 → exec_command
  const name =
    cmdType === "read"
      ? "read_file"
      : cmdType === "write" || cmdType === "edit" || cmdType === "apply"
        ? "write_file"
        : cmdType === "delete"
          ? "delete_file"
          : cmdType !== ""
            ? cmdType
            : "exec_command";
  const cmdText = first !== undefined && typeof first.cmd === "string" ? first.cmd : "";
  const path =
    first !== undefined && typeof first.path === "string" && first.path !== ""
      ? first.path
      : first !== undefined && typeof first.name === "string"
        ? first.name
        : "";
  const shell = Array.isArray(item.command) ? item.command.filter((c): c is string => typeof c === "string") : [];
  const shellText = shell.length > 0 ? shell[shell.length - 1] : "";
  const summary = name === "exec_command" ? shellText || cmdText : path || cmdText || shellText;
  const preview = status === "error" ? outputText(item.stderr) || outputText(item.stdout) : outputText(item.stdout);
  return {
    name,
    summary: truncateText(summary, LAST_MESSAGE_LIMIT),
    status,
    resultPreview: truncateText(preview, RESULT_PREVIEW_LIMIT) || null,
  };
}

/** FileChange → 活动：changes 的文件路径（含 create/update/delete 类型）摘要 */
function fileChangeActivity(item: Record<string, unknown>, status: ToolCallStatus): ToolCallDto {
  const changes = isRecord(item.changes) ? item.changes : {};
  const parts: string[] = [];
  for (const [path, change] of Object.entries(changes)) {
    if (parts.length >= 5) {
      parts.push("…");
      break;
    }
    const kind = isRecord(change) && typeof change.type === "string" ? change.type : "update";
    parts.push(`${path} (${kind})`);
  }
  return {
    name: "apply_patch",
    summary: truncateText(parts.join(", "), LAST_MESSAGE_LIMIT),
    status,
    resultPreview: truncateText(outputText(item.stdout), RESULT_PREVIEW_LIMIT) || null,
  };
}

/** McpToolCall → 活动：tool 名（如 linear.list_projects）+ 参数共用摘要 + result 文本预览 */
function mcpToolCallActivity(item: Record<string, unknown>, status: ToolCallStatus): ToolCallDto {
  const name = typeof item.tool === "string" && item.tool !== "" ? item.tool : "mcp_tool";
  const preview = isRecord(item.result) ? joinTextBlocks(item.result.content) : "";
  return {
    name,
    summary: summarizeToolCall(name, item.arguments),
    status,
    resultPreview: truncateText(preview, RESULT_PREVIEW_LIMIT) || null,
  };
}

/** Extension → 活动：kind（如 web.search）+ query 摘要（results 是预览素材，不入折叠卡） */
function extensionActivity(item: Record<string, unknown>, status: ToolCallStatus): ToolCallDto {
  const name = typeof item.kind === "string" && item.kind !== "" ? item.kind : "extension";
  return {
    name,
    summary: truncateText(typeof item.query === "string" ? item.query : "", LAST_MESSAGE_LIMIT),
    status,
    resultPreview: null,
  };
}

// ---------- token_usage_record 用量采样（实测结构见文件头 2.2） ----------

function numField(source: Record<string, unknown>, key: string): number {
  const v = source[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * token_usage_record 行 → 一次 API 调用的 usage 采样（字段映射对齐 pi 的 message.usage）。
 * 只取 payload.usage（本次调用）；turn_token_usage / thread_token_usage 是累计值不求和。
 */
export function usageSampleFromTokenUsageRow(row: unknown): UsageSample | null {
  if (!isRecord(row) || row.type !== "token_usage_record") return null;
  const payload = isRecord(row.payload) ? row.payload : {};
  const usage = payload.usage;
  if (!isRecord(usage)) return null;
  const t = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
  return {
    timestampMs: Number.isNaN(t) ? 0 : t,
    totalTokens: numField(usage, "total_tokens"),
    input: numField(usage, "input_tokens"),
    output: numField(usage, "output_tokens"),
    cacheRead: numField(usage, "cached_input_tokens"),
    cacheWrite: numField(usage, "cache_write_input_tokens"),
    reasoning: numField(usage, "reasoning_output_tokens"),
    costTotal: null,
  };
}

/** rollout 内容 → 会话用量采样（UsageService 增量重读的轻量解析，不构建消息） */
export interface CodexUsageFile {
  sessionId: string | null;
  /** 首条真实 user 文本（截断）；无则 null */
  name: string | null;
  samples: UsageSample[];
}

/**
 * rollout 内容 → 用量采样（只看 session_meta / 首条 user / token_usage_record 行）。
 * 会话身份以 session_meta 为准（文件名 uuid 兜底由调用方传入）；坏行优雅跳过绝不抛错。
 */
export function parseCodexUsageFile(content: string, fallbackSessionId?: string): CodexUsageFile {
  let sessionId: string | null = fallbackSessionId ?? null;
  let name: string | null = null;
  const samples: UsageSample[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(row) || typeof row.type !== "string") continue;
    if (row.type === "session_meta") {
      const payload = isRecord(row.payload) ? row.payload : {};
      const id = typeof payload.session_id === "string" ? payload.session_id : typeof payload.id === "string" ? payload.id : "";
      if (id !== "") sessionId = id;
      continue;
    }
    if (row.type === "token_usage_record") {
      const sample = usageSampleFromTokenUsageRow(row);
      if (sample !== null) samples.push(sample);
      continue;
    }
    if (row.type === "response_item" && name === null) {
      const payload = row.payload;
      if (isRecord(payload) && payload.type === "message" && payload.role === "user") {
        const text = extractUserText(payload.content);
        if (text !== "") name = truncateText(text, LAST_MESSAGE_LIMIT);
      }
    }
  }
  return { sessionId, name, samples };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text; // arguments 非法 JSON：原样作文本摘要
  }
}

/** ResponseItem 的 namespace 与 name 分开保存；仅保留真实字段，不猜别名。 */
export function codexToolName(payload: Record<string, unknown>): string {
  const name = typeof payload.name === "string" && payload.name !== "" ? payload.name : "unknown";
  const namespace = typeof payload.namespace === "string" ? payload.namespace : "";
  return namespace !== "" && !name.startsWith(`${namespace}.`) ? `${namespace}.${name}` : name;
}

/**
 * 工具调用摘要（scan.summarizeToolCall 同口径）：
 * exec_command 的参数键是 `cmd`（不是 command），先归一化再走共用摘要。
 * input 为自由文本（apply_patch 的 patch 等）时直接截断。
 */
export function summarizeCodexToolCall(name: string, args: unknown, raw: string): string {
  if (typeof args === "string") return truncateText(args, LAST_MESSAGE_LIMIT);
  if (isRecord(args)) {
    const normalized: Record<string, unknown> = { ...args };
    if (typeof normalized.command !== "string" && typeof normalized.cmd === "string") {
      normalized.command = normalized.cmd;
    }
    return summarizeToolCall(name, normalized);
  }
  return raw === "" ? name : truncateText(raw, LAST_MESSAGE_LIMIT);
}

/** output（string | block[]）→ 文本（block[] 常见 input_image，只取带 text 的块） */
function outputToText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return joinTextBlocks(output);
  if (isRecord(output) && typeof output.text === "string") return output.text;
  return "";
}

/** content blocks → 拼接文本（带 string text 的块；input_text/output_text/text 通吃） */
function joinTextBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * user 消息 content → 真实用户输入文本：
 * 1. 拼接 input_text 块
 * 2. 剥掉 `<image name=…>` 图片声明标签（图走 images 通道）
 * 3. 有 `## My request[:| for Codex:]` 标记 → 取标记之后（之前的 files mentioned /
 *    in-app-browser-context 等是注入包装）
 * 4. meta 前缀消息（environment_context 等）→ 空串（调用方跳过）
 */
function extractUserText(content: unknown): string {
  let text = joinTextBlocks(content).replace(IMAGE_TAG_RE, "");
  const marker = USER_REQUEST_MARKER_RE.exec(text);
  if (marker) text = text.slice(marker.index + marker[0].length);
  text = text.trim();
  return isMetaText(text) ? "" : text;
}

/** user 消息 content → 内嵌图片（input_image.image_url data URL，与 pi ImageContent 同口径） */
function extractUserImages(content: unknown): MessageImage[] | null {
  if (!Array.isArray(content)) return null;
  const out: MessageImage[] = [];
  for (const block of content) {
    if (out.length >= MAX_MESSAGE_IMAGES) break;
    if (!isRecord(block)) continue;
    if ((block.type === "input_image" || block.type === "image") && typeof block.image_url === "string") {
      out.push({ url: block.image_url, alt: null });
    }
  }
  return out.length > 0 ? out : null;
}

/** 与 pi/claude 同口径的列表摘要：lastUser/lastAssistant，截断 120 字符 */
export function codexSummaries(messages: MessageDto[]): {
  lastUserMessage: string | null;
  lastAssistantMessage: string | null;
} {
  let lastUserMessage: string | null = null;
  let lastAssistantMessage: string | null = null;
  for (const m of messages) {
    const text = truncateText(m.text, LAST_MESSAGE_LIMIT);
    if (text === "") continue;
    if (m.role === "user") lastUserMessage = text;
    else if (m.role === "assistant") lastAssistantMessage = text;
  }
  return { lastUserMessage, lastAssistantMessage };
}

/** rollout 内容 → 会话列表项（status 由调用方注入；name 优先 session_index 索引名） */
export function buildCodexSessionSummary(
  file: string,
  content: string,
  mtimeMs: number,
  fallback: { sessionId?: string; name?: string; cwd?: string } = {},
): Omit<SessionListItem, "status"> | null {
  const parsed = parseCodexRollout(content, { ...fallback, idPrefix: idPrefixForFile(file) });
  const id = parsed.sessionId ?? fallback.sessionId ?? null;
  if (id === null) return null;
  const { lastUserMessage, lastAssistantMessage } = codexSummaries(parsed.messages);
  const updatedMs = parsed.updatedAtMs ?? mtimeMs;
  return {
    id,
    source: "codex",
    name: parsed.name,
    cwd: parsed.cwd ?? fallback.cwd ?? "",
    updatedAt: new Date(updatedMs).toISOString(),
    messageCount: parsed.messages.length,
    lastUserMessage,
    lastAssistantMessage,
    sessionFile: file,
    // codex 子代理（agent_message）与主消息同存一个 rollout，无独立会话文件父子关系 →
    // 仅按命名规则判定（与 pi/claude 的轻量判定同口径），恒无父会话
    isSubAgent: isSubAgentName(parsed.name),
    parentSessionId: null,
  };
}

/** rollout 文件 → 消息 DTO 列表（tail / 单段详情共用） */
export async function loadCodexSessionMessages(file: string): Promise<MessageDto[]> {
  const fallbackSessionId = sessionIdFromRolloutFileName(file.split("/").pop() ?? "") ?? undefined;
  const parsed = parseCodexRollout(await readFileText(file), {
    sessionId: fallbackSessionId,
    idPrefix: idPrefixForFile(file),
  });
  return parsed.messages;
}

/**
 * 同一会话的全部分段文件（按时间顺序）→ 完整消息列表：
 * 段内只含新增轮次（实测），必须按序归并才能拼出完整历史；
 * 每段用文件级 id 前缀（与 tail 单文件解析的 id 一致）。
 */
export async function loadCodexSessionMessagesForFiles(files: string[]): Promise<MessageDto[]> {
  const out: MessageDto[] = [];
  for (const file of files) {
    out.push(...(await loadCodexSessionMessages(file)));
  }
  return out;
}

/** session_index.jsonl → sessionId → thread_name（同 id 多行取最后一行 = 最新命名） */
export function parseCodexSessionIndex(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const row = JSON.parse(trimmed) as unknown;
      if (!isRecord(row)) continue;
      const { id, thread_name: threadName } = row;
      if (typeof id === "string" && typeof threadName === "string" && threadName.trim() !== "") {
        map.set(id, threadName.trim());
      }
    } catch {
      // 忽略坏行
    }
  }
  return map;
}

export async function loadCodexSessionIndex(indexFile: string): Promise<Map<string, string>> {
  try {
    return parseCodexSessionIndex(await readFile(indexFile, "utf8"));
  } catch {
    return new Map(); // 文件不存在/不可读：空映射
  }
}

/** session_index.jsonl 单行（createSession/forkSession 登记会话名用） */
export function buildSessionIndexLine(id: string, threadName: string, updatedAtIso: string): string {
  return `${JSON.stringify({ id, thread_name: threadName, updated_at: updatedAtIso })}\n`;
}

/**
 * 新建会话的最小 rollout 内容（仅一条 session_meta）：
 * 实测（codex-cli 0.143）`codex exec resume <id> --json` 能识别这种合成文件
 * （thread.started 带该 id），比 `codex exec` 起新会话更稳——后者依赖模型服务可用
 * 且生成的 session id 无法预知（列表/跳转需要）。与 claude 写空白 transcript 同思路。
 * base_instructions 填最小占位指令（resume 一般用当前配置指令；万一回放占位也不劣化）。
 *
 * ── codex 0.162 起的最小字段集（真机逐字段剔除实验，详见 codex-version.ts 头注）──
 * 缺 `cli_version` → thread/resume 与 exec resume 都报 -32603 "rollout is empty"；
 * 缺 `model_provider` → -32600 "Model provider `` not found"。二者必填（调用方经
 * resolveCodexNewSessionMeta 探测/采样获得，绝不写死假值）。`ordinal`/`source`/
 * `runtime_workspace_roots`/`git`/`history_mode` 非必需但照真实产物写齐（降低未来
 * 版本挑剔风险）；history_mode 写 "legacy" 而非 "paginated"：0.143 与 0.162 都能读
 * legacy，paginated 在 0.143 上会 -32601。creator_user_id/creator_account_id/
 * context_window 非必需且涉及账号信息，不伪造（安全口径：不读凭据）。
 */
export function buildCodexNewRollout(options: {
  sessionId: string;
  cwd: string;
  timestamp: string;
  /** 必填：探测/采样所得的真实 codex 版本号（缺失会让 codex 0.162 拒绝 resume） */
  cliVersion: string;
  /** 必填：已有会话采样所得 provider，采样不到回落 "openai"（缺失 → -32600） */
  modelProvider: string;
  originator?: string;
}): string {
  const row = {
    timestamp: options.timestamp,
    ordinal: 0, // 真实产物顶层带段内序号，照写
    type: "session_meta",
    payload: {
      session_id: options.sessionId,
      id: options.sessionId,
      timestamp: options.timestamp,
      cwd: options.cwd,
      runtime_workspace_roots: [options.cwd],
      originator: options.originator ?? "agent-hub",
      cli_version: options.cliVersion,
      source: "cli",
      model_provider: options.modelProvider,
      thread_source: "user",
      base_instructions: { text: "You are Codex, a coding agent." },
      history_mode: "legacy",
      git: {},
    },
  };
  return `${JSON.stringify(row)}\n`;
}

/**
 * fork 用：行内 session 标识同步替换（原文件只读）。
 * 只替换值 === oldId 的 `id`/`session_id`/`thread_id` 字段——call_id、item id
 * 等其它 id 一律不动（历史可解析）；损坏行原样保留（解析层本就跳过）。
 */
export function rewriteCodexRolloutIds(content: string, oldId: string, newId: string): string {
  const outLines: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let row: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) row = parsed as Record<string, unknown>;
    } catch {
      row = null;
    }
    if (row === null) {
      outLines.push(trimmed); // 损坏行原样保留
      continue;
    }
    replaceIdFields(row, oldId, newId);
    if (isRecord(row.payload)) replaceIdFields(row.payload, oldId, newId);
    outLines.push(JSON.stringify(row));
  }
  return `${outLines.join("\n")}\n`;
}

function replaceIdFields(obj: Record<string, unknown>, oldId: string, newId: string): void {
  for (const key of ["id", "session_id", "thread_id"]) {
    if (obj[key] === oldId) obj[key] = newId;
  }
}

/** 逐行流式读取（大 rollout 不整包进 V8 大字符串） */
async function readFileText(file: string): Promise<string> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolvePromise());
    stream.on("error", rejectPromise);
  });
  return Buffer.concat(chunks).toString("utf8");
}

/** 单文件解析缓存条目（mtime+size 快照，未变的文件不重复 parse） */
export interface CodexFileCacheEntry {
  mtimeMs: number;
  size: number;
  summary: Omit<SessionListItem, "status">;
}

/** 分段归并输入：单个 rollout 文件的摘要 */
export interface CodexSegmentEntry {
  file: string;
  summary: Omit<SessionListItem, "status">;
}

/** 归并结果：一个会话 = 全部分段（按时间序）+ 合并摘要 */
export interface CodexSessionGroup {
  summary: Omit<SessionListItem, "status">;
  /** 按时间顺序排列的分段文件（末尾是最新段，tail/后续写入所在） */
  files: string[];
}

/**
 * 分段归并（纯函数）：同一 session id 的多个 rollout 段合成一个会话。
 * 合并口径：updatedAt 取最新段；messageCount 求和；lastUser/lastAssistant 从新到旧
 * 取第一个非空（只展示最近一轮输入/输出）；name/cwd 取最早段（首条 user 文本在那里）；
 * sessionFile 指向最新段（tail/后续追加都在最新段文件）。
 */
export function groupCodexSegments(entries: CodexSegmentEntry[]): CodexSessionGroup[] {
  const byId = new Map<string, CodexSegmentEntry[]>();
  for (const entry of entries) {
    const list = byId.get(entry.summary.id);
    if (list) list.push(entry);
    else byId.set(entry.summary.id, [entry]);
  }
  const groups: CodexSessionGroup[] = [];
  for (const list of byId.values()) {
    list.sort((a, b) => Date.parse(a.summary.updatedAt) - Date.parse(b.summary.updatedAt));
    const first = list[0].summary;
    const last = list[list.length - 1].summary;
    let lastUserMessage: string | null = null;
    let lastAssistantMessage: string | null = null;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const s = list[i].summary;
      if (lastUserMessage === null && s.lastUserMessage !== null) lastUserMessage = s.lastUserMessage;
      if (lastAssistantMessage === null && s.lastAssistantMessage !== null) lastAssistantMessage = s.lastAssistantMessage;
    }
    let name: string | null = null;
    for (const { summary } of list) {
      if (summary.name !== null) {
        name = summary.name;
        break;
      }
    }
    groups.push({
      summary: {
        ...first,
        name,
        updatedAt: last.updatedAt,
        messageCount: list.reduce((n, s) => n + s.summary.messageCount, 0),
        lastUserMessage,
        lastAssistantMessage,
        sessionFile: last.sessionFile,
        // 任一分段在归档目录 → 整会话视为归档（归档是会话级操作）
        archived: list.some((s) => s.summary.archived === true),
      },
      files: list.map((s) => s.file),
    });
  }
  return groups;
}

/**
 * 扫描 ~/.codex/sessions/（递归找 rollout-*.jsonl，目录不存在/不可读 → 空列表）。
 * options.archivedDir：归档目录（~/.codex/archived_sessions/，平铺）一并扫描，
 * 来自归档目录的段标 `archived: true`（列表标注 + 排尾）。
 * options.cache：mtime+size 快照缓存——数百个会话文件不重复全量 parse（防全量读盘）；
 * 8 路并发解析；同一会话的多个分段归并为一条（groupCodexSegments）。
 * 返回 items（列表）+ segments（id → 时间序分段文件，详情/消息全量加载用）。
 */
export async function scanCodexSessions(
  sessionsDir: string,
  sessionIndex: Map<string, string> = new Map(),
  options: {
    statusOf?: (id: string, updatedMs: number) => SessionListItem["status"];
    cache?: Map<string, CodexFileCacheEntry>;
    archivedDir?: string;
  } = {},
): Promise<{ items: SessionListItem[]; segments: Map<string, string[]> }> {
  const files = await findCodexSessionFiles(sessionsDir);
  const archivedFiles = options.archivedDir ? await findCodexSessionFiles(options.archivedDir) : [];
  const archivedSet = new Set(archivedFiles);
  const allFiles = [...files, ...archivedFiles];
  const entries: CodexSegmentEntry[] = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < allFiles.length; i += CONCURRENCY) {
    const batch = allFiles.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (file): Promise<CodexSegmentEntry | null> => {
        try {
          const fileStat = await stat(file);
          const cached = options.cache?.get(file);
          let summary: Omit<SessionListItem, "status"> | null;
          if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
            summary = cached.summary;
          } else {
            const content = await readFileText(file);
            summary = buildCodexSessionSummary(file, content, fileStat.mtimeMs, {
              sessionId: sessionIdFromRolloutFileName(file.split("/").pop() ?? "") ?? undefined,
            });
            if (summary !== null && archivedSet.has(file)) summary = { ...summary, archived: true };
            if (summary && options.cache) {
              options.cache.set(file, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, summary });
            }
          }
          return summary ? { file, summary } : null;
        } catch {
          return null; // 单个文件损坏不影响其它会话
        }
      }),
    );
    for (const entry of results) {
      if (entry) entries.push(entry);
    }
  }
  const items: SessionListItem[] = [];
  const segments = new Map<string, string[]>();
  for (const group of groupCodexSegments(entries)) {
    // name 优先 session_index 的 thread_name，缺失回退首条 user 文本（解析层已回退）
    const indexName = sessionIndex.get(group.summary.id);
    const item: SessionListItem = {
      ...group.summary,
      name: indexName !== undefined && indexName !== "" ? indexName : group.summary.name,
      status: options.statusOf ? options.statusOf(group.summary.id, Date.parse(group.summary.updatedAt)) : "idle",
    };
    item.isSubAgent = isSubAgentName(item.name);
    items.push(item);
    segments.set(group.summary.id, group.files);
  }
  items.sort((a, b) => {
    // 归档会话排列表尾部（方案自定：标注 + 尾部），组内仍按 updatedAt 倒序
    const archivedRank = (s: SessionListItem): number => (s.archived === true ? 1 : 0);
    const ra = archivedRank(a);
    const rb = archivedRank(b);
    if (ra !== rb) return ra - rb;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
  return { items, segments };
}

/** sessions 目录递归找 rollout 文件（限深 4：sessions/YYYY/MM/DD/file，防意外深目录拖慢） */
export async function findCodexSessionFiles(sessionsDir: string): Promise<string[]> {
  const results: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) await walk(full, depth - 1);
      } else if (entry.isFile() && isCodexRolloutFileName(entry.name)) {
        results.push(full);
      }
    }
  };
  await walk(sessionsDir, 3);
  return results;
}
