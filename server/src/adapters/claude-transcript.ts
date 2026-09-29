/**
 * Claude Code transcript（~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl）解析。
 *
 * ── 调研结论（2026-09-29，基于本机 claude 2.1.267 真实数据）──────────────────
 * 1. 目录布局：`~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`。
 *    encoded-cwd 把 cwd 的 `/`、`.`、`&` 等非字母数字字符统一换成 `-`（有损，不能可靠反解），
 *    如 `/Users/<user>/Workspace/imid` → `-Users-<user>-Workspace-imid`。
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
import { join } from "node:path";
import type { MessageDto, SessionListItem, ToolCallDto } from "../types.js";
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

/** user 行里的 meta 文本前缀（命令回显/任务通知等，不进 chat 渲染） */
const META_TEXT_PREFIXES = ["<command-name>", "<local-command-stdout>", "<local-command-caveat>", "<task-notification>", "<bash-input>", "<bash-stdout>"];

function isMetaText(text: string): boolean {
  const t = text.trimStart();
  return META_TEXT_PREFIXES.some((p) => t.startsWith(p));
}

/** image block → 占位文本（契约 MessageDto.text 只承载文本；真图走 MessageDto.images） */
const IMAGE_PLACEHOLDER = "[image]";

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
  // message.id → 聚合中的 assistant DTO（同一条 API 消息的多个 block 行）
  const assistantAgg = new Map<string, MessageDto>();
  let autoId = 0;

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
        if (typeof row.aiTitle === "string" && row.aiTitle.trim() !== "") name = row.aiTitle.trim();
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
        if (row.isMeta === true || row.turnCompanion === true || row.isSidechain === true) break;
        const message = row.message;
        if (!isRecord(message)) break;
        const contentBlocks = message.content;
        const timestamp = typeof row.timestamp === "string" ? Date.parse(row.timestamp) || 0 : 0;

        if (typeof contentBlocks === "string") {
          const text = contentBlocks.trim();
          if (text === "" || isMetaText(text)) break;
          messages.push({
            id: typeof row.uuid === "string" ? row.uuid : nextId("user"),
            role: "user",
            timestamp,
            text: contentBlocks,
            toolCalls: [],
          });
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
            continue;
          }
          if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
          }
        }
        // image block → MessageDto.images（data URL），与 pi ImageContent 同口径
        const images = contentToImages(contentBlocks) ?? undefined;
        const extra = images ? { images } : {};
        const text = textParts.join("\n").trim();
        if (text !== "" && !isMetaText(text)) {
          messages.push({
            id: typeof row.uuid === "string" ? row.uuid : nextId("user"),
            role: "user",
            timestamp,
            text: textParts.join("\n"),
            toolCalls: [],
            ...extra,
          });
        } else if (images && !sawToolResult) {
          messages.push({
            id: typeof row.uuid === "string" ? row.uuid : nextId("user"),
            role: "user",
            timestamp,
            text: IMAGE_PLACEHOLDER,
            toolCalls: [],
            ...extra,
          });
        }
        break;
      }
      case "assistant": {
        if (row.isSidechain === true) break;
        const message = row.message;
        if (!isRecord(message)) break;
        const blocks = Array.isArray(message.content) ? message.content : [];
        const apiMessageId = typeof message.id === "string" && message.id !== "" ? message.id : typeof row.uuid === "string" ? row.uuid : nextId("asst");
        let dto = assistantAgg.get(apiMessageId);
        if (!dto) {
          dto = {
            id: apiMessageId,
            role: "assistant",
            timestamp: typeof row.timestamp === "string" ? Date.parse(row.timestamp) || 0 : 0,
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
            if (typeof block.id === "string") toolCallOwners.set(block.id, call);
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

  return { sessionId, cwd, name, messages, updatedAtMs, preamble: preambleParts.join("\n") };
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

/** transcript 文件 → 消息 DTO 列表（tail / 详情共用） */
export async function loadClaudeSessionMessages(file: string): Promise<MessageDto[]> {
  const fallbackSessionId = file.split("/").pop()?.replace(/\.jsonl$/i, "") ?? undefined;
  const parsed = parseClaudeTranscript(await readFileText(file), { sessionId: fallbackSessionId });
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

/** 扫描全部 claude 会话（cwd 兜底来自 history.jsonl） */
export async function scanClaudeSessions(
  projectsDir: string,
  historyIndex: Map<string, string> = new Map(),
  options: { statusOf?: (id: string, updatedMs: number) => SessionListItem["status"] } = {},
): Promise<SessionListItem[]> {
  const files = await findClaudeSessionFiles(projectsDir);
  const items: SessionListItem[] = [];
  for (const file of files) {
    try {
      const fileStat = await stat(file);
      const content = await readFileText(file);
      const fallbackSessionId = file.split("/").pop()?.replace(/\.jsonl$/i, "") ?? undefined;
      const summary = buildClaudeSessionSummary(file, content, fileStat.mtimeMs, {
        sessionId: fallbackSessionId,
      });
      if (!summary) continue;
      // cwd 兜底：行内缺失时用 history.jsonl 的 sessionId → project 映射
      const cwd = summary.cwd !== "" ? summary.cwd : historyIndex.get(summary.id) ?? "";
      items.push({
        ...summary,
        cwd,
        status: options.statusOf ? options.statusOf(summary.id, Date.parse(summary.updatedAt)) : "idle",
      });
    } catch {
      // 单个文件损坏不影响其它会话
    }
  }
  items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return items;
}
