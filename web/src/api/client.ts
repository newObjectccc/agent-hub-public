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
  TerminalSession,
  TerminalStatus,
  ApiErrorBody,
  FileContentResult,
  GitBranchInfo,
  GitCommit,
  GitDiffResult,
  GitStatusResult,
  UploadResponse,
  UsageOverview,
  UsageSessionDetail,
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

/** 默认请求超时（P2）：弱网挂起时 fetch 永不落定 → UI 永久 loading，30s 兜底中止 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** 超时统一友好文案（不裸露 DOMException） */
export const TIMEOUT_MESSAGE = "网络请求超时，请检查网络后重试";

/**
 * 超时判定：AbortSignal.timeout 以 TimeoutError 为 abort reason（fetch/读 body 抛同名错误）。
 * 调用方主动 abort（AbortError）不算超时，原样抛出保持既有重试/取消语义。
 */
function isTimeoutError(e: unknown, signal: AbortSignal): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "TimeoutError") return true;
  const reason = signal.reason as { name?: unknown } | null | undefined;
  return signal.aborted === true && reason?.name === "TimeoutError";
}

/** 超时信号 + 生命周期句柄（降级路径需清理定时器，且旧 API 无 signal.reason 需自报超时） */
interface TimeoutSignal {
  signal: AbortSignal;
  /** 是否由本看门狗触发的中止（旧 WebView 无 signal.reason，isTimeoutError 判不出来） */
  didTimeout: () => boolean;
  /** 请求落定后调用：清定时器，不遗留挂起的 setTimeout */
  cancel: () => void;
}

/** feature detect：旧 WebView（iOS Safari < 15.4 等）没有 AbortSignal.timeout */
function hasNativeTimeoutSignal(): boolean {
  return (
    typeof AbortSignal !== "undefined" &&
    typeof (AbortSignal as { timeout?: unknown }).timeout === "function"
  );
}

/**
 * 超时信号（兼容降级）：AbortSignal.timeout 可用则直接用；
 * 否则降级 AbortController + setTimeout（旧 WebView 不因缺 API 崩溃）。
 * 降级路径 abort 不带 reason（旧 API 也读不到 signal.reason），
 * 超时判定由 didTimeout() 兑底，与原生路径同样映射友好文案。
 */
export function timeoutSignal(ms: number): TimeoutSignal {
  if (hasNativeTimeoutSignal()) {
    return {
      signal: AbortSignal.timeout(ms),
      didTimeout: () => false, // 原生路径交给 isTimeoutError（TimeoutError reason）判定
      cancel: () => {},
    };
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cancel: () => clearTimeout(timer),
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // P2：未自带 signal 时默认 30s 超时；调用方 signal 原样透传（保持兼容，不做二次兜底）
  const watchdog = init?.signal ? null : timeoutSignal(DEFAULT_REQUEST_TIMEOUT_MS);
  const signal = init?.signal ?? watchdog!.signal;
  try {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      ...init,
      signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch (e) {
      // 读 body 阶段超时同样走友好文案；其余解析失败维持旧行为（body=null）
      if (isTimeoutError(e, signal)) throw e;
      body = null;
    }
    if (!res.ok) {
      const err = (body as ApiErrorBody | null)?.error;
      throw new ApiError(res.status, err?.code ?? "HTTP_ERROR", err?.message ?? `请求失败（${res.status}）`);
    }
    return body as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (isTimeoutError(e, signal) || watchdog?.didTimeout() === true) {
      throw new ApiError(0, "TIMEOUT", TIMEOUT_MESSAGE);
    }
    throw e;
  } finally {
    watchdog?.cancel();
  }
}

export { request };

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

  /** 重命名会话（POST /api/sessions/:id/rename）：name 空串 = 清空名字（契约 §1） */
  renameSession(id: string, name: string): Promise<{ session: SessionSummary }> {
    return request(`/api/sessions/${encodeURIComponent(id)}/rename`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  },

  /** 发送消息（契约 §1）；images 为上传图片引用路径（pi 直接附图，契约 §11）；
   *  clientMessageId 幂等键（乐观占位 localId，弱网重发同键由 server 去重，防同文双发）；signal 可选超时/中止 */
  sendPrompt(
    id: string,
    text: string,
    mode: PromptMode = "prompt",
    images?: string[],
    clientMessageId?: string,
    signal?: AbortSignal,
  ): Promise<PromptResult> {
    return request(`/api/sessions/${encodeURIComponent(id)}/prompt`, {
      method: "POST",
      body: JSON.stringify({
        text,
        mode,
        ...(images && images.length > 0 ? { images } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
      }),
      signal,
    });
  },

  /** 上传文件（契约 §11）：base64 JSON，落盘会话 cwd/.agent-hub-uploads/；signal 可选超时/中止 */
  uploadFile(
    input: {
      sessionId?: string;
      cwd?: string;
      name: string;
      mimeType: string;
      /** 纯 base64（不含 data: 前缀） */
      data: string;
    },
    signal?: AbortSignal,
  ): Promise<UploadResponse> {
    return request("/api/uploads", {
      method: "POST",
      body: JSON.stringify(input),
      signal,
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
    signal?: AbortSignal,
  ): Promise<AttachMessageResult> {
    return request(`/api/sessions/${encodeURIComponent(id)}/message`, {
      method: "POST",
      body: JSON.stringify(clientMessageId ? { text, mode, clientMessageId } : { text, mode }),
      signal,
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

  /** GET /api/usage：Token 用量全局汇总（?days=N 自定义时间窗，契约 §14，pi 源） */
  getUsage(opts: { days?: number } = {}): Promise<UsageOverview> {
    const params = new URLSearchParams();
    if (opts.days !== undefined) params.set("days", String(opts.days));
    const qs = params.toString();
    return request(`/api/usage${qs ? `?${qs}` : ""}`);
  },

  /** GET /api/usage?sessionId=：单会话 Token 用量汇总（契约 §14） */
  getSessionUsage(id: string, opts: { days?: number } = {}): Promise<UsageSessionDetail> {
    const params = new URLSearchParams({ sessionId: id });
    if (opts.days !== undefined) params.set("days", String(opts.days));
    return request(`/api/usage?${params.toString()}`);
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

  /* ===== ttyd Web 终端（契约 §13） ===== */

  /** GET /api/terminal/status：可用性 + 运行态 + 降级提示（不拉起进程） */
  getTerminalStatus(): Promise<TerminalStatus> {
    return request("/api/terminal/status");
  },

  /** POST /api/terminal/session：按需拉起 ttyd 并签发同源反代 URL */
  startTerminalSession(): Promise<TerminalSession> {
    return request("/api/terminal/session", { method: "POST", body: JSON.stringify({}) });
  },

  /** POST /api/terminal/stop：回收 ttyd（幂等） */
  stopTerminal(): Promise<{ stopped: boolean }> {
    return request("/api/terminal/stop", { method: "POST", body: JSON.stringify({}) });
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
