/**
 * Claude Code transcript（~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl）解析。
 *
 * ── 调研结论（2026-09-29，基于本机 claude 2.1.267 真实数据）──────────────────
 * 1. 目录布局：`~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`。
 *    encoded-cwd 把 cwd 的 `/`、`.`、`&` 等非字母数字字符统一换成 `-`（有损，不能可靠反解），
 *    如 `/Users/me/Workspace/demo` → `-Users-me-Workspace-demo`。
 *    同目录还混有非会话文件（`skill-injections.jsonl`、`memory/`、`<uuid>/` 子目录等），
 *    必须排除：只认 `<uuid>.jsonl` 文件名 + 至少一条 user/assistant 行。
 * 2. 一行一个 JSON 对象。观测到的顶层 type：
 *    - `user` / `assistant` / `attachment` / `system`（subtype: turn_duration/away_summary/informational）
 *    - 元数据行：`mode`、`permission-mode`、`atis-latch`、`last-prompt`、`ai-title`、
 *      `queue-operation`、`cost-state`、`file-history-snapshot`、`file-history-delta`
 *    - 另有 `summary`（会话压缩/分支摘要，样本未见但按契约兼容映射）
 *    未识别 type 一律优雅跳过。
 * 3. `user` 行：`message.content` 是 string（人类输入）或 block 数组
 *    （`text` / `image` / `tool_result`）。工具结果行内容为
 *    `[{tool_use_id, type:"tool_result", content, is_error}]`，并带 `toolUseResult`、
 *    `sourceToolAssistantUUID`。`isMeta`/`turnCompanion` 行是命令回显、任务通知等
 *    元消息（`<command-name>`、`<local-command-stdout>`、`<task-notification>`…），跳过。
 * 4. `assistant` 行：**每个 content block 一行**（`apiBlockIndex` 递增），
 *    `message.id`（msg_…）相同的多行属于同一条 API 消息，
 *    block 类型：`thinking` / `text` / `tool_use`。需按 `message.id` 聚合为一条 DTO。
 * 5. `tool_use.id`（call_…/toolu…）与后续 `user` 行 `tool_result.tool_use_id` 配对，
 *    折叠进对应 assistant 消息的 `toolCalls[]`（与 pi 契约一致）。
 * 6. 时间戳：每行 `timestamp` 为 ISO 8601（如 2026-09-29T09:17:33.525Z）。
 * 7. cwd 事实源是每行的 `cwd` 字段（user/assistant 行都有）；目录名反解仅兜底，
 *    `~/.claude/history.jsonl`（{display,timestamp,project,sessionId}）可作 sessionId→cwd 补充。
 * 8. 会话名：`ai-title` 行的 `aiTitle` 字段；`last-prompt` 行有最近一次用户输入。
 * ─────────────────────────────────────────────────────────────────────────
 */
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { MessageDto, SessionListItem, ToolCallDto } from "../types.js";
import { MAX_ATTACHMENTS_PER_MESSAGE, uploadRootsFor } from "../uploads.js";
import { isClaudeMetaText } from "./claude-message.js";
import {
  LAST_MESSAGE_LIMIT,
  RESULT_PREVIEW_LIMIT,
  contentToImages,
  contentToText,
  hasSubAgentPreambleMarker,
  isSubAgentName,
  summarizeToolCall,
  truncateText,
} from "../sessions/scan.js";

/** 会话文件名：严格 UUID + .jsonl（排除 skill-injections.jsonl 等非会话文件） */
const CLAUDE_SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

export function isClaudeSessionFileName(name: string): boolean {
  return CLAUDE_SESSION_FILE_RE.test(name);
}

/**
 * cwd → ~/.claude/projects 子目录名（claude 自身的有损编码：非字母数字 → `-`）。
 * 实测（claude 2.1.267）：`/tmp/claude-newtest-cwd` → `-tmp-claude-newtest-cwd`。
 * 有损（不同 cwd 可能撞名），仅用于与 claude CLI 同口径定位会话目录。
 */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** image block → 占位文本（契约 MessageDto.text 只承载文本；真图走 MessageDto.images） */
