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

/* ===== git / 文件只读 API（docs/API_CONTRACT.md §6） ===== */

export interface GitDirtyFile {
  path: string;
  status: string;
  origPath: string | null;
}

export interface GitStatusResult {
  cwd: string;
  root: string;
  branch: string;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: GitDirtyFile[];
  dirtyCount: number;
}

export interface GitCommit {
  hash: string;
  author: string;
  authorDate: string;
  relativeTime: string;
  subject: string;
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
  upstream: string | null;
}

export interface GitDiffResult {
  root: string;
  file: string | null;
  commit: string | null;
  truncated: boolean;
  diff: string;
}

export interface FileContentResult {
  root: string;
  path: string;
  size: number;
  truncated: boolean;
  content: string;
}
