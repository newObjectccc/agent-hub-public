/**
 * SessionHub：pi SDK 集成核心。
 * - 每个活跃会话一个 AgentSession 实例（内存记录运行态 idle|running|error）
 * - prompt 正忙且 mode 缺省 → SESSION_BUSY（由 prompt-policy 决策）
 * - 事件翻译为 docs/API_CONTRACT.md §4 的 WS 事件
 * - 进程退出时 disposeAll() 回收全部实例
 */
import { randomBytes } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { ErrorCodes, HubError } from "../errors.js";
import type { MessageDto, MessageRole, SearchResultDto, ServerEvent, SessionListItem, SessionStatus, SessionTreeDto, ToolCallStatus } from "../types.js";
import { decidePromptAction, parsePromptMode, type PromptMode } from "./prompt-policy.js";
import { SearchService, SEARCH_DEFAULT_LIMIT } from "./search.js";
import { inferExternalStatus } from "./tail.js";
import { loadSessionTree } from "./tree.js";
import {
  assistantToolCalls,
  contentToText,
  encodeCwdDirName,
  findSessionById,
  RESULT_PREVIEW_LIMIT,
  scanSessions,
  sessionFileName,
  summarizeToolCall,
  truncateText,
  loadSessionMessages,
} from "./scan.js";

export type EmitFn = (sessionId: string, event: ServerEvent) => void;

interface LiveSession {
  session: AgentSession;
  unsubscribe: () => void;
  /** 当前流式 assistant 消息的流内 id（message_start 分配） */
  currentMessageId: string | null;
  currentMessageStartTs: number | null;
  /** toolCallId → 结果（折叠进 assistant message_end 的 toolCalls） */
  toolResults: Map<string, { isError: boolean; text: string }>;
  seq: number;
}

export interface PromptResult {
  accepted: boolean;
  mode: PromptMode;
  busy?: boolean;
}

function msgRecord(message: unknown): Record<string, unknown> {
  return typeof message === "object" && message !== null ? (message as Record<string, unknown>) : {};
}

/** pi message role → 契约 role（system 等不进 chat） */
export function dtoRole(role: unknown): MessageRole | null {
  switch (role) {
    case "user":
    case "assistant":
    case "toolResult":
    case "custom":
      return role;
    default:
      return null;
  }
}

export class SessionHub {
  private readonly sessionDir: string;
  private readonly emit: EmitFn;
  private readonly live = new Map<string, LiveSession>();
  private readonly statuses = new Map<string, SessionStatus>();
  private readonly searchService: SearchService;
  private disposed = false;
  /** 会话转 live 时回调（用于停掉文件 tail，保持单一推送源，防重复气泡） */
  onLive?: (id: string) => void;

  constructor(sessionDir: string, emit: EmitFn) {
    this.sessionDir = sessionDir;
    this.emit = emit;
    this.searchService = new SearchService(sessionDir);
  }

  getStatus(id: string): SessionStatus {
    return this.statuses.get(id) ?? "idle";
  }

  /** 是否有本进程持有的 live AgentSession（有则事件由 SDK 推送，无需文件 tail） */
  isLive(id: string): boolean {
    return this.live.has(id);
  }

  /** 本进程运行态优先，否则按文件活动推断外部 running */
  private statusWithInference(id: string, updatedMs: number): SessionStatus {
    const own = this.statuses.get(id);
    if (own && own !== "idle") return own;
    return inferExternalStatus(updatedMs);
  }

  private setStatus(id: string, status: SessionStatus): void {
    if (this.getStatus(id) === status) return;
    this.statuses.set(id, status);
    this.emit(id, { type: "status", status });
  }

  /** 扫描列表（运行态注入：本进程优先 + 外部活动推断） */
  listSessions(): Promise<SessionListItem[]> {
    return scanSessions(this.sessionDir, { statusOf: (id, updatedMs) => this.statusWithInference(id, updatedMs) });
  }

  findSession(id: string): Promise<SessionListItem | null> {
    return findSessionById(this.sessionDir, id, { statusOf: (sid, updatedMs) => this.statusWithInference(sid, updatedMs) });
  }

  async loadMessages(id: string): Promise<MessageDto[] | null> {
    const found = await this.findSession(id);
    if (!found) return null;
    return loadSessionMessages(found.sessionFile);
  }

  /** 跨会话搜索（active branch 消息文本，内存缓存） */
  search(query: string, limit: number = SEARCH_DEFAULT_LIMIT): Promise<SearchResultDto[]> {
    return this.searchService.search(query, limit);
  }

  /** 会话分支树（JSONL id/parentId 构树） */
  async loadTree(id: string): Promise<SessionTreeDto | null> {
    const found = await this.findSession(id);
    if (!found) return null;
    return loadSessionTree(found.sessionFile);
  }

  /** 会话文件变更（presence 回调）→ 搜索索引失效 */
  invalidateSearch(): void {
    this.searchService.invalidate();
  }