const IMAGE_PLACEHOLDER = "[image]";

/** 旧版 PWA 只写 @上传路径：Read 的图片结果可补回原用户气泡，不把其它读图结果当附件。 */
function referencesUploadedImage(text: string, input: unknown, cwd: string | null): boolean {
  if (!isRecord(input)) return false;
  const path = typeof input.file_path === "string" ? input.file_path : input.path;
  if (typeof path !== "string") return false;
  const target = resolve(cwd ?? "", path);
  if (!uploadRootsFor(cwd).some((root) => target.startsWith(resolve(root) + sep))) return false;
  const relativePath = cwd ? relative(cwd, target).split(sep).join("/") : path;
  return [path, relativePath, `./${relativePath}`].some((ref) => {
    const token = `@${ref}`;
    const start = text.indexOf(token);
    return start >= 0 && (start === 0 || /[\s(（]/u.test(text[start - 1]))
      && (start + token.length === text.length || /[\s)）。，,]/u.test(text[start + token.length]));
  });
}

export interface ParsedClaudeTranscript {
  sessionId: string | null;
  cwd: string | null;
  name: string | null;
  /** 按首次出现顺序排列的消息（assistant 聚合后） */
  messages: MessageDto[];
  /** 最后一条有合法 timestamp 的行时间（毫秒）；无则 null */
  updatedAtMs: number | null;
  /** 前 10 条 system/attachment 行文本（子代理结构标记检测用） */
  preamble: string;
  /** Task 子代理（sidechain）活动记录，按开启顺序排列 */
  subAgents: ParsedClaudeSubAgent[];
}

/** claude Task 子代理（sidechain）活动记录：子代理面板聚合用（解析副产物） */
export interface ParsedClaudeSubAgent {
  /** Task tool_use.id（call_…/toolu…） */
  id: string;
  /** 子代理类型（subagent_type），如 Explore / general-purpose */
  type: string;
  /** 任务描述（description，缺省取 prompt 首行） */
  description: string;
  /** sidechain 内当前/最近工具 summary（无则 null） */
  currentTool: string | null;
  /** currentTool 是否仍在执行（tool_use 后未见对应 tool_result） */
  toolRunning: boolean;
  /** sidechain 最新 assistant 文本（截断交给聚合层） */
  lastOutput: string | null;
  /** Task tool_result 结果文本（完成态） */
  resultSummary: string | null;
  /** Task tool_result 是否报错 */
  error: boolean;
  startedAtMs: number | null;
  updatedAtMs: number | null;
  done: boolean;
}

/**
 * transcript 内容 → 会话消息（纯函数）。
 * 不识别的行/块优雅跳过；损坏行跳过；绝不抛错。
 */
