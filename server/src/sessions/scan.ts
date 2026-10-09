/**
 * pi session-format v3 JSONL 解析（纯函数为主，便于单测伪造 session 文件）。
 * 事实源是 ~/.pi/agent/sessions/ 下的 JSONL 树，不自建数据库。
 *
 * 文件布局（与 pi 互通）：
 *   <sessionDir>/<encoded-cwd>/<fileTimestamp>_<sessionId>.jsonl
 *   encoded-cwd = `--${cwd 去掉前导分隔符并把 / \ : 换成 -}--`
 */
import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MessageDto, MessageImage, MessageRole, SessionListItem, ToolCallDto } from "../types.js";

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

/** 单条消息内嵌图片上限（防 base64 大响应拖垮手机端） */
export const MAX_MESSAGE_IMAGES = 8;

/**
 * content（ImageContent 块）→ 内嵌图片列表（data URL 或 http(s) URL）。
 * 无图返回 null（DTO 字段缺省，向后兼容）；text 块仍由 contentToText 提取。
 */
export function contentToImages(content: unknown): MessageImage[] | null {
  if (!Array.isArray(content)) return null;
  const out: MessageImage[] = [];
  for (const block of content) {
    if (out.length >= MAX_MESSAGE_IMAGES) break;
    if (!isRecord(block) || block.type !== "image") continue;
    const source = isRecord(block.source) ? block.source : null;
    if (source && source.type === "base64" && typeof source.data === "string") {
      const media = typeof source.media_type === "string" && source.media_type.startsWith("image/") ? source.media_type : "image/png";
      out.push({ url: `data:${media};base64,${source.data}`, alt: null });
    } else if (source && source.type === "url" && typeof source.url === "string") {
      out.push({ url: source.url, alt: null });
    } else if (typeof block.url === "string") {
      out.push({ url: block.url, alt: null });
    }
  }
  return out.length > 0 ? out : null;
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

function toDto(
  id: string,
  role: MessageRole,
  timestamp: number,
  text: string,
  toolCalls: ToolCallDto[] = [],
  thinking: string | null = null,
  images: MessageImage[] | null = null,
): MessageDto {
  return images === null
    ? { id, role, timestamp, text, thinking, toolCalls }
    : { id, role, timestamp, text, thinking, toolCalls, images };
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
        messages.push(toDto(entryId, "user", timestamp, contentToText(message.content), [], null, contentToImages(message.content)));
        break;
      }
      case "assistant": {
        const { toolCalls, byCallId } = assistantToolCalls(message);
        for (const [callId, ref] of byCallId) toolCallOwners.set(callId, ref.dto);
        messages.push(toDto(entryId, "assistant", timestamp, contentToText(message.content), toolCalls, contentToThinking(message.content), contentToImages(message.content)));
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

/** pi-subagents 派生子代理会话的命名规则：`<type>#<id>`，如 developer#abc123 / acceptance-reviewer#f81d33aa */
export const SUB_AGENT_NAME_RE = /^[a-z0-9-]+#[0-9a-f]{6,}$/;

/** pi-subagents 注入的固定结构标记（只出现在派生会话的 system preamble；主会话不可能自带） */
const SUB_AGENT_STRUCTURAL_MARKERS = ["<sub_agent_context>", "<active_agent name="];

/** 仅按命名规则判定（claude 等无 entries 场景的轻量判定） */
export function isSubAgentName(name: string | null): boolean {
  return name !== null && SUB_AGENT_NAME_RE.test(name.trim());
}

/**
 * 结构标记检测（pi/claude 同口径共用）：
 * 只认 preamble 文本中的 `<sub_agent_context>` / `<active_agent name=` 结构标记。
 * 消息正文提及（讨论/引述 pi-subagents、贴出标记字符串）一概不算，防主会话误标。
 */
export function hasSubAgentPreambleMarker(preamble: string): boolean {
  return SUB_AGENT_STRUCTURAL_MARKERS.some((marker) => preamble.includes(marker));
}

/** 入口（前 10 条 message）的 system 角色 preamble 是否含派生结构标记 */
function hasSubAgentMarker(entries: RawEntry[]): boolean {
  for (const entry of entries.slice(0, 10)) {
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "system") continue;
    const sections = message.sections;
    const preamble = isRecord(sections) && typeof sections.preamble === "string" ? sections.preamble : "";
    if (hasSubAgentPreambleMarker(preamble)) return true;
  }
  return false;
}

/**
 * 子代理会话判定（server 检测，web 按 isSubAgent 呈现）：
 * 会话名匹配 `<type>#<id>`，或入口消息含 pi-subagents 派生特征。
 */
export function isSubAgentSession(name: string | null, entries: RawEntry[]): boolean {
  return isSubAgentName(name) || hasSubAgentMarker(entries);
}

/**
 * 父会话文件路径 → 父会话 id（文件名 `<timestamp>_<sessionId>.jsonl` 取末段）。
 * 事实源是 pi 会话 header 的 `parentSession` 字段（pi-subagents 派生与 fork 分支都写）：
 * 真实样本调研（68 个会话）中 38 个子代理会话全部命中且父会话均可解析，
 * 优于反向匹配父会话的 Agent toolCall（其 arguments 不含子会话 id，无法定位）。
 * 无法解析返回 null（前端归"未归组子代理"兜底分组）。
 */
export function parentSessionIdFromPath(parentSession: unknown): string | null {
  if (typeof parentSession !== "string" || parentSession.trim() === "") return null;
  // 真实 pi 格式：parentSession 是父会话文件路径（…/2026-…_<id>.jsonl）→ 提取 id
  const base = parentSession.split(/[\\/]/).pop() ?? "";
  const m = /_([0-9a-zA-Z-]+)\.jsonl$/.exec(base);
  if (m && m[1] !== "") return m[1];
  // 裸 id 回退（合成/兼容格式）：无路径分隔与 .jsonl 后缀的非空字符串视为已是会话 id
  if (!/[\\/]/.test(parentSession) && !parentSession.endsWith(".jsonl")) return parentSession.trim();
  return null;
}

/** 会话摘要（列表项，status 由 server 运行态注入） */
export function buildSessionSummary(file: string, parsed: ParsedSession, mtimeMs: number): Omit<SessionListItem, "status"> | null {
  const { header, entries } = parsed;
  if (!header || typeof header.id !== "string" || header.id === "") return null;

  let messageCount = 0;
  for (const entry of entries) {
    // 口径与 chat 渲染对齐（buildMessages）：message + custom_message 都是聊天气泡，都要计数；
    // compaction/branch_summary 属元数据行（渲染为 custom 提示）不计消息数。
    if (entry.type === "message" || entry.type === "custom_message") messageCount += 1;
  }

  const active = selectActiveBranch(entries);
  const name = sessionName(entries);
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
    name,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    updatedAt: new Date(updatedMs).toISOString(),
    messageCount,
    lastUserMessage,
    lastAssistantMessage,
    sessionFile: file,
    isSubAgent: isSubAgentSession(name, entries),
    parentSessionId: parentSessionIdFromPath(header.parentSession),
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

/** 超大 JSONL 解析窗口上限（防全量读入内存 OOM）：超过只取尾部窗口内的完整行解析 */
export const MAX_JSONL_PARSE_BYTES = 50 * 1024 * 1024;

/**
 * 尾部窗口读取：只读 [size-maxBytes, size) 的字节，跳到第一个完整行边界（窗口起点可能是半行）
 * 后解析。窗口外的前部历史被舍弃（大文件降级取舍：保尾部近期消息，防 OOM 优先）。
 */
async function readTailWindow(file: string, size: number, maxBytes: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const start = size - maxBytes;
    const buf = Buffer.allocUnsafe(maxBytes);
    let filled = 0;
    while (filled < buf.length) {
      const { bytesRead } = await handle.read(buf, filled, buf.length - filled, start + filled);
      if (bytesRead <= 0) break;
      filled += bytesRead;
    }
    const data = buf.subarray(0, filled);
    const firstNl = data.indexOf(0x0a);
    if (firstNl < 0) return ""; // 窗口内无完整行：降级为空（下轮窗口滑过后可解析）
    return data.subarray(firstNl + 1).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * 读会话文件全文（供 detail 场景；单测直接用 parseSessionJsonl）。
 * maxBytes 缺省不截断；传入后超过该大小只读尾部窗口（从完整行边界开始）——
 * 超大 JSONL 不再全量驻留内存（OOM 防护），代价是窗口外的前部历史不可见。
 */
export async function readSessionFile(file: string, options: { maxBytes?: number } = {}): Promise<string> {
  const maxBytes = options.maxBytes;
  if (typeof maxBytes === "number" && maxBytes > 0) {
    let size = 0;
    try {
      size = (await stat(file)).size;
    } catch {
      size = 0; // stat 失败走全量读（错误由 read 抛出）
    }
    if (size > maxBytes) return readTailWindow(file, size, maxBytes);
  }
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
  // 并发解析（分批 4）：与 scanSessionInsights 同策略，避免串行读盘卡列表接口
  const CONCURRENCY = 4;
  const items: SessionListItem[] = [];
  const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r));
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    await yieldLoop(); // 批间让出：扫描不独占事件循环
    const batch = await Promise.all(
      files.slice(i, i + CONCURRENCY).map(async (file) => {
        try {
          // per-file 增量快照：mtime+size 未变的文件零读盘零 parse（AC2）
          const snap = await loadSessionSnapshot(file);
          if (!snap.summary) return null;
          const summary = snap.summary;
          return { ...summary, status: options.statusOf ? options.statusOf(summary.id, Date.parse(summary.updatedAt)) : "idle" };
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
  pruneSessionFileCache(new Set(files));
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

/**
 * 会话详情消息（active branch）。
 * maxBytes（缺省 50MB）：超过只解析尾部窗口——超大 JSONL 不全量读入内存（防 OOM），
 * 窗口外前部历史被舍弃（大文件降级取舍）。
 */
export async function loadSessionMessages(file: string, maxBytes: number = MAX_JSONL_PARSE_BYTES): Promise<MessageDto[]> {
  const parsed = parseSessionJsonl(await readSessionFile(file, { maxBytes }));
  return buildMessages(selectActiveBranch(parsed.entries));
}

// ---------- 今日/本周时间窗口径（纯函数；dashboard.ts 再导出复用，单一事实源防口径漂移） ----------

/** 本地时区当天 00:00（毫秒） */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本地时区本周一 00:00（毫秒） */
export function startOfWeek(now: number): number {
  const d = new Date(startOfDay(now));
  const weekday = d.getDay(); // 0=周日
  const daysSinceMonday = (weekday + 6) % 7;
  d.setDate(d.getDate() - daysSinceMonday);
  return d.getTime();
}

/** 计数只需要 role+timestamp（洞察缓存不携带全文，防全语料常驻） */
export type MessageFact = Pick<MessageDto, "role" | "timestamp">;

export interface DayWindow {
  dayStart: number;
  dayEnd: number;
  /** 会话是否仍在运行（最后一段 run 可能尚未 settled） */
  running: boolean;
}

/**
 * 今日 agent_settled 次数（从消息时间推 run 边界）：
 * active branch 里 assistant 消息若为「一轮 run 的最后一条」（后随 user/custom，
 * 或是末条且会话不在运行中），则算一次 settled；只计落在今日窗口内的。
 *
 * 注：steer 插话会把一轮 run 切成多段，v0 按边界近似计数（契约已注明）。
 */
export function countSettledRuns(messages: readonly MessageFact[], window: DayWindow): number {
  let count = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const next = messages[i + 1];
    const isRunEnd = next === undefined ? !window.running : next.role === "user" || next.role === "custom";
    if (!isRunEnd) continue;
    if (m.timestamp >= window.dayStart && m.timestamp < window.dayEnd) count += 1;
  }
  return count;
}

/** 今日消息数（user + assistant） */
export function countTodayMessages(messages: readonly MessageFact[], window: { dayStart: number; dayEnd: number }): number {
  let count = 0;
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (m.timestamp >= window.dayStart && m.timestamp < window.dayEnd) count += 1;
  }
  return count;
}

/**
 * 会话深度洞察（dashboard/通知聚合用）：摘要 + 推导字段 + 构建期算好的计数。
 * 不再携带全量 messages（曾是 cachedInsights 常驻全语料的 OOM 放大源）：
 * dashboard 直接消费 counts 计数字段。
 */
export interface InsightCounts {
  /** 计数窗口锚点：数据时间轴上的「现在」= max(全部消息时间戳, updatedAt) */
  anchorMs: number;
  /** 今日窗口 [dayStart, anchorMs+1] 的起点（本地 00:00）——跨日守卫键 */
  dayStart: number;
  /** 本周窗口 [weekStart, anchorMs+1] 的起点（本地周一 00:00）——跨周守卫键 */
  weekStart: number;
  /** 今日 settled run 数（口径同 countSettledRuns） */
  settledToday: number;
  /** 本周 settled run 数 */
  settledThisWeek: number;
  /** 今日 user/assistant 消息数（口径同 countTodayMessages） */
  todayMessages: number;
  /** 本周 user/assistant 消息数 */
  weekMessages: number;
  /** 活跃日集合（user/assistant 消息 ts>0 的本地 00:00 毫秒，升序去重）——streak 输入 */
  activeDays: number[];
}

export interface SessionInsight {
  summary: SessionListItem;
  /** 构建期算好的计数（dashboard 直接用，不再逐条扫描 messages） */
  counts: InsightCounts;
  /** active branch 最后一条 user/assistant 消息的 role（无消息为 null） */
  lastMessageRole: MessageRole | null;
  /** 最近一次工具调用摘要（最后一条带 toolCalls 的 assistant 消息里最后一个） */
  lastToolSummary: string | null;
  /** 当前 run 起点（active branch 最后一条用户消息时间，ISO） */
  lastRunStartedAt: string | null;
}

/** 计数锚点：数据时间轴上的「现在」（消息时间戳与 updatedAt 取新；全无则 0） */
function countAnchorMs(messages: readonly MessageFact[], updatedAtIso: string): number {
  const parsedUpdatedAt = Date.parse(updatedAtIso);
  let anchor = Number.isNaN(parsedUpdatedAt) ? 0 : parsedUpdatedAt;
  for (const m of messages) {
    if (m.timestamp > anchor) anchor = m.timestamp;
  }
  return anchor;
}

/**
 * 消息事实 → 计数聚合（纯函数）。
 * 窗口锚定数据时间轴（anchorMs）；dashboard 按「今天/本周」同窗守卫后累加——
 * 与旧实现（derive 时逐条按 now 过滤 messages）口径逐字等价：
 * 消息时间戳恒 ≤ anchorMs，跨日/跨周时旧实现同样计 0。
 */
export function deriveInsightCounts(
  messages: readonly MessageFact[],
  updatedAtIso: string,
  running: boolean,
): InsightCounts {
  const anchorMs = countAnchorMs(messages, updatedAtIso);
  const dayStart = startOfDay(anchorMs);
  const weekStart = startOfWeek(anchorMs);
  return {
    anchorMs,
    dayStart,
    weekStart,
    settledToday: countSettledRuns(messages, { dayStart, dayEnd: anchorMs + 1, running }),
    settledThisWeek: countSettledRuns(messages, { dayStart: weekStart, dayEnd: anchorMs + 1, running }),
    todayMessages: countTodayMessages(messages, { dayStart, dayEnd: anchorMs + 1 }),
    weekMessages: countTodayMessages(messages, { dayStart: weekStart, dayEnd: anchorMs + 1 }),
    activeDays: [
      ...new Set(
        messages
          .filter((m) => (m.role === "user" || m.role === "assistant") && m.timestamp > 0)
          .map((m) => startOfDay(m.timestamp)),
      ),
    ].sort((a, b) => a - b),
  };
}

/** 洞察推导字段（纯函数）：最后消息角色 / 最近工具摘要 / 当前 run 起点 */
export function deriveInsightFields(
  messages: MessageDto[],
): Pick<SessionInsight, "lastMessageRole" | "lastToolSummary" | "lastRunStartedAt"> {
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
  return { lastMessageRole, lastToolSummary, lastRunStartedAt };
}

/** 摘要 + active branch 消息 → 洞察（纯函数） */
export function buildInsight(summary: SessionListItem, messages: MessageDto[]): SessionInsight {
  return {
    summary,
    counts: deriveInsightCounts(messages, summary.updatedAt, summary.status === "running"),
    ...deriveInsightFields(messages),
  };
}

/**
 * per-file 派生快照（AC2）：mtime+size 未变的文件不读盘不 parse（参照 usage.ts 的
 * FileUsageEntry 增量模式）。快照只存计数事实与全文文本索引，不驻留全量 messages。
 */
export interface SessionFileSnapshot {
  mtimeMs: number;
  size: number;
  /** 无 session header 的损坏文件为 null（负面结果同样缓存，避免反复重读） */
  summary: Omit<SessionListItem, "status"> | null;
  /** 计数事实（role+timestamp）：按当前 running 现算计数，无全文驻留 */
  facts: MessageFact[];
  /** 洞察推导字段（不可变，跨扫描复用） */
  insightFields: Pick<SessionInsight, "lastMessageRole" | "lastToolSummary" | "lastRunStartedAt">;
  /** active branch 全文文本索引（search.ts 复用同一份，禁止截断） */
  textIndex: SessionTextIndexEntry[];
}

/** 文本索引条目（active branch 消息全文；search 索引与快照共用同一份，避免双份驻留） */
export interface SessionTextIndexEntry {
  sessionId: string;
  sessionName: string | null;
  messageId: string;
  role: MessageRole;
  text: string;
  /** 毫秒（pi 原始值；缺失时用文件 mtime 兜底） */
  timestamp: number;
}

/** active branch 消息 → 文本索引条目（全文不截断：搜索是核心功能，禁止缩量） */
export function textIndexFromMessages(
  messages: MessageDto[],
  ctx: { sessionId: string; sessionName: string | null; mtimeMs: number },
): SessionTextIndexEntry[] {
  return messages
    .filter((m) => m.text.trim() !== "")
    .map((m) => ({
      sessionId: ctx.sessionId,
      sessionName: ctx.sessionName,
      messageId: m.id,
      role: m.role,
      text: m.text,
      // 时间戳缺失时用文件 mtime 兜底，保证排序稳定
      timestamp: m.timestamp || ctx.mtimeMs,
    }));
}

const snapshotCache = new Map<string, SessionFileSnapshot>();
const cacheStats = { fileReads: 0, fileParses: 0, cacheHits: 0 };

export interface SessionCacheStats {
  /** 读盘（读文件内容）次数 */
  fileReads: number;
  /** JSON parse 次数 */
  fileParses: number;
  /** per-file 快照命中次数 */
  cacheHits: number;
}

/** 缓存 IO 计数（基准测试固化用：如「第二次扫描零读盘」） */
export function sessionCacheStats(): SessionCacheStats {
  return { ...cacheStats };
}

/** 清空全部会话扫描缓存与计数（测试基准/自检用） */
export function resetSessionCaches(): void {
  snapshotCache.clear();
  lineageCache.clear();
  lineageFileCaches.clear();
  cacheStats.fileReads = 0;
  cacheStats.fileParses = 0;
  cacheStats.cacheHits = 0;
}

/** 已删除文件的快照清理（防缓存无限增长；调用方给出本次扫描见到的文件集） */
export function pruneSessionFileCache(seen: ReadonlySet<string>): void {
  for (const file of [...snapshotCache.keys()]) {
    if (!seen.has(file)) snapshotCache.delete(file);
  }
}

function deriveSnapshot(
  file: string,
  parsed: ParsedSession,
  fileStat: { mtimeMs: number; size: number },
): SessionFileSnapshot {
  const summary = buildSessionSummary(file, parsed, fileStat.mtimeMs);
  const base = { mtimeMs: fileStat.mtimeMs, size: fileStat.size };
  if (summary === null) {
    return { ...base, summary: null, facts: [], insightFields: deriveInsightFields([]), textIndex: [] };
  }
  const messages = buildMessages(selectActiveBranch(parsed.entries));
  return {
    ...base,
    summary,
    facts: messages.map((m) => ({ role: m.role, timestamp: m.timestamp })),
    insightFields: deriveInsightFields(messages),
    textIndex: textIndexFromMessages(messages, {
      sessionId: summary.id,
      sessionName: summary.name,
      mtimeMs: fileStat.mtimeMs,
    }),
  };
}

/** per-file 派生快照：mtime+size 未变直接复用（零读盘零 parse），变更才重读重派生 */
export async function loadSessionSnapshot(file: string): Promise<SessionFileSnapshot> {
  const fileStat = await stat(file);
  const cached = snapshotCache.get(file);
  if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
    cacheStats.cacheHits += 1;
    return cached;
  }
  cacheStats.fileReads += 1;
  const content = await readSessionFile(file);
  cacheStats.fileParses += 1;
  const snap = deriveSnapshot(file, parseSessionJsonl(content), fileStat);
  snapshotCache.set(file, snap);
  return snap;
}

/** 扫描全部会话的深度洞察（快照复用：未变文件零读盘；计数构建期算好，不携带全量 messages） */
export async function scanSessionInsights(sessionDir: string, options: ScanOptions = {}): Promise<SessionInsight[]> {
  const files = await findSessionFiles(sessionDir);
  // 并发解析（分批 4）：60+ 会话文件串行读盘是 dashboard 秒级卡顿的根源
  const CONCURRENCY = 4;
  const items: SessionInsight[] = [];
  const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r));
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    await yieldLoop(); // 批间让出：扫描不独占事件循环（HTTP 保持可响应）
    const batch = files.slice(i, i + CONCURRENCY);
    const parsedBatch = await Promise.all(
      batch.map(async (file) => {
        try {
          const snap = await loadSessionSnapshot(file);
          if (!snap.summary) return null;
          const status = options.statusOf ? options.statusOf(snap.summary.id, Date.parse(snap.summary.updatedAt)) : "idle";
          const summary: SessionListItem = { ...snap.summary, status };
          const insight: SessionInsight = {
            summary,
            // running 影响末条 run 边界口径：按当前状态现算（事实缓存里只有 role+timestamp）
            counts: deriveInsightCounts(snap.facts, summary.updatedAt, status === "running"),
            ...snap.insightFields,
          };
          return insight;
        } catch {
          // 单个文件损坏不影响其它会话
          return null;
        }
      }),
    );
    for (const item of parsedBatch) {
      if (item) items.push(item);
    }
  }
  pruneSessionFileCache(new Set(files));
  items.sort((a, b) => {
    const d = Date.parse(b.summary.updatedAt) - Date.parse(a.summary.updatedAt);
    return d !== 0 ? d : a.summary.id < b.summary.id ? -1 : a.summary.id > b.summary.id ? 1 : 0;
  });
  return items;
}