  /**
   * 新建会话：直接落盘 JSONL header（pi 的 SessionManager 在首条 assistant
   * 消息前不写盘，这里显式写文件保证列表立即可见且与 pi CLI 互通）。
   */
  async createSession(cwd: string, name?: string): Promise<SessionListItem> {
    if (typeof cwd !== "string" || cwd.trim() === "") {
      throw new HubError(ErrorCodes.INVALID_CWD, "cwd 必须是非空绝对路径");
    }
    let isDir = false;
    try {
      isDir = (await stat(cwd)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      throw new HubError(ErrorCodes.INVALID_CWD, `cwd 不存在或不是目录: ${cwd}`);
    }

    const sessionId = randomBytes(16).toString("hex");
    const timestamp = new Date().toISOString();
    const dir = join(this.sessionDir, encodeCwdDirName(cwd));
    await mkdir(dir, { recursive: true });
    const file = join(dir, sessionFileName(timestamp, sessionId));

    const lines: string[] = [JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp, cwd })];
    const trimmedName = typeof name === "string" ? name.trim() : "";
    if (trimmedName !== "") {
      lines.push(
        JSON.stringify({
          type: "session_info",
          id: randomBytes(4).toString("hex"),
          parentId: null,
          timestamp,
          name: trimmedName,
        }),
      );
    }
    await writeFile(file, `${lines.join("\n")}\n`, { flag: "wx" });