export function parseClaudeTranscript(
  content: string,
  fallback: { sessionId?: string; cwd?: string } = {},
): ParsedClaudeTranscript {
  let sessionId: string | null = fallback.sessionId ?? null;
  let cwd: string | null = fallback.cwd ?? null;
  let name: string | null = null;
  let updatedAtMs: number | null = null;
  const preambleParts: string[] = [];
  const messages: MessageDto[] = [];
  // tool_use.id → 所属 assistant 消息的 toolCall DTO（折叠 tool_result 用）
  const toolCallOwners = new Map<string, ToolCallDto>();
  const uploadImageOwners = new Map<string, MessageDto>();
  let latestUser: MessageDto | undefined;
  // message.id → 聚合中的 assistant DTO（同一条 API 消息的多个 block 行）
  const assistantAgg = new Map<string, MessageDto>();
  let autoId = 0;
  // Task 子代理（sidechain）活动记录：Task tool_use 开、tool_result 关；sidechain 行归属最近 open 的记录
  const subAgents: ParsedClaudeSubAgent[] = [];
  const subAgentByToolId = new Map<string, ParsedClaudeSubAgent>();
  let openSubAgent: ParsedClaudeSubAgent | null = null;

  const nextId = (prefix: string): string => {
    autoId += 1;
    return `${prefix}-${autoId}`;
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

    if (typeof row.sessionId === "string" && row.sessionId !== "") sessionId = row.sessionId;
    if (typeof row.cwd === "string" && row.cwd !== "" && cwd === null) cwd = row.cwd;
    if (typeof row.timestamp === "string") {
      const t = Date.parse(row.timestamp);
      if (!Number.isNaN(t)) updatedAtMs = t;
    }

    // 前 10 条 system/attachment 行的文本 → preamble（子代理结构标记检测，pi/claude 同口径）
    if ((row.type === "system" || row.type === "attachment") && preambleParts.length < 10) {
      const text =
        (typeof row.content === "string" && row.content) ||
        (typeof row.text === "string" && row.text) ||
        (typeof row.message === "string" && row.message) ||
        "";
      if (text !== "") preambleParts.push(text);
    }

    switch (row.type) {
      case "ai-title": {
        // 最新一条为当前名；显式空串 = 清空名字（rename 清空时写入空 aiTitle 行）
        if (typeof row.aiTitle === "string") {
          const n = row.aiTitle.trim();
          name = n === "" ? null : n;
        }
        break;
      }
      case "summary": {
        // 压缩/分支摘要 → role custom（与 pi 的 branch_summary 口径一致）
        const summary = typeof row.summary === "string" ? row.summary : "";
        messages.push({
          id: typeof row.uuid === "string" ? row.uuid : nextId("summary"),
          role: "custom",
          timestamp: Date.parse(String(row.timestamp ?? "")) || updatedAtMs || 0,
          text: `[summary] ${summary}`,
          toolCalls: [],
        });
        break;
      }
      case "user": {
        if (row.isMeta === true || row.turnCompanion === true) break;
        const message = row.message;
        if (!isRecord(message)) break;
        const contentBlocks = message.content;
        const timestamp = typeof row.timestamp === "string" ? Date.parse(row.timestamp) || 0 : 0;
        if (row.isSidechain === true) {
          // sidechain 行（Task 子代理内部）：喂给当前子代理记录，不进主消息流
          if (Array.isArray(contentBlocks)) feedSubAgentUser(openSubAgent, contentBlocks, timestamp);
          break;
        }

        if (typeof contentBlocks === "string") {
          const text = contentBlocks.trim();
          if (text === "" || isClaudeMetaText(text)) break;
          messages.push({
            id: typeof row.uuid === "string" ? row.uuid : nextId("user"),
            role: "user",
            timestamp,
            text: contentBlocks,
            toolCalls: [],
          });
          latestUser = messages[messages.length - 1];
          break;
        }
        if (!Array.isArray(contentBlocks)) break;

        const textParts: string[] = [];
        let sawToolResult = false;
        for (const block of contentBlocks) {
          if (!isRecord(block)) continue;
          if (block.type === "tool_result" || typeof block.tool_use_id === "string") {
            sawToolResult = true;
            const toolCallId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
            const owner = toolCallOwners.get(toolCallId);
            const preview = truncateText(contentToText(block.content), RESULT_PREVIEW_LIMIT);
            const isError = block.is_error === true;
            if (owner) {
              owner.status = isError ? "error" : "done";
              owner.resultPreview = preview === "" ? null : preview;
            } else {
              // 孤儿 tool_result：保留为 toolResult 消息（与 pi 口径一致）
              messages.push({
                id: typeof row.uuid === "string" ? row.uuid : nextId("toolresult"),
                role: "toolResult",
                timestamp,
                text: preview,
                toolCalls: [],
              });
            }
            const imageOwner = uploadImageOwners.get(toolCallId);
            if (imageOwner && !isError) {
              const images = contentToImages(block.content);
              if (images?.length) {
                const byUrl = new Map([...(imageOwner.images ?? []), ...images].map((image) => [image.url, image]));
                imageOwner.images = [...byUrl.values()].slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
              }
            }
            // Task 子代理结果：同为一条 tool_result，随手关闭对应活动记录
            const sub = subAgentByToolId.get(toolCallId);
            if (sub) {
              sub.done = true;
              sub.error = isError;
              sub.resultSummary = preview === "" ? null : preview;
              sub.toolRunning = false;
              if (timestamp > 0) sub.updatedAtMs = timestamp;
            }
            continue;
          }
          if (block.type === "text" && typeof block.text === "string" && !isClaudeMetaText(block.text)) {
            textParts.push(block.text);
          }
        }
        // image block → MessageDto.images（data URL），与 pi ImageContent 同口径
        const images = contentToImages(contentBlocks) ?? undefined;
        const extra = images ? { images } : {};
        const text = textParts.join("\n").trim();
        if (text !== "" && !isClaudeMetaText(text)) {
          messages.push({
            id: typeof row.uuid === "string" ? row.uuid : nextId("user"),
            role: "user",
            timestamp,
            text: textParts.join("\n"),
            toolCalls: [],
            ...extra,
          });
          latestUser = messages[messages.length - 1];
        } else if (images && !sawToolResult) {
          messages.push({
            id: typeof row.uuid === "string" ? row.uuid : nextId("user"),
            role: "user",
            timestamp,
            text: IMAGE_PLACEHOLDER,
            toolCalls: [],
            ...extra,
          });
          latestUser = messages[messages.length - 1];
        }
        break;
      }
      case "assistant": {
        const message = row.message;
        if (!isRecord(message)) break;
        const timestamp = typeof row.timestamp === "string" ? Date.parse(row.timestamp) || 0 : 0;
        if (row.isSidechain === true) {
          // sidechain 行（Task 子代理内部）：喂给当前子代理记录，不进主消息流
          if (Array.isArray(message.content)) feedSubAgentAssistant(openSubAgent, message.content, timestamp);
          break;
        }
        const blocks = Array.isArray(message.content) ? message.content : [];
        const apiMessageId = typeof message.id === "string" && message.id !== "" ? message.id : typeof row.uuid === "string" ? row.uuid : nextId("asst");
        let dto = assistantAgg.get(apiMessageId);
        if (!dto) {
          dto = {
            id: apiMessageId,
            role: "assistant",
            timestamp,
            text: "",
            toolCalls: [],
          };
          assistantAgg.set(apiMessageId, dto);
          messages.push(dto);
        }
        const textParts: string[] = [];
        if (dto.text !== "") textParts.push(dto.text);
        for (const block of blocks) {
          if (!isRecord(block)) continue;
          if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
          } else if (block.type === "tool_use") {
            const toolName = typeof block.name === "string" && block.name !== "" ? block.name : "unknown";
            const call: ToolCallDto = {
              name: toolName,
              summary: summarizeToolCall(toolName, block.input),
              status: "pending",
              resultPreview: null,
            };
            dto.toolCalls.push(call);
            if (typeof block.id === "string") {
              toolCallOwners.set(block.id, call);
              if (toolName === "Read" && latestUser && referencesUploadedImage(latestUser.text, block.input, cwd)) {
                uploadImageOwners.set(block.id, latestUser);
              }
            }
            // Task/Agent 工具 = 开启一个子代理活动记录（sidechain 行随后归入）
            if (/^(task|agent)$/i.test(toolName)) {
              const record = createSubAgentRecord(block, dto.timestamp);
              subAgents.push(record);
              if (record.id !== "") subAgentByToolId.set(record.id, record);
              openSubAgent = record;
            }
          }
          // thinking 等其它 block：跳过（契约 MessageDto 不承载 thinking）
        }
        dto.text = textParts.join("\n");
        break;
      }
      default:
        // mode / permission-mode / atis-latch / last-prompt / queue-operation / cost-state /
        // file-history-* / system / attachment 等：不进 chat 渲染，优雅跳过
        break;
    }
  }

  return { sessionId, cwd, name, messages, updatedAtMs, preamble: preambleParts.join("\n"), subAgents };
}