/**
 * 轻量子代血缘扫描（子代理发现专用）：
 * 只读每个会话文件头部若干 KB（header 首行含 parentSession；前几行含 session_info.name），
 * 不解析全量消息——60+ 会话毫秒级，绕过 listSessions 的 SWR 缓存相位问题。
 *
 * 进程级缓存（AC3，跨连接共享）：结果 TTL + 文件名校验 + per-file mtime+size 增量——
 * ws syncChildren 每 10s/连接调用时共享同一次扫描，未变文件零 open/read。
 * 文件名单（readdir）每次校验：新写入的静态子会话立即可见（体验契约，不等 TTL）。
 */
export interface SubAgentLineage {
  id: string;
  parentSessionId: string | null;
  name: string | null;
  sessionFile: string;
}

/** 血缘结果 TTL：名单未变窗口内重复调用直接复用（5s；TTL 外按 per-file 增量重扫） */
export const LINEAGE_CACHE_TTL_MS = 5_000;

interface LineageFileEntry {
  mtimeMs: number;
  size: number;
  /** 非子代理文件为 null（负面结果同样缓存） */
  value: SubAgentLineage | null;
}

interface LineageCacheEntry {
  at: number;
  /** 本次扫描的文件名签名（新增/删除立即失效） */
  namesSig: string;
  value: SubAgentLineage[];
}

