/**
 * 会话 source 适配层抽象（pi / claude 两个来源共用一套契约 DTO）。
 *
 * - pi：~/.pi/agent/sessions/（session-format v3 JSONL，SDK in-process 驱动）
 * - claude：~/.claude/projects/（Claude Code transcript JSONL，本地 spawn claude CLI 驱动）
 *
 * 适配器只负责「列表 / 详情 / prompt / abort / createSession / forkSession」六件事；
 * 合并排序与按 id 分发由 registry.ts 统一处理。
 */
import type { PromptResult } from "../sessions/hub.js";
import type { SearchResultDto, SessionTreeDto } from "../types.js";
import type { MessageDto, SessionListItem, SessionSource, SessionStatus } from "../types.js";

export type { PromptResult };
export type { SessionSource };

/** 单一来源会话适配器（pi / claude 各实现一份） */
export interface SessionAdapter {
  readonly source: SessionSource;
  /** 本进程是否正驱动该会话（有则事件由驱动层推送，文件 tail 停止） */
  isLive(id: string): boolean;
  getStatus(id: string): SessionStatus;
  listSessions(): Promise<SessionListItem[]>;
  findSession(id: string): Promise<SessionListItem | null>;
  loadMessages(id: string): Promise<MessageDto[] | null>;
  prompt(id: string, text: unknown, modeRaw: unknown): Promise<PromptResult>;
  abort(id: string): Promise<void>;
  /** 新建会话（pi：JSONL header 落盘；claude：空白 transcript 会话文件） */
  createSession?(cwd: string, name?: string): Promise<SessionListItem>;
  /** 复制会话（fork）：基于完整上下文生成独立新会话文件，原会话只读不受影响 */
  forkSession(id: string): Promise<SessionListItem>;
  /** 手动压缩上下文（仅 pi 支持；claude 由其自身 autocompact 管理） */
  compact?(id: string): Promise<void>;
  /** 跨会话搜索（目前仅 pi 实现；claude 留待后续） */
  search?(query: string, limit?: number): Promise<SearchResultDto[]>;
  /** 会话分支树（仅 pi 的 JSONL 树） */
  loadTree?(id: string): Promise<SessionTreeDto | null>;
  /** 文件变更后失效搜索缓存 */
  invalidateSearch?(): void;
  /** live-feed 标记：扩展推送过事件的会话（10 分钟窗口，防文件 tail 双推送） */
  markLiveFeed?(id: string): void;
  isSdkLive?(id: string): boolean;
  /** 进程退出时回收（pi：dispose SDK 实例；claude：杀掉 spawn 的子进程） */
  disposeAll(): void;
}