/** Task/Agent tool_use → 子代理活动记录 */
function createSubAgentRecord(block: Record<string, unknown>, timestampMs: number): ParsedClaudeSubAgent {
  const input = isRecord(block.input) ? block.input : {};
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const desc = typeof input.description === "string" && input.description.trim() !== ""
    ? input.description.trim()
    : prompt.trim().split("\n")[0] ?? "";
  return {
    id: typeof block.id === "string" ? block.id : "",
    type: typeof input.subagent_type === "string" && input.subagent_type !== "" ? input.subagent_type : "agent",
    description: desc,
    currentTool: null,
    toolRunning: false,
    lastOutput: null,
    resultSummary: null,
    error: false,
    startedAtMs: timestampMs > 0 ? timestampMs : null,
    updatedAtMs: timestampMs > 0 ? timestampMs : null,
    done: false,
  };
}

/** sidechain assistant 行 → 子代理的当前工具 / 最新输出 */
function feedSubAgentAssistant(
  sub: ParsedClaudeSubAgent | null,
  blocks: unknown[],
  timestampMs: number,
): void {
  if (sub === null) return;
  if (timestampMs > 0) sub.updatedAtMs = timestampMs;
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
      sub.lastOutput = block.text;
    } else if (block.type === "tool_use") {
      const name = typeof block.name === "string" && block.name !== "" ? block.name : "unknown";
      const summary = summarizeToolCall(name, block.input);
      sub.currentTool = summary !== "" ? summary : name;
      sub.toolRunning = true;
    }
  }
}