const lineageCache = new Map<string, LineageCacheEntry>();
const lineageFileCaches = new Map<string, Map<string, LineageFileEntry>>();

/** 单文件头读取 → 血缘（语义与旧实现逐字一致：8KB 头 + 命名/父血缘双口径） */
async function readSubAgentLineage(file: string): Promise<SubAgentLineage | null> {
  const HEAD_BYTES = 8192;
  const { open } = await import("node:fs/promises");
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    const head = buf.subarray(0, bytesRead).toString("utf8");
    const lines = head.split("\n").filter((l) => l.trim() !== "");
    let id: string | null = null;
    let parentSessionId: string | null = null;
    let name: string | null = null;
    for (const line of lines) {
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(row)) continue;
      if (row.type === "session" && typeof row.id === "string") {
        id = row.id;
      } else if (row.type === "session_info" && typeof row.name === "string") {
        // 最新一条为当前名；显式清空视为 null（与 sessionName 口径一致）
        const n = row.name.trim();
        name = n === "" ? null : n;
      }
      // header 行内 parentSession（路径或裸 id，统一归一化为父会话 id）
      if (parentSessionId === null) {
        parentSessionId = parentSessionIdFromPath(row.parentSession);
      }
    }
    if (id === null) return null;
    // 口径与 isSubAgentSession 对齐：命名特征优先（fork 分支带 parentSession 但不叫子代理）；
    // 无名时以父血缘兜底（pi-subagents 派生即使缺 session_info 也应入面板）
    const isSub = name !== null ? SUB_AGENT_NAME_RE.test(name) : parentSessionId !== null;
    if (!isSub) return null;
    return { id, parentSessionId, name, sessionFile: file };
  } finally {
    await fh.close();
  }
}

