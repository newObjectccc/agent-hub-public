/**
 * REST 客户端：严格按 docs/API_CONTRACT.md 调用。
 * 错误统一为 { error: { code, message } }，这里归一为 ApiError。
 */
import type {
  DashboardStats,
  NotificationListResponse,
  PromptResult,
  SessionDetail,
  SessionSummary,
  SystemStatus,
  ApiErrorBody,
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

  getSession(id: string): Promise<SessionDetail> {
    return request(`/api/sessions/${encodeURIComponent(id)}`);
  },

  createSession(cwd: string, name?: string): Promise<{ session: SessionSummary }> {
    return request("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ cwd, name }),
    });
  },

  sendPrompt(id: string, text: string, mode: PromptMode = "prompt"): Promise<PromptResult> {
    return request(`/api/sessions/${encodeURIComponent(id)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text, mode }),
    });
  },

  abortSession(id: string): Promise<{ aborted: boolean }> {
    return request(`/api/sessions/${encodeURIComponent(id)}/abort`, {
      method: "POST",
      body: JSON.stringify({}),
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

  markNotificationsRead(): Promise<{ ok: boolean; unreadCount: number }> {
    return request("/api/notifications/read", {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  getSystem(): Promise<SystemStatus> {
    return request("/api/system");
  },
};