/** sidechain user 行 → 子代理工具结果（保守口径：见 tool_result 即视为当前工具已结束） */
function feedSubAgentUser(
  sub: ParsedClaudeSubAgent | null,
  blocks: unknown[],
  timestampMs: number,
): void {
  if (sub === null) return;
  if (timestampMs > 0) sub.updatedAtMs = timestampMs;
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block.type === "tool_result" || typeof block.tool_use_id === "string") {
      sub.toolRunning = false;
    }
  }
}

/** transcript 文件 → 子代理活动记录（子代理面板；文件缺失/解析失败回空数组） */
export async function loadClaudeSubAgents(file: string): Promise<ParsedClaudeSubAgent[]> {
  try {
    const content = await readFileText(file);
    return parseClaudeTranscript(content).subAgents;
  } catch {
    return [];
  }
}

/** 与 pi 口径一致的列表摘要：lastUser/lastAssistant 从映射后消息取，截断 120 字符 */
export function claudeSummaries(messages: MessageDto[]): { lastUserMessage: string | null; lastAssistantMessage: string | null } {
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

/** transcript 内容 → 会话列表项（status 由调用方注入） */
export function buildClaudeSessionSummary(
  file: string,
  content: string,
  mtimeMs: number,
  fallback: { sessionId?: string; cwd?: string } = {},
): Omit<SessionListItem, "status"> | null {
  const parsed = parseClaudeTranscript(content, fallback);
  if (parsed.sessionId === null) return null;
  const { lastUserMessage, lastAssistantMessage } = claudeSummaries(parsed.messages);
  const updatedMs = parsed.updatedAtMs ?? mtimeMs;
  return {
    id: parsed.sessionId,
    source: "claude",
    name: parsed.name,
    cwd: parsed.cwd ?? "",
    updatedAt: new Date(updatedMs).toISOString(),
    messageCount: parsed.messages.length,
    lastUserMessage,
    lastAssistantMessage,
    sessionFile: file,
    // 与 pi 判定同口径：命名规则 `<type>#<hex>` 或 preamble 结构标记（消息正文提及不算）
    isSubAgent: isSubAgentName(parsed.name) || hasSubAgentPreambleMarker(parsed.preamble),
    // claude 子代理（Task sidechain）与主消息同存一个 transcript，无独立会话文件父子关系；
    // transcript 头也无 parent 字段 → 恒 null（前端归"未归组子代理"兜底分组）
    parentSessionId: null,
  };
}

/** 逐行流式读取 */
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

/** 文件名 → 兜底 sessionId（行内无 sessionId 字段时用 UUID 文件名） */
function fallbackSessionIdOf(file: string): string | undefined {
  return file.split("/").pop()?.replace(/\.jsonl$/i, "") ?? undefined;
}

/** transcript 文件 → 消息 DTO 列表（tail / 详情共用） */
export async function loadClaudeSessionMessages(file: string): Promise<MessageDto[]> {
  const parsed = parseClaudeTranscript(await readFileText(file), { sessionId: fallbackSessionIdOf(file) });
  return parsed.messages;
}

/**
 * 扫描 ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl（仅两层，排除 memory/、子目录等）。
 * 目录不存在/不可读 → 空列表（不是错误）。
 */
export async function findClaudeSessionFiles(projectsDir: string): Promise<string[]> {
  const results: string[] = [];
  let projectDirs;
  try {
    projectDirs = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    let files;
    try {
      files = await readdir(join(projectsDir, dir.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.isFile() && isClaudeSessionFileName(f.name)) {
        results.push(join(projectsDir, dir.name, f.name));
      }
    }
  }
  return results;
}

/** ~/.claude/history.jsonl → sessionId → project(cwd) 映射（cwd 兜底补充） */
export function parseClaudeHistoryIndex(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const row = JSON.parse(trimmed) as unknown;
      if (!isRecord(row)) continue;
      const { sessionId, project } = row;
      if (typeof sessionId === "string" && typeof project === "string" && !map.has(sessionId)) {
        map.set(sessionId, project);
      }
    } catch {
      // 忽略坏行
    }
  }
  return map;
}