export async function scanSubAgentLineage(
  sessionDir: string,
  options: { ttlMs?: number; now?: () => number } = {},
): Promise<SubAgentLineage[]> {
  const ttlMs = options.ttlMs ?? LINEAGE_CACHE_TTL_MS;
  const now = options.now ? options.now() : Date.now();
  const files = await findSessionFiles(sessionDir);
  const namesSig = files.join("\n");
  // 名单未变 + TTL 内：直接复用（跨连接共享同一次扫描结果）
  const cached = lineageCache.get(sessionDir);
  if (cached && cached.namesSig === namesSig && now - cached.at < ttlMs) {
    cacheStats.cacheHits += 1;
    return cached.value;
  }
  let fileCache = lineageFileCaches.get(sessionDir);
  if (!fileCache) {
    fileCache = new Map();
    lineageFileCaches.set(sessionDir, fileCache);
  }
  const seen = new Set(files);
  const out = await Promise.all(
    files.map(async (file) => {
      try {
        const fileStat = await stat(file);
        const hit = fileCache.get(file);
        if (hit && hit.mtimeMs === fileStat.mtimeMs && hit.size === fileStat.size) {
          cacheStats.cacheHits += 1;
          return hit.value; // 未变文件零 open/read
        }
        cacheStats.fileReads += 1;
        const value = await readSubAgentLineage(file);
        fileCache.set(file, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, value });
        return value;
      } catch {
        // 单文件损坏不影响整体
        return null;
      }
    }),
  );
  for (const file of [...fileCache.keys()]) {
    if (!seen.has(file)) fileCache.delete(file); // 文件删除：清账
  }
  const value = out.filter((v): v is SubAgentLineage => v !== null);
  lineageCache.set(sessionDir, { at: now, namesSig, value });
  return value;
}
