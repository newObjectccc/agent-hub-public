/**
 * 跨会话消息搜索（docs/API_CONTRACT.md §1.6）：
 * 大小写不敏感子串匹配，无需全文索引；结果内存缓存，
 * 会话文件变更（presence 回调）或 TTL 60s 后重建。
 *
 * 搜索范围 = 各会话 **active branch** 消息文本（与 GET /api/sessions/:id 的
 * messages 一致），保证结果点击直达 chat 页可定位；toolResult 已折叠进
 * assistant 的 toolCalls，不参与文本搜索（v0 口径，见契约）。
 */
import type { SearchResultDto } from "../types.js";
import {
  buildMessages,
  findSessionFiles,
  loadSessionSnapshot,
  parseSessionJsonl,
  pruneSessionFileCache,
  selectActiveBranch,
  sessionName,
  textIndexFromMessages,
  type SessionTextIndexEntry,
} from "./scan.js";

/** 摘要半径：命中词前后各 ~60 字符 */
export const SNIPPET_RADIUS = 60;
/** 摘要高亮标记（结果里命中词以 [[...]] 包裹，前端渲染为高亮） */
export const SNIPPET_OPEN = "[[";
export const SNIPPET_CLOSE = "]]";
export const SEARCH_MAX_LIMIT = 100;
export const SEARCH_DEFAULT_LIMIT = 50;
/** 缓存 TTL：会话文件变更回调未覆盖到的场景兜底 */
export const SEARCH_CACHE_TTL_MS = 60_000;

/**
 * 命中摘要：以第一个命中为中心截取前后 radius 字符，
 * 片段内所有命中以 [[...]] 包裹；截断处加省略号。
 */
export function makeSnippet(text: string, query: string, radius: number = SNIPPET_RADIUS): string {
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const first = lower.indexOf(q);
  if (q === "" || first < 0) {
    // 不该发生（只对命中消息生成摘要）；兜底返回头部截断
    return text.length <= radius * 2 ? text : `…${text.slice(0, radius * 2)}…`;
  }
  const start = Math.max(0, first - radius);
  const end = Math.min(text.length, first + q.length + radius);
  const slice = text.slice(start, end);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";

  // 片段内全部命中加标记（左到右扫描，避免重叠）
  let marked = "";
  let cursor = 0;
  const sliceLower = slice.toLowerCase();
  for (;;) {
    const at = sliceLower.indexOf(q, cursor);
    if (at < 0) break;
    marked += slice.slice(cursor, at) + SNIPPET_OPEN + slice.slice(at, at + q.length) + SNIPPET_CLOSE;
    cursor = at + q.length;
  }
  marked += slice.slice(cursor);
  return prefix + marked + suffix;
}

/** 搜索索引条目（单条消息；与 scan.ts 的文本快照同构，共用同一份全文） */
export type SearchIndexEntry = SessionTextIndexEntry;

/** 会话文件 → 索引条目（active branch 消息文本，全文不截断） */
export function indexSessionFile(file: string, content: string, mtimeMs: number): SearchIndexEntry[] {
  const { header, entries } = parseSessionJsonl(content);
  if (!header || typeof header.id !== "string" || header.id === "") return [];
  const name = sessionName(entries);
  const messages = buildMessages(selectActiveBranch(entries));
  return textIndexFromMessages(messages, { sessionId: header.id, sessionName: name, mtimeMs });
}

/**
 * 搜索服务：内存索引 + 变更失效。
 * 索引构建一次（扫描全部会话文件），之后纯内存匹配；
 * invalidate()（presence 变更回调）或 TTL 过期后下次搜索时重建。
 */
export class SearchService {
  private readonly sessionDir: string;
  private readonly ttlMs: number;
  private index: SearchIndexEntry[] | null = null;
  private builtAt = 0;

  constructor(sessionDir: string, ttlMs: number = SEARCH_CACHE_TTL_MS) {
    this.sessionDir = sessionDir;
    this.ttlMs = ttlMs;
  }

  /** 会话文件变更（presence 回调）→ 索引失效 */
  invalidate(): void {
    this.index = null;
  }

  private async ensureIndex(): Promise<SearchIndexEntry[]> {
    const now = Date.now();
    if (this.index !== null && now - this.builtAt < this.ttlMs) return this.index;
    // 重建：旧索引整体丢弃可 GC（只保留这一份）；全文不截断（搜索结果完整性硬约束）
    const index: SearchIndexEntry[] = [];
    const files = await findSessionFiles(this.sessionDir);
    for (const file of files) {
      try {
        // 复用 scan 的 per-file 解析缓存（mtime+size 未变零读盘），避免重复读盘 parse（AC5）
        index.push(...(await loadSessionSnapshot(file)).textIndex);
      } catch {
        // 单个文件损坏不影响其它会话
      }
    }
    pruneSessionFileCache(new Set(files));
    this.index = index;
    this.builtAt = now;
    return index;
  }

  /** 大小写不敏感子串匹配，按时间倒序，limit 钳制到 1..100 */
  async search(query: string, limit: number = SEARCH_DEFAULT_LIMIT): Promise<SearchResultDto[]> {
    return searchIndexEntries(await this.ensureIndex(), query, limit);
  }
}

/** 纯内存搜索（SearchService.search 的匹配核心，供测试直接驱动） */
export function searchIndexEntries(entries: SearchIndexEntry[], query: string, limit: number = SEARCH_DEFAULT_LIMIT): SearchResultDto[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const capped = Math.max(1, Math.min(SEARCH_MAX_LIMIT, Math.floor(limit) || SEARCH_DEFAULT_LIMIT));
  const hits: SearchResultDto[] = [];
  for (const entry of entries) {
    if (!entry.text.toLowerCase().includes(q)) continue;
    hits.push({
      sessionId: entry.sessionId,
      sessionName: entry.sessionName,
      messageId: entry.messageId,
      role: entry.role,
      snippet: makeSnippet(entry.text, q),
      timestamp: entry.timestamp,
    });
  }
  hits.sort((a, b) => b.timestamp - a.timestamp);
  return hits.slice(0, capped);
}
