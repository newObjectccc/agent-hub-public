/**
 * SessionRegistry：多 source 会话的合并与分发（实现 routes 的 SessionHubLike）。
 *
 * - GET /api/sessions：pi + claude 两源合并，按 updatedAt 倒序（同刻按 id 稳定排序）
 * - 其余操作按 id 归属分发：先查 claude（UUID 命名空间），未命中走 pi；
 *   两边都未命中 → SESSION_NOT_FOUND
 * - createSession 按 source 分发（缺省 pi）：pi 落盘 JSONL header；
 *   claude 写空白 transcript 会话文件（调研结论见 ClaudeAdapter.createSession）
 * - forkSession 按 id 归属分发（pi：SDK createBranchedSession；claude：复制 transcript）
 * - compact 仅支持 pi（claude 的上下文压缩由其自身 autocompact 管理）
 *
 * id 冲突（理论上不可能：pi 为 32-hex、claude 为 UUID v4）时 claude 优先，按源缓存消歧。
 */
import { ErrorCodes, HubError } from "../errors.js";
import { scanSubAgentLineage } from "../sessions/scan.js";
import type { PromptResult } from "../sessions/hub.js";
import { loadSessionMessages } from "../sessions/scan.js";
import { loadClaudeSessionMessages } from "./claude-transcript.js";
import type { MessageDto, PromptImageAttachment, SessionListItem, SessionSource, SessionStatus } from "../types.js";
import type { ClaudeAdapter } from "./claude.js";
import type { SessionAdapter } from "./types.js";

export class SessionRegistry {
  private readonly pi: SessionAdapter;
  private readonly claude: SessionAdapter;
  /** id → source 记忆（getStatus/isLive 等同步路径消歧用） */
  private readonly sources = new Map<string, SessionSource>();
  /** 会话目录（轻量子代血缘扫描用） */
  private readonly sessionDir: string;
  /** 会话转 live 时回调（停文件 tail）；同时挂到两个适配器 */
  onLive?: (id: string) => void;

  constructor(pi: SessionAdapter, claude: SessionAdapter, sessionDir = "") {
    this.pi = pi;
    this.claude = claude;
    this.sessionDir = sessionDir;
    const forward = (id: string): void => this.onLive?.(id);
    (this.pi as SessionAdapter & { onLive?: (id: string) => void }).onLive = forward;
    (this.claude as ClaudeAdapter).onLive = forward;
  }

  private remember(sessions: SessionListItem[]): SessionListItem[] {
    for (const s of sessions) this.sources.set(s.id, s.source);
    return sessions;
  }

  /** 按 id 解析归属 source（claude 优先，未命中回退 pi；都没有 → null） */
  private async resolve(id: string): Promise<SessionAdapter | null> {
    const claudeHit = await this.claude.findSession(id);
    if (claudeHit) {
      this.remember([claudeHit]);
      return this.claude;
    }
    const piHit = await this.pi.findSession(id);
    if (piHit) {
      this.remember([piHit]);
      return this.pi;
    }
    return null;
  }

  getStatus(id: string): SessionStatus {
    return this.sources.get(id) === "claude" ? this.claude.getStatus(id) : this.pi.getStatus(id);
  }

  isLive(id: string): boolean {
    return this.claude.isLive(id) || this.pi.isLive(id);
  }

  /** 合并两源列表，按 updatedAt 倒序（契约排序），同刻按 id 稳定排序 */
  async listSessions(): Promise<SessionListItem[]> {
    const now = Date.now();
    if (this.cacheList && now - this.cacheListAt < SessionRegistry.LIST_CACHE_TTL_MS) return this.cacheList;
    // stale-while-revalidate：有旧值立即回，后台刷新（presence 高频失效下依旧秒回）
    if (this.cacheList) {
      if (!this.refreshingList) void this.refreshList();
      return this.cacheList;
    }
    await this.refreshList();
    return this.cacheList ?? [];
  }

  private async refreshList(): Promise<void> {
    if (this.refreshingList) return;
    this.refreshingList = true;
    try {
      this.cacheList = await this.loadSessions();
      this.cacheListAt = Date.now();
    } catch {
      // 扫描失败保留旧缓存
    } finally {
      this.refreshingList = false;
    }
  }

  /** 文件变更（presence）时标记过期：旧值秒回 + 下次刷新（SWR） */
  invalidateList(): void {
    this.cacheListAt = 0;
  }

  private static readonly LIST_CACHE_TTL_MS = 15_000;
  private cacheList: SessionListItem[] | null = null;
  private cacheListAt = 0;
  private refreshingList = false;

  private async loadSessions(): Promise<SessionListItem[]> {
    const [piSessions, claudeSessions] = await Promise.all([this.pi.listSessions(), this.claude.listSessions()]);
    const merged = this.remember([...piSessions, ...claudeSessions]);
    merged.sort((a, b) => {
      const diff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    });
    return merged;
  }

