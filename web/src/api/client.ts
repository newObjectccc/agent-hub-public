/**
 * REST 客户端：严格按 docs/API_CONTRACT.md 调用。
 * 错误统一为 { error: { code, message } }，这里归一为 ApiError。
 */
import type {
  AttachMessageResult,
  AttachResult,
  CommandList,
  DashboardStats,
  FsTree,
  NotificationListResponse,
  PromptResult,
  SearchResponse,
  SessionDetail,
  SessionSource,
  SessionSummary,
  SessionTree,
  SubAgentsResponse,
  SystemStatus,
  ApiErrorBody,
  FileContentResult,
  GitBranchInfo,
  GitCommit,
  GitDiffResult,
  GitStatusResult,
  UploadResponse,
} from "./types";

export type PromptMode = "prompt" | "steer" | "followUp";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, err?.code ?? "HTTP_ERROR", err?.message ?? `请求失败（${res.status}）`);
  }
  return body as T;
}

export const api = {
  listSessions(): Promise<{ sessions: SessionSummary[] }> {
    return request("/api/sessions");
  },

  /** 会话详情 + 消息（可选分页：?before=<messageId>&limit=<n>，契约 §1） */
  getSession(id: string, opts: { before?: string; limit?: number } = {}): Promise<SessionDetail> {
    const params = new URLSearchParams();
    if (opts.before) params.set("before", opts.before);
    if (opts.limit != null) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return request(`/api/sessions/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`);
  },

  /** 跨会话搜索（GET /api/search?q=&limit=） */
  search(q: string, limit?: number): Promise<SearchResponse> {
    const params = new URLSearchParams({ q });
    if (limit !== undefined) params.set("limit", String(limit));
    return request(`/api/search?${params.toString()}`);
  },

  /** 会话分支树（GET /api/sessions/:id/tree） */
  getSessionTree(id: string): Promise<SessionTree> {
    return request(`/api/sessions/${encodeURIComponent(id)}/tree`);
  },

  /** 子代理活动快照（GET /api/sessions/:id/agents，反馈轮 3 #4） */
  getSessionAgents(id: string): Promise<SubAgentsResponse> {
    return request(`/api/sessions/${encodeURIComponent(id)}/agents`);
  },

  createSession(cwd: string, name?: string, source?: SessionSource): Promise<{ session: SessionSummary }> {
    return request("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ cwd, name, source }),
    });
  },

  /** 复制会话（fork）：基于完整上下文生成独立新会话（契约 §1） */
  forkSession(id: string): Promise<{ session: SessionSummary }> {
    return request(`/api/sessions/${encodeURIComponent(id)}/fork`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  /** 发送消息（契约 §1）；images 为上传图片引用路径（pi 直接附图，契约 §11） */
  sendPrompt(id: string, text: string, mode: PromptMode = "prompt", images?: string[]): Promise<PromptResult> {
    return request(`/api/sessions/${encodeURIComponent(id)}/prompt`, {
      method: "POST",
      body: JSON.stringify(images && images.length > 0 ? { text, mode, images } : { text, mode }),
    });
  },

  /** 上传文件（契约 §11）：base64 JSON，落盘会话 cwd/.agent-hub-uploads/ */
  uploadFile(input: {
    sessionId?: string;
    cwd?: string;
    name: string;
    mimeType: string;
    /** 纯 base64（不含 data: 前缀） */
    data: string;
  }): Promise<UploadResponse> {
    return request("/api/uploads", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  abortSession(id: string): Promise<{ aborted: boolean }> {
    return request(`/api/sessions/${encodeURIComponent(id)}/abort`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  /* ===== 终端接管 / 指令队列（E3 双模式，契约 §12） ===== */

  /** POST /api/sessions/:id/attach：接管会话（进入 attach 模式，需终端 pi 在线） */
  attachSession(id: string): Promise<AttachResult> {
    return request(`/api/sessions/${encodeURIComponent(id)}/attach`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  /** POST /api/sessions/:id/detach：退出接管（恢复 parallel 通道） */
  detachSession(id: string): Promise<{ attached: boolean }> {
    return request(`/api/sessions/${encodeURIComponent(id)}/detach`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  /** POST /api/sessions/:id/message：attach 模式发消息 → 入终端指令队列（clientMessageId 幂等） */
  sendAttachMessage(
    id: string,
    text: string,
    mode: "prompt" | "steer" | "followUp",
    clientMessageId?: string,
  ): Promise<AttachMessageResult> {
    return request(`/api/sessions/${encodeURIComponent(id)}/message`, {
      method: "POST",
      body: JSON.stringify(clientMessageId ? { text, mode, clientMessageId } : { text, mode }),
    });
  },

  compactSession(id: string): Promise<{ ok: boolean }> {
    return request(`/api/sessions/${encodeURIComponent(id)}/compact`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  getDashboardStats(): Promise<DashboardStats> {
    return request("/api/dashboard/stats");
  },

  getNotifications(): Promise<NotificationListResponse> {
    return request("/api/notifications");
  },

  /** POST /api/notifications/read：ids 缺省=全部已读；带 ids=单条/多条已读 */
  markNotificationsRead(ids?: string[]): Promise<{ ok: boolean; unreadCount: number }> {
    return request("/api/notifications/read", {
      method: "POST",
      body: JSON.stringify(ids === undefined ? {} : { ids }),
    });
  },

  getSystem(): Promise<SystemStatus> {
    return request("/api/system");
  },

  /* ===== git / 文件只读 API（契约 §6） ===== */

  getGitStatus(cwd: string): Promise<GitStatusResult> {
    return request(`/api/git/status?cwd=${encodeURIComponent(cwd)}`);
  },

  getGitLog(cwd: string, limit = 20): Promise<{ commits: GitCommit[] }> {
    return request(`/api/git/log?cwd=${encodeURIComponent(cwd)}&limit=${encodeURIComponent(limit)}`);
  },

  getGitDiff(cwd: string, file: string | null = null, commit: string | null = null): Promise<GitDiffResult> {
    const params = new URLSearchParams({ cwd });
    if (file) params.set("file", file);
    if (commit) params.set("commit", commit);
    return request(`/api/git/diff?${params.toString()}`);
  },

  getGitBranches(cwd: string): Promise<{ branches: GitBranchInfo[]; current: string | null }> {
    return request(`/api/git/branches?cwd=${encodeURIComponent(cwd)}`);
  },

  getFileContent(cwd: string, path: string): Promise<FileContentResult> {
    return request(`/api/files/content?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`);
  },

  /* ===== slash 命令清单 + 文件树（契约 §8/§9） ===== */

  /** GET /api/commands?source=pi|claude */
  getCommands(source: SessionSource): Promise<CommandList> {
    return request(`/api/commands?source=${encodeURIComponent(source)}`);
  },

  /** GET /api/fs/tree?cwd=&path=&q=&hidden=（只读单层目录） */
  getFsTree(cwd: string, opts: { path?: string; q?: string; hidden?: boolean } = {}): Promise<FsTree> {
    const params = new URLSearchParams({ cwd });
    if (opts.path) params.set("path", opts.path);
    if (opts.q) params.set("q", opts.q);
    if (opts.hidden) params.set("hidden", "1");
    return request(`/api/fs/tree?${params.toString()}`);
  },
};