export async function loadClaudeHistoryIndex(historyFile: string): Promise<Map<string, string>> {
  try {
    return parseClaudeHistoryIndex(await readFile(historyFile, "utf8"));
  } catch {
    return new Map(); // 文件不存在/不可读：空映射
  }
}

// ---------- per-file 派生快照缓存（清单扫描性能修复）----------
//
// 背景（实测本机 ~/.claude/projects：49 个会话文件 / 75MB）：旧 scanClaudeSessions
// 每遍都 stat + 全量读 + 全量 parse（346-450ms/遍，rss 峰值 ~300MB），且完全无缓存；
// 会话活跃时 presence watcher（500ms debounce）持续失效 ClaudeAdapter 的 5s listCache
// → 反复整表重扫（持续 ~7% CPU + ~29MB/s 磁盘读）。
//
// 现按 pi 侧 sessions/scan.ts 的 loadSessionSnapshot 口径做 per-file 增量快照：
// mtime+size 未变的文件零读盘零 parse，直接复用已构建的 summary。
//
// 与 pi 侧的两点刻意差异（pi 侧的已知缺陷，勿回抄）：
// 1. 缓存**按 projectsDir 分键**。pi 侧是模块级全局 Map + 「本次调用扫到的文件集」prune，
//    两个不同目录交替扫描会互相清空缓存（实测 cacheHits=0、每轮退化成全量冷扫）。
//    这里 prune 只清理本目录内消失的文件，别的目录条目不受影响。
// 2. 带 LRU 上限（条目数 / 覆盖源字节 / 目录数）。~/.claude/projects 随使用一直涨，
//    只靠 prune 不足以界定内存。
//
// 缓存里**只放文件派生的静态部分**：status（statusOf 注入的运行态）与 history.jsonl
// 的 cwd 兜底都是「每次调用可能不同」的输入，一律在返回时现算，绝不进缓存。

/** 单个 transcript 文件的派生快照（不含任何运行态字段） */
export interface ClaudeFileSnapshot {
  mtimeMs: number;
  /** 源文件字节数：变更判定 + LRU 体量计量 */
  size: number;
  /**
   * 文件派生的静态摘要（cwd 为行内原值，未做 history 兜底）。
   * null = 该文件派生不出会话（防御口径：扫描路径下 sessionId 总能用文件名 UUID 兜底，
   * 只有直接调用本函数且文件名兜不出 id 时出现）—— null 同样缓存，避免反复重读。
   */
  summary: Omit<SessionListItem, "status"> | null;
}

/** 缓存 IO 计数（基准固化 + 自检用；口径对齐 pi 侧 SessionCacheStats） */
export interface ClaudeCacheStats {
  /** 读盘（读文件全文）次数 */
  fileReads: number;
  /** transcript parse 次数 */
  fileParses: number;
  /** per-file 快照命中次数 */
  cacheHits: number;
  /** LRU 淘汰条目数（非 0 说明上限偏小，热扫会退化为部分重读） */
  evictions: number;
  /** prune 清掉的条目数（文件被删/改名） */
  pruned: number;
}