    return {
      id: sessionId,
      name: trimmedName === "" ? null : trimmedName,
      cwd,
      updatedAt: timestamp,
      messageCount: 0,
      status: "idle",
      lastUserMessage: null,
      lastAssistantMessage: null,
      sessionFile: file,
    };
  }

  /** 取得（或创建）该会话的 AgentSession 实例 */
  async ensureLive(id: string): Promise<AgentSession> {
    const existing = this.live.get(id);
    if (existing) return existing.session;
    if (this.disposed) {
      throw new HubError(ErrorCodes.INTERNAL, "server 正在关闭", 503);
    }

    const found = await this.findSession(id);
    if (!found) {
      throw new HubError(ErrorCodes.SESSION_NOT_FOUND, `会话不存在: ${id}`, 404);
    }

    const manager = SessionManager.open(found.sessionFile);
    const { session } = await createAgentSession({
      sessionManager: manager,
      cwd: found.cwd !== "" ? found.cwd : undefined,
    });

    const liveSession: LiveSession = {
      session,
      currentMessageId: null,
      currentMessageStartTs: null,
      toolResults: new Map(),
      seq: 0,
      unsubscribe: () => undefined,
    };
    liveSession.unsubscribe = session.subscribe((event) => this.handleSdkEvent(id, liveSession, event));
    this.live.set(id, liveSession);
    this.onLive?.(id);
    return session;
  }

  /** 发送消息；决策见 prompt-policy（正忙且 mode 缺省 → busy） */
  async prompt(id: string, text: unknown, modeRaw: unknown): Promise<PromptResult> {
    if (typeof text !== "string" || text.trim() === "") {
      throw new HubError(ErrorCodes.INVALID_REQUEST, "text 必须是非空字符串");
    }
    const mode = parsePromptMode(modeRaw);
    if (mode === null) {
      throw new HubError(ErrorCodes.INVALID_REQUEST, `mode 必须是 prompt|steer|followUp 之一`);
    }

    const session = await this.ensureLive(id);
    const decision = decidePromptAction(!session.isIdle, mode);
    if (decision.kind === "busy") {
      return { accepted: false, mode: mode ?? "prompt", busy: true };
    }

    this.setStatus(id, "running");
    const run = (async () => {
      try {
        if (decision.kind === "steer") {
          await session.steer(text);
        } else if (decision.kind === "followUp") {
          await session.followUp(text);
        } else {
          await session.prompt(text);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.setStatus(id, "error");
        this.emit(id, { type: "error", code: ErrorCodes.PROMPT_FAILED, message });
      }
    })();
    // 不阻塞 HTTP 响应：实际输出走 WS 事件流
    void run;

    return { accepted: true, mode: decision.kind };
  }

  /** 中止当前运行（幂等） */
  async abort(id: string): Promise<void> {
    const live = this.live.get(id);
    if (!live) return;
    await live.session.abort();
    this.setStatus(id, "idle");
  }

  /** 手动压缩上下文 */
  async compact(id: string): Promise<void> {
    const session = await this.ensureLive(id);
    await session.compact();
  }

  /** 进程退出：dispose 所有 AgentSession 实例 */
  disposeAll(): void {
    this.disposed = true;
    for (const live of this.live.values()) {
      try {
        live.unsubscribe();
      } catch {
        // 忽略
      }
      try {
        live.session.dispose();
      } catch {
        // 忽略
      }
    }
    this.live.clear();
  }

  // ---- SDK 事件 → 契约 WS 事件 ----

  private handleSdkEvent(id: string, live: LiveSession, event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start": {
        this.setStatus(id, "running");
        break;
      }
      case "message_start": {
        const message = msgRecord(event.message);
        const role = dtoRole(message.role);
        // toolResult/system 的生命周期不单独推送（toolResult 折叠进 assistant）
        if (role === null || role === "toolResult") break;
        live.seq += 1;
        live.currentMessageId = `live-${live.seq}-${Date.now()}`;
        live.currentMessageStartTs = typeof message.timestamp === "number" ? message.timestamp : Date.now();
        live.toolResults.clear();
        this.emit(id, {
          type: "message_start",
          message: { id: live.currentMessageId, role, timestamp: live.currentMessageStartTs },
        });
        break;
      }
      case "message_update": {
        const ame = event.assistantMessageEvent as { type: string; delta?: string };
        if (ame && ame.type === "text_delta" && typeof ame.delta === "string" && live.currentMessageId) {
          this.emit(id, { type: "text_delta", messageId: live.currentMessageId, delta: ame.delta });
        }
        break;
      }
      case "tool_execution_start": {
        const messageId = live.currentMessageId ?? `live-${live.seq}`;
        this.emit(id, {
          type: "tool_start",
          messageId,
          toolCall: {
            name: event.toolName,
            summary: summarizeToolCall(event.toolName, event.args),
          },
        });
        break;
      }
      case "tool_execution_end": {
        const messageId = live.currentMessageId ?? `live-${live.seq}`;
        const result = event.result as { content?: unknown } | undefined;
        const preview = truncateText(contentToText(result?.content), RESULT_PREVIEW_LIMIT);
        live.toolResults.set(event.toolCallId, { isError: event.isError === true, text: preview });
        this.emit(id, {
          type: "tool_end",
          messageId,
          toolCall: {
            name: event.toolName,
            summary: summarizeToolCall(event.toolName, (event as { args?: unknown }).args),
            status: (event.isError === true ? "error" : "done") as ToolCallStatus,
            resultPreview: preview === "" ? null : preview,
          },
        });
        break;
      }
      case "message_end": {
        const message = msgRecord(event.message);
        const role = dtoRole(message.role);
        if (role === null || role === "toolResult") break;
        const liveId = live.currentMessageId ?? `live-${live.seq}`;
        const dto = this.buildMessageDto(live, liveId, role, message);
        // id 保持与 message_start/text_delta 一致（前端按 id upsert 替换流式占位）；
        // 不回填持久化 entry id——那会让前端找不到流式条目而追加出重复气泡。
        // 权威 entry id 只在全量对账（GET /api/sessions/:id）时使用，届时整体替换，无残留。
        this.emit(id, { type: "message_end", message: dto });
        if (role === "assistant") {
          live.currentMessageId = null;
          live.currentMessageStartTs = null;
        }
        break;
      }
      case "agent_settled": {
        this.emit(id, { type: "agent_settled" });
        this.setStatus(id, "idle");
        break;
      }
      case "compaction_end": {
        if (event.errorMessage) {
          this.emit(id, { type: "error", code: ErrorCodes.PROMPT_FAILED, message: event.errorMessage });
          this.setStatus(id, "error");
        }
        break;
      }
      default:
        break;
    }
  }

  private buildMessageDto(live: LiveSession, fallbackId: string, role: MessageRole, message: Record<string, unknown>): MessageDto {
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : (live.currentMessageStartTs ?? Date.now());
    const text = contentToText(message.content);
    if (role !== "assistant") {
      return { id: fallbackId, role, timestamp, text, toolCalls: [] };
    }
    const { toolCalls, byCallId } = assistantToolCalls(message);
    for (const [callId, ref] of byCallId) {
      const result = live.toolResults.get(callId);
      if (result) {
        ref.dto.status = result.isError ? "error" : "done";
        ref.dto.resultPreview = result.text === "" ? null : result.text;
      }
    }
    return { id: fallbackId, role, timestamp, text, toolCalls };
  }

  /** 从已持久化 entries 中按消息对象 identity / 时间戳解析 entry id */
  private findEntryId(live: LiveSession, message: Record<string, unknown>): string | null {
    try {
      const entries = live.session.sessionManager.getEntries();
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i] as { type?: string; id?: string; message?: unknown };
        if (entry.type !== "message" && entry.type !== "custom_message") continue;
        if (entry.message === message) return typeof entry.id === "string" ? entry.id : null;
      }
      const ts = message.timestamp;
      if (typeof ts === "number") {
        for (let i = entries.length - 1; i >= 0; i -= 1) {
          const entry = entries[i] as { type?: string; id?: string; message?: { timestamp?: unknown } };
          if (entry.type !== "message") continue;
          if (entry.message?.timestamp === ts) return typeof entry.id === "string" ? entry.id : null;
        }
      }
    } catch {
      // 解析失败退回流内 id
    }
    return null;
  }
}
