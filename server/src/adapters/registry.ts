/**
 * SessionRegistry：多 source 会话的合并与分发（实现 routes 的 SessionHubLike）。
 *
 * - GET /api/sessions：pi + claude 两源合并，按 updatedAt 倒序（同刻按 id 稳定排序）
 * - 其余操作按 id 归属分发：先查 claude（UUID 命名空间），未命中走 pi；
 *   两边都未命中 → SESSION_NOT_FOUND
 * - createSession 仅支持 pi（claude 会话由 Claude Code CLI 自己创建，v0 不做新建）
 * - compact 仅支持 pi（claude 的上下文压缩由其自身 autocompact 管理）
 *
 * id 冲突（理论上不可能：pi 为 32-hex、claude 为 UUID v4）时 claude 优先，按源缓存消歧。
 */
import { ErrorCodes, HubError } from "../errors.js";
import type { PromptResult } from "../sessions/hub.js";
import type { MessageDto, SessionListItem, SessionSource, SessionStatus } from "../types.js";
import type { ClaudeAdapter } from "./claude.js";
import type { SessionAdapter } from "./types.js";

export class SessionRegistry {
  private readonly pi: SessionAdapter;
  private readonly claude: SessionAdapter;
  /** id → source 记忆（getStatus/isLive 等同步路径消歧用） */
  private readonly sources = new Map<string, SessionSource>();
  /** 会话转 live 时回调（停文件 tail）；同时挂到两个适配器 */
  onLive?: (id: string) => void;

  constructor(pi: SessionAdapter, claude: SessionAdapter) {
    this.pi = pi;
    this.claude = claude;
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

  async loadMessages(id: string): Promise<MessageDto[] | null> {
    const adapter = await this.resolve(id);
    if (!adapter) return null;
    return adapter.loadMessages(id);
  }

  /** 新建会话固定走 pi（claude 会话由 Claude Code CLI 创建） */
  createSession(cwd: string, name?: string): Promise<SessionListItem> {
    if (!this.pi.createSession) {
      throw new HubError(ErrorCodes.INVALID_REQUEST, "pi 会话来源未启用，无法新建会话", 400);
    }
    return this.pi.createSession(cwd, name);
  }

  async prompt(id: string, text: unknown, modeRaw: unknown): Promise<PromptResult> {
    const adapter = await this.resolve(id);
    if (!adapter) {
      throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${id}`, 404);
    }
    return adapter.prompt(id, text, modeRaw);
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

  disposeAll(): void {
    this.pi.disposeAll();
    this.claude.disposeAll();
  }
}