/** 缓存上限（可注入：测试用小上限验证淘汰；生产按语料规模放宽） */
export interface ClaudeCacheLimits {
  /** 单目录快照条目上限 */
  maxEntriesPerDir: number;
  /** 单目录快照覆盖的源文件总字节上限（快照自身很轻，这里按源语料体量做代理约束） */
  maxBytesPerDir: number;
  /** 同时保留的 projectsDir 上限（生产恒为 1，测试会建多个临时目录） */
  maxDirs: number;
}

const DEFAULT_CACHE_LIMITS: ClaudeCacheLimits = {
  maxEntriesPerDir: 512,
  maxBytesPerDir: 192 * 1024 * 1024,
  maxDirs: 64,
};

let cacheLimits: ClaudeCacheLimits = { ...DEFAULT_CACHE_LIMITS };
const stats = { fileReads: 0, fileParses: 0, cacheHits: 0, evictions: 0, pruned: 0 };

/**
 * 单目录的快照 LRU：Map 迭代序 = 最久未用在前（命中时重插到末尾即 touch）。
 * 超限从最久未用端淘汰，防 ~/.claude/projects 无界增长导致缓存无界。
 */
class DirSnapshotCache {
  private readonly files = new Map<string, ClaudeFileSnapshot>();
  private bytes = 0;

  get size(): number {
    return this.files.size;
  }

  get(file: string): ClaudeFileSnapshot | undefined {
    const hit = this.files.get(file);
    if (hit === undefined) return undefined;
    this.files.delete(file);
    this.files.set(file, hit); // LRU touch
    return hit;
  }

  set(file: string, snap: ClaudeFileSnapshot): void {
    const prev = this.files.get(file);
    if (prev !== undefined) {
      this.files.delete(file);
      this.bytes -= prev.size;
    }
    this.files.set(file, snap);
    this.bytes += snap.size;
    while (this.files.size > cacheLimits.maxEntriesPerDir || this.bytes > cacheLimits.maxBytesPerDir) {
      const oldest = this.files.keys().next();
      if (oldest.done === true) break;
      this.delete(oldest.value);
      stats.evictions += 1;
    }
  }

  delete(file: string): boolean {
    const prev = this.files.get(file);
    if (prev === undefined) return false;
    this.files.delete(file);
    this.bytes -= prev.size;
    return true;
  }

  /** 清理本次扫描未见到的文件（被删/改名）；返回清理条数 */
  prune(seen: ReadonlySet<string>): number {
    let removed = 0;
    for (const file of [...this.files.keys()]) {
      if (!seen.has(file) && this.delete(file)) removed += 1;
    }
    return removed;
  }
}

/** projectsDir → 该目录的快照 LRU（目录级同样按 LRU 序，超上限整目录淘汰） */
const dirCaches = new Map<string, DirSnapshotCache>();

function dirCacheFor(projectsDir: string): DirSnapshotCache {
  const key = resolve(projectsDir);
  const hit = dirCaches.get(key);
  if (hit !== undefined) {
    dirCaches.delete(key);
    dirCaches.set(key, hit); // 目录级 LRU touch
    return hit;
  }
  const created = new DirSnapshotCache();
  dirCaches.set(key, created);
  while (dirCaches.size > cacheLimits.maxDirs) {
    const oldest = dirCaches.keys().next();
    if (oldest.done === true) break;
    const evicted = dirCaches.get(oldest.value);
    dirCaches.delete(oldest.value);
    stats.evictions += evicted ? evicted.size : 0;
  }
  return created;
}

export function claudeCacheStats(): ClaudeCacheStats {
  return { ...stats };
}

/** 当前缓存上限（自检用） */
export function claudeCacheLimits(): ClaudeCacheLimits {
  return { ...cacheLimits };
}

/**
 * 调整缓存上限（测试用小上限验证淘汰；缺省值见 DEFAULT_CACHE_LIMITS）。
 * 只影响后续写入的淘汰判定，不立即裁剪已有条目。
 */
