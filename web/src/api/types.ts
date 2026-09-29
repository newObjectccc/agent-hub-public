/**
 * 与 docs/API_CONTRACT.md 一一对应的数据类型（v0 契约，不得单方面改字段名）。
 */

export type SessionStatus = "idle" | "running" | "error";

export interface SessionSummary {
  id: string;
  name: string;
  cwd: string;
  updatedAt: string; // ISO 8601 UTC
  messageCount: number;
  status: SessionStatus;
  lastUserMessage: string | null;
  lastAssistantMessage: string | null;
  sessionFile: string | null;
}

export type MessageRole = "user" | "assistant" | "toolResult" | "custom";

export type ToolCallStatus = "pending" | "running" | "done" | "error";

export interface ToolCall {
  name: string;
  summary: string;
  status: ToolCallStatus;
  resultPreview: string | null;
}

export interface SessionMessage {
  id: string;
  role: MessageRole;
  timestamp: number; // pi 原始毫秒时间戳
  text: string;
  toolCalls: ToolCall[];
}

export interface SessionDetail {
  session: SessionSummary;
  messages: SessionMessage[];
  /** 本页之前是否还有更早消息（分页查询时有效；全量返回恒 false） */
  hasMore: boolean;
  /** 下一页 before 游标（本页最早一条消息 id）；无更早消息为 null */
  nextBefore: string | null;
}

export interface KpiCard {
  id: string;
  title: string;
  value: string;
  trend: "up" | "down" | "flat" | "unknown";
  delta: string | null;
  updatedAt: string | null;
  link: string | null;
  error: string | null;
}

export interface KpiResponse {
  cards: KpiCard[];
}

export interface SystemComponent {
  available: boolean;
  version: string | null;
}

export interface SystemStatus {
  platform: "darwin" | "win32" | "linux" | string;
  pi: SystemComponent;
  tmux: SystemComponent;
  ttyd: SystemComponent;
  tailscale: SystemComponent & { loggedIn?: boolean; hostname?: string | null };
  sessionDir: string;
  workspaceRoot: string;
}

export interface PromptResult {
  accepted: boolean;
  mode: "prompt" | "steer" | "followUp";
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}
