/**
 * PiAdapter：pi 会话来源的适配层（薄封装，逻辑在 sessions/hub.ts 的 SessionHub）。
 * pi 是 agent-hub 的核心来源，这里只补 source 抽象，不改动原有行为。
 */
import type { PromptResult, SessionHub } from "../sessions/hub.js";
import type { MessageDto, PromptImageAttachment, SessionListItem, SessionStatus } from "../types.js";
import type { SessionAdapter } from "./types.js";

export class PiAdapter implements SessionAdapter {
  readonly source = "pi" as const;
  private readonly hub: SessionHub;

  constructor(hub: SessionHub) {
    this.hub = hub;
  }

  /** onLive 转发到内层 SessionHub（ensureLive 触发停文件 tail，防双推送） */
  set onLive(fn: ((id: string) => void) | undefined) {
    this.hub.onLive = fn;
  }

  isLive(id: string): boolean {
    return this.hub.isLive(id);
  }

  getStatus(id: string): SessionStatus {
    return this.hub.getStatus(id);
  }

  listSessions(): Promise<SessionListItem[]> {
    return this.hub.listSessions();
  }

  findSession(id: string): Promise<SessionListItem | null> {
    return this.hub.findSession(id);
  }

  loadMessages(id: string): Promise<MessageDto[] | null> {
    return this.hub.loadMessages(id);
  }

  prompt(id: string, text: unknown, modeRaw: unknown, images?: PromptImageAttachment[]): Promise<PromptResult> {
    return this.hub.prompt(id, text, modeRaw, images);
  }

  abort(id: string): Promise<void> {
    return this.hub.abort(id);
  }

  createSession(cwd: string, name?: string): Promise<SessionListItem> {
    return this.hub.createSession(cwd, name);
  }

  forkSession(id: string): Promise<SessionListItem> {
    return this.hub.forkSession(id);
  }

  renameSession(id: string, name: string): Promise<SessionListItem> {
    return this.hub.renameSession(id, name);
  }

  compact(id: string, instructions?: string): Promise<void> {
    return this.hub.compact(id, instructions);
  }

  search(query: string, limit?: number): Promise<import("../types.js").SearchResultDto[]> {
    return this.hub.search(query, limit);
  }

  loadTree(id: string): Promise<import("../types.js").SessionTreeDto | null> {
    return this.hub.loadTree(id);
  }

  invalidateSearch(): void {
    this.hub.invalidateSearch();
  }

  markLiveFeed(id: string): void {
    this.hub.markLiveFeed(id);
  }

  isSdkLive(id: string): boolean {
    return this.hub.isSdkLive(id);
  }

  disposeAll(): void {
    this.hub.disposeAll();
  }
}