export function setClaudeCacheLimits(patch: Partial<ClaudeCacheLimits>): ClaudeCacheLimits {
  cacheLimits = { ...cacheLimits, ...patch };
  return { ...cacheLimits };
}

/** 清空全部 claude 会话快照缓存与计数（并复位上限；测试基准/自检用） */
export function resetClaudeSessionCaches(): void {
  dirCaches.clear();
  cacheLimits = { ...DEFAULT_CACHE_LIMITS };
  stats.fileReads = 0;
  stats.fileParses = 0;
  stats.cacheHits = 0;
  stats.evictions = 0;
  stats.pruned = 0;
}

/**
 * 已删除文件的快照清理（**只清本 projectsDir**：不同目录交替扫描互不清空）。
 * 返回清理条数（自检/测试断言用）。
 */
export function pruneClaudeSessionCache(projectsDir: string, seen: ReadonlySet<string>): number {
  const key = resolve(projectsDir);
  const cache = dirCaches.get(key);
  if (cache === undefined) return 0;
  const removed = cache.prune(seen);
  stats.pruned += removed;
  if (cache.size === 0) dirCaches.delete(key); // 整目录空了：连目录条目一起清账
  return removed;
}

/**
 * per-file 派生快照：mtime+size 未变直接复用（零读盘零 parse），变更才重读重派生。
 * 返回的 summary 是缓存内的共享对象，调用方**必须**浅拷贝后再注入运行态字段（status/cwd 兜底）。
 */
export async function loadClaudeSessionSnapshot(projectsDir: string, file: string): Promise<ClaudeFileSnapshot> {
  const cache = dirCacheFor(projectsDir);
  const fileStat = await stat(file);
  const cached = cache.get(file);
  if (cached !== undefined && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
    stats.cacheHits += 1;
    return cached;
  }
  stats.fileReads += 1;
  const content = await readFileText(file);
  stats.fileParses += 1;
  const snap: ClaudeFileSnapshot = {
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    summary: buildClaudeSessionSummary(file, content, fileStat.mtimeMs, {
      sessionId: fallbackSessionIdOf(file),
    }),
  };
  cache.set(file, snap);
  return snap;
}

/** 扫描并发度：与 pi 侧 scanSessions 同策略（冷扫不串行独占事件循环） */
const SCAN_CONCURRENCY = 4;

/** 扫描全部 claude 会话（cwd 兜底来自 history.jsonl） */
export async function scanClaudeSessions(
  projectsDir: string,
  historyIndex: Map<string, string> = new Map(),
  options: { statusOf?: (id: string, updatedMs: number) => SessionListItem["status"] } = {},
): Promise<SessionListItem[]> {
  const files = await findClaudeSessionFiles(projectsDir);
  const items: SessionListItem[] = [];
  const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r));
  // 并发分批 + 批间让出：单个大 transcript（实测最大 ~10MB）的读盘/parse 不再阻塞其余会话，
  // 也不独占事件循环（HTTP/WS 保持可响应）
  for (let i = 0; i < files.length; i += SCAN_CONCURRENCY) {
    await yieldLoop();
    const batch = await Promise.all(
      files.slice(i, i + SCAN_CONCURRENCY).map(async (file) => {
        try {
          const snap = await loadClaudeSessionSnapshot(projectsDir, file);
          const summary = snap.summary;
          if (!summary) return null;
          // cwd 兜底：行内缺失时用 history.jsonl 的 sessionId → project 映射（运行态输入，现算）
          const cwd = summary.cwd !== "" ? summary.cwd : historyIndex.get(summary.id) ?? "";
          return {
            ...summary,
            cwd,
            status: options.statusOf ? options.statusOf(summary.id, Date.parse(summary.updatedAt)) : "idle",
          };
        } catch {
          // 单个文件损坏不影响其它会话
          return null;
        }
      }),
    );
    for (const item of batch) {
      if (item) items.push(item);
    }
  }
  // 清账只针对本目录（计账在 pruneClaudeSessionCache 内完成，直接调用同样计账）
  pruneClaudeSessionCache(projectsDir, new Set(files));
  items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return items;
}