  async findSession(id: string): Promise<SessionListItem | null> {
    const adapter = await this.resolve(id);
    if (!adapter) return null;
    return adapter.findSession(id);
  }

  /** 子代理会话列表（pi-subagents 派生 + 血缘指向 parentId；fork 分支不算，反馈轮 3 #4） */
  async listChildren(parentId: string): Promise<SessionListItem[]> {
    // 轻量血缘直读（绕过 listSessions 的 SWR 缓存相位：新/静态子会话 ≤10s 必现）
    const lineage = await scanSubAgentLineage(this.sessionDir);
    const out: SessionListItem[] = [];
    for (const l of lineage) {
      if (l.parentSessionId !== parentId) continue;
      out.push({
        id: l.id,
        source: "pi",
        name: l.name,
        cwd: "",
        updatedAt: new Date().toISOString(),
        messageCount: 0,
        status: "idle",
        lastUserMessage: null,
        lastAssistantMessage: null,
        sessionFile: l.sessionFile,
        isSubAgent: true,
        parentSessionId: l.parentSessionId,
      });
    }
    return out;
  }

  async loadMessages(id: string): Promise<MessageDto[] | null> {
    const adapter = await this.resolve(id);
    if (!adapter) return null;
    return adapter.loadMessages(id);
  }

  /**
   * 轻量消息解析（已知 sessionFile 时直接读文件，跳过 findSession 的全量扫描）：
   * 子代理活动快照等聚合场景专用（每个子代理一次全量扫描会把聚合拖到秒级）。
   */
  async loadMessagesFast(id: string, sessionFile: string): Promise<MessageDto[]> {
    const source = this.sources.get(id);
    return source === "claude" ? loadClaudeSessionMessages(sessionFile) : loadSessionMessages(sessionFile);
  }

  /** 新建会话按 source 分发（缺省 pi；非法 source 由 routes 层拦截） */
  createSession(cwd: string, name?: string, source: SessionSource = "pi"): Promise<SessionListItem> {
    const adapter = source === "claude" ? this.claude : this.pi;
    if (!adapter.createSession) {
      throw new HubError(ErrorCodes.INVALID_REQUEST, `来源 ${source} 不支持新建会话`, 400);
    }
    return adapter.createSession(cwd, name);
  }

  /** 复制会话（fork）按 id 归属分发 */
  async forkSession(id: string): Promise<SessionListItem> {
    const adapter = await this.resolve(id);
    if (!adapter) {
      throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${id}`, 404);
    }
    return adapter.forkSession(id);
  }

  async prompt(
    id: string,
    text: unknown,
    modeRaw: unknown,
    images?: PromptImageAttachment[],
  ): Promise<PromptResult> {
    const adapter = await this.resolve(id);
    if (!adapter) {
      throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${id}`, 404);
    }
    return adapter.prompt(id, text, modeRaw, images);
  }

  async abort(id: string): Promise<void> {
    const adapter = await this.resolve(id);
    if (!adapter) return; // 幂等：不存在视为已中止
    await adapter.abort(id);
  }

  /** 手动压缩仅支持 pi；claude 会话由其自身 autocompact 管理 */
  async compact(id: string): Promise<void> {
    const adapter = await this.resolve(id);
    if (!adapter) {
      throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${id}`, 404);
    }
    if (!adapter.compact) {
      throw new HubError(
        ErrorCodes.INVALID_REQUEST,
        adapter.source === "claude"
          ? "Claude Code 会话不支持手动压缩（由 claude 自身 autocompact 管理）"
          : "该会话来源不支持手动压缩",
        400,
      );
    }
    await adapter.compact(id);
  }

  /** 跨会话搜索：聚合各 source（目前仅 pi 实现） */
  async search(query: string, limit?: number): Promise<import("../types.js").SearchResultDto[]> {
    const batches = await Promise.all(
      [this.pi, this.claude]
        .filter((a) => typeof a.search === "function")
        .map((a) => a.search!(query, limit).catch(() => [])),
    );
    return batches
      .flat()
      .sort((x, y) => Number(y.timestamp ?? 0) - Number(x.timestamp ?? 0))
      .slice(0, limit ?? 50);
  }

  /** 会话分支树（pi 树；claude 无树返回 null） */
  async loadTree(id: string): Promise<import("../types.js").SessionTreeDto | null> {
    const adapter = await this.resolve(id);
    return adapter?.loadTree ? adapter.loadTree(id) : null;
  }

  invalidateSearch(): void {
    this.pi.invalidateSearch?.();
    this.claude.invalidateSearch?.();
  }

  markLiveFeed(id: string): void {
    void this.resolve(id).then((a) => a?.markLiveFeed?.(id));
  }

  isSdkLive(id: string): boolean {
    return this.pi.isSdkLive?.(id) === true || this.claude.isSdkLive?.(id) === true;
  }

  disposeAll(): void {
    this.pi.disposeAll();
    this.claude.disposeAll();
  }
}
