/**
 * pi session-format v3 JSONL 解析（纯函数为主，便于单测伪造 session 文件）。
 * 事实源是 ~/.pi/agent/sessions/ 下的 JSONL 树，不自建数据库。
 *
 * 文件布局（与 pi 互通）：
 *   <sessionDir>/<encoded-cwd>/<fileTimestamp>_<sessionId>.jsonl
 *   encoded-cwd = `--${cwd 去掉前导分隔符并把 / \ : 换成 -}--`
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MessageDto, MessageRole, SessionListItem, ToolCallDto } from "../types.js";

export const LAST_MESSAGE_LIMIT = 120;
export const RESULT_PREVIEW_LIMIT = 500;

/** JSONL entry 的最小通用形状 */
export interface RawEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  [key: string]: unknown;
}

export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface ParsedSession {
  header: SessionHeader | null;
  entries: RawEntry[];
}

/** 与 pi 相同的 cwd → 会话分组目录编码 */
export function encodeCwdDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** 与 pi 相同的会话文件名：`<timestamp 把 : . 换成 ->_<sessionId>.jsonl` */
export function sessionFileName(timestampIso: string, sessionId: string): string {
  return `${timestampIso.replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
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
        return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text";
      })
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

/** content（string | (TextContent|ImageContent)[]）→ 思维链文本（thinking 块拼接，无则 null） */
export function contentToThinking(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((block): block is { type: "thinking"; thinking: string } => {
      return (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "thinking" &&
        typeof (block as { thinking?: unknown }).thinking === "string"
      );
    })
    .map((block) => block.thinking);
  return parts.length > 0 ? parts.join("\n") : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 工具调用摘要：bash→command，读写类→路径，其余紧凑 JSON */
export function summarizeToolCall(name: string, args: unknown): string {
  if (isRecord(args)) {
    for (const key of ["command", "path", "filePath", "file_path", "pattern", "url"]) {
      const v = args[key];
      if (typeof v === "string" && v.trim() !== "") return truncateText(v, LAST_MESSAGE_LIMIT);
    }
  }
  try {
    return truncateText(JSON.stringify(args ?? {}), LAST_MESSAGE_LIMIT);
  } catch {
    return "";
  }
}

export function parseSessionJsonl(content: string): ParsedSession {
  let header: SessionHeader | null = null;
  const entries: RawEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // 损坏行跳过，不让单行破坏整个会话
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") continue;
    const entry = parsed as RawEntry;
    if (entry.type === "session" && header === null) {
      header = entry as unknown as SessionHeader;
      continue;
    }
    entries.push(entry);
  }
  return { header, entries };
}

/**
 * 选 active branch：树结构取活跃叶（文件中最后一个 entry）到根的路径，
 * 返回 root→leaf 顺序。断链 entry 按原样保留在路径尾部。
 */
export function selectActiveBranch(entries: RawEntry[]): RawEntry[] {
  if (entries.length === 0) return [];
  const byId = new Map<string, RawEntry>();
  for (const e of entries) {
    if (typeof e.id === "string") byId.set(e.id, e);
  }
  const path: RawEntry[] = [];
  const seen = new Set<string>();
  let cursor: RawEntry | undefined = entries[entries.length - 1];
  while (cursor) {
    if (typeof cursor.id === "string") {
      if (seen.has(cursor.id)) break; // 环保护
      seen.add(cursor.id);
    }
    path.push(cursor);
    const parentId: string | null | undefined = cursor.parentId;
    cursor = typeof parentId === "string" ? byId.get(parentId) : undefined;
  }
  return path.reverse();
}

interface ToolCallRef {
  dto: ToolCallDto;
}

/** assistant 消息 → DTO，toolCalls 从 content 的 toolCall 块生成 */
export function assistantToolCalls(message: Record<string, unknown>): { toolCalls: ToolCallDto[]; byCallId: Map<string, ToolCallRef> } {
  const toolCalls: ToolCallDto[] = [];
  const byCallId = new Map<string, ToolCallRef>();
  const content = message.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (isRecord(block) && block.type === "toolCall") {
        const name = typeof block.name === "string" ? block.name : "unknown";
        const dto: ToolCallDto = {
          name,
          summary: summarizeToolCall(name, block.arguments),
          status: "pending",
          resultPreview: null,
        };
        toolCalls.push(dto);
        if (typeof block.id === "string") byCallId.set(block.id, { dto });
      }
    }
  }
  return { toolCalls, byCallId };
}

function entryTimestampMs(entry: RawEntry, message?: Record<string, unknown>): number {
  if (message && typeof message.timestamp === "number") return message.timestamp;
  if (typeof entry.timestamp === "string") {
    const t = Date.parse(entry.timestamp);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function toDto(id: string, role: MessageRole, timestamp: number, text: string, toolCalls: ToolCallDto[] = [], thinking: string | null = null): MessageDto {
  return { id, role, timestamp, text, thinking, toolCalls };
}

/**
 * active branch entries → chat 消息 DTO 列表。
 * toolResult 折叠进产生它的 assistant 消息的 toolCalls[]；
 * 无主 toolResult（孤儿）保留为 role "toolResult" 消息。
 * compaction / branch_summary / custom_message 映射为 role "custom"。
 */
export function buildMessages(entries: RawEntry[]): MessageDto[] {
  const messages: MessageDto[] = [];
  // toolCallId → 所属 assistant 消息的 toolCall DTO
  const toolCallOwners = new Map<string, ToolCallDto>();
  for (const entry of entries) {
    if (entry.type !== "message") {
      if (entry.type === "custom_message") {
        messages.push(
          toDto(
            typeof entry.id === "string" ? entry.id : "custom",
            "custom",
            entryTimestampMs(entry),
            contentToText(entry.content),
          ),
        );
      } else if (entry.type === "compaction") {
        const summary = typeof entry.summary === "string" ? entry.summary : "";
        messages.push(
          toDto(typeof entry.id === "string" ? entry.id : "compaction", "custom", entryTimestampMs(entry), `[context compacted] ${summary}`),
        );
      } else if (entry.type === "branch_summary") {
        const summary = typeof entry.summary === "string" ? entry.summary : "";
        messages.push(
          toDto(typeof entry.id === "string" ? entry.id : "branch-summary", "custom", entryTimestampMs(entry), `[branch summary] ${summary}`),
        );
      }
      continue;
    }

    const message = entry.message;
    if (!isRecord(message) || typeof message.role !== "string") continue;
    const entryId = typeof entry.id === "string" ? entry.id : `entry-${messages.length}`;
    const timestamp = entryTimestampMs(entry, message);

    switch (message.role) {
      case "user": {
        messages.push(toDto(entryId, "user", timestamp, contentToText(message.content)));
        break;
      }
      case "assistant": {
        const { toolCalls, byCallId } = assistantToolCalls(message);
        for (const [callId, ref] of byCallId) toolCallOwners.set(callId, ref.dto);
        messages.push(toDto(entryId, "assistant", timestamp, contentToText(message.content), toolCalls, contentToThinking(message.content)));
        break;
      }
      case "toolResult": {
        const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
        const owner = toolCallOwners.get(toolCallId);
        const preview = truncateText(contentToText(message.content), RESULT_PREVIEW_LIMIT);
        if (owner) {
          owner.status = message.isError === true ? "error" : "done";
          owner.resultPreview = preview === "" ? null : preview;
        } else {
          messages.push(toDto(entryId, "toolResult", timestamp, preview));
        }
        break;
      }
      case "custom": {
        messages.push(toDto(entryId, "custom", timestamp, contentToText(message.content)));
        break;
      }
      default:
        // system 等其它 role 不进 chat 渲染
        break;
    }
  }
  return messages;
}

/** 会话名：最新 session_info entry（显式清空视为 null） */
export function sessionName(entries: RawEntry[]): string | null {
  let name: string | null = null;
  for (const entry of entries) {
    if (entry.type === "session_info") {
      const n = typeof entry.name === "string" ? entry.name.trim() : "";
      name = n === "" ? null : n;
    }
  }
  return name;
}

/** 会话摘要（列表项，status 由 server 运行态注入） */
export function buildSessionSummary(file: string, parsed: ParsedSession, mtimeMs: number): Omit<SessionListItem, "status"> | null {
  const { header, entries } = parsed;
  if (!header || typeof header.id !== "string" || header.id === "") return null;

  let messageCount = 0;
  for (const entry of entries) {
    if (entry.type === "message") messageCount += 1;
  }

  const active = selectActiveBranch(entries);
  let lastUserMessage: string | null = null;
  let lastAssistantMessage: string | null = null;
  for (const entry of active) {
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role === "user") {
      const text = truncateText(contentToText(message.content), LAST_MESSAGE_LIMIT);
      if (text !== "") lastUserMessage = text;
    } else if (message.role === "assistant") {
      const text = truncateText(contentToText(message.content), LAST_MESSAGE_LIMIT);
      if (text !== "") lastAssistantMessage = text;
    }
  }

  // updatedAt：最后一条 entry 时间戳优先，缺失回退文件 mtime
  let updatedMs = mtimeMs;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const t = entries[i].timestamp;
    if (typeof t === "string") {
      const parsedTs = Date.parse(t);
      if (!Number.isNaN(parsedTs)) {
        updatedMs = parsedTs;
        break;
      }
    }
  }

  return {
    id: header.id,
    source: "pi",
    name: sessionName(entries),
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    updatedAt: new Date(updatedMs).toISOString(),
    messageCount,
    lastUserMessage,
    lastAssistantMessage,
    sessionFile: file,
  };
}

/** 递归扫描 session 目录（全部 cwd 分组）下所有 *.jsonl */
export async function findSessionFiles(sessionDir: string, maxDepth = 3): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在/不可读：空列表，不是错误
    }
    for (const dirent of dirents) {
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(full, depth + 1);
      } else if (dirent.isFile() && dirent.name.endsWith(".jsonl")) {
        results.push(full);
      }
    }
  }
  await walk(sessionDir, 0);
  return results;
}

/** 逐行流式读取（供 detail 场景；单测直接用 parseSessionJsonl） */
export async function readSessionFile(file: string): Promise<string> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolvePromise());
    stream.on("error", rejectPromise);
  });
  return Buffer.concat(chunks).toString("utf8");
}

export interface ScanOptions {
  /** 注入运行态（server 内存 + 外部活动推断）；updatedMs 为会话最后更新时间 */
  statusOf?: (id: string, updatedMs: number) => SessionListItem["status"];
}

/** 扫描全部会话（所有 cwd 分组），按 updatedAt 倒序 */
export async function scanSessions(sessionDir: string, options: ScanOptions = {}): Promise<SessionListItem[]> {
  const files = await findSessionFiles(sessionDir);
  const items: SessionListItem[] = [];
  for (const file of files) {
    try {
      const fileStat = await stat(file);
      const parsed = parseSessionJsonl(await readSessionFile(file));
      const summary = buildSessionSummary(file, parsed, fileStat.mtimeMs);
      if (!summary) continue;
      items.push({ ...summary, status: options.statusOf ? options.statusOf(summary.id, Date.parse(summary.updatedAt)) : "idle" });
    } catch {
      // 单个文件损坏不影响其它会话
    }
  }
  // 确定性 tiebreaker：updatedAt 相同时按 id 升序（与 web sortSessions 口径一致，刷新绝不重排）
  items.sort((a, b) => {
    const d = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return items;
}

/** 按会话 id 找摘要（扫描 session 目录） */
export async function findSessionById(sessionDir: string, id: string, options: ScanOptions = {}): Promise<SessionListItem | null> {
  const all = await scanSessions(sessionDir, options);
  return all.find((item) => item.id === id) ?? null;
}

/** 会话详情消息（active branch） */
export async function loadSessionMessages(file: string): Promise<MessageDto[]> {
  const parsed = parseSessionJsonl(await readSessionFile(file));
  return buildMessages(selectActiveBranch(parsed.entries));
}

/**
 * 会话深度洞察（dashboard/通知聚合用）：摘要 + active branch 消息 +
 * 推导字段（最后消息角色 / 最近工具摘要 / 当前 run 起点）。
 */
export interface SessionInsight {
  summary: SessionListItem;
  messages: MessageDto[];
  /** active branch 最后一条 user/assistant 消息的 role（无消息为 null） */
  lastMessageRole: MessageRole | null;
  /** 最近一次工具调用摘要（最后一条带 toolCalls 的 assistant 消息里最后一个） */
  lastToolSummary: string | null;
  /** 当前 run 起点（active branch 最后一条用户消息时间，ISO） */
  lastRunStartedAt: string | null;
}

/** 摘要 + active branch 消息 → 洞察（纯函数） */
export function buildInsight(summary: SessionListItem, messages: MessageDto[]): SessionInsight {
  let lastMessageRole: MessageRole | null = null;
  let lastToolSummary: string | null = null;
  let lastRunStartedAt: string | null = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (lastMessageRole === null && (m.role === "user" || m.role === "assistant")) {
      lastMessageRole = m.role;
    }
    if (lastRunStartedAt === null && m.role === "user") {
      lastRunStartedAt = m.timestamp > 0 ? new Date(m.timestamp).toISOString() : null;
    }
    if (lastToolSummary === null && m.toolCalls.length > 0) {
      lastToolSummary = m.toolCalls[m.toolCalls.length - 1].summary;
    }
    if (lastMessageRole !== null && lastToolSummary !== null && lastRunStartedAt !== null) break;
  }
  return { summary, messages, lastMessageRole, lastToolSummary, lastRunStartedAt };
}

/** 扫描全部会话的深度洞察（每个文件一次读写：摘要 + 消息 + 推导字段） */
export async function scanSessionInsights(sessionDir: string, options: ScanOptions = {}): Promise<SessionInsight[]> {
  const files = await findSessionFiles(sessionDir);
  const items: SessionInsight[] = [];
  for (const file of files) {
    try {
      const fileStat = await stat(file);
      const parsed = parseSessionJsonl(await readSessionFile(file));
      const summaryBase = buildSessionSummary(file, parsed, fileStat.mtimeMs);
      if (!summaryBase) continue;
      const status = options.statusOf ? options.statusOf(summaryBase.id, Date.parse(summaryBase.updatedAt)) : "idle";
      const summary: SessionListItem = { ...summaryBase, status };
      const messages = buildMessages(selectActiveBranch(parsed.entries));
      items.push(buildInsight(summary, messages));
    } catch {
      // 单个文件损坏不影响其它会话
    }
  }
  items.sort((a, b) => {
    const d = Date.parse(b.summary.updatedAt) - Date.parse(a.summary.updatedAt);
    return d !== 0 ? d : a.summary.id < b.summary.id ? -1 : a.summary.id > b.summary.id ? 1 : 0;
  });
  return items;
}
