/**
 * API 契约 DTO 类型（docs/API_CONTRACT.md 的 TypeScript 表达）。
 * 字段名/路径与契约一一对应，任何一方不得单方面修改。
 */

export type SessionStatus = "idle" | "running" | "error";

/** GET /api/sessions 列表项 */
export interface SessionListItem {
  id: string;
  name: string | null;
  cwd: string;
  updatedAt: string;
  messageCount: number;
  status: SessionStatus;
  lastUserMessage: string | null;
  lastAssistantMessage: string | null;
  sessionFile: string;
}

export type ToolCallStatus = "pending" | "running" | "done" | "error";

/** 会话消息中的工具调用（toolResult 折叠进产生它的 assistant 消息） */
export interface ToolCallDto {
  name: string;
  summary: string;
  status: ToolCallStatus;
  resultPreview: string | null;
}

export type MessageRole = "user" | "assistant" | "toolResult" | "custom";

/** GET /api/sessions/:id/tree 的节点 role（树含全部 entry，比 MessageRole 多 system/other） */
export type TreeRole = "user" | "assistant" | "toolResult" | "custom" | "system" | "other";

/** GET /api/search 结果项（snippet 中命中词以 [[...]] 包裹） */
export interface SearchResultDto {
  sessionId: string;
  sessionName: string | null;
  /** 命中消息的 entry id（chat 页精确锚点） */
  messageId: string;
  role: MessageRole;
  snippet: string;
  /** 毫秒时间戳（pi 原始值） */
  timestamp: number;
}

/** GET /api/sessions/:id/tree 节点（先序 DFS 顺序） */
export interface TreeNodeDto {
  id: string;
  parentId: string | null;
  role: TreeRole;
  /** 摘要文本（TREE_SUMMARY_LIMIT 截断） */
  text: string;
  /** 毫秒时间戳（pi 原始值） */
  timestamp: number;
  hasChildren: boolean;
}

/** GET /api/sessions/:id/tree 响应；activePath 为活跃分支 root→leaf 的 id 路径 */
export interface SessionTreeDto {
  entries: TreeNodeDto[];
  activePath: string[];
}

/** GET /api/sessions/:id 与 WS message_end 的消息结构 */
export interface MessageDto {
  id: string;
  role: MessageRole;
  /** 毫秒时间戳（pi 原始值） */
  timestamp: number;
  text: string;
  toolCalls: ToolCallDto[];
}

export interface SessionDetail {
  session: SessionListItem;
  messages: MessageDto[];
}

/** WS server → client 事件（docs/API_CONTRACT.md §4 表格） */
export type ServerEvent =
  | { type: "session"; id: string; cwd: string }
  | { type: "message_start"; message: { id: string; role: MessageRole; timestamp: number } }
  | { type: "text_delta"; messageId: string; delta: string }
  | { type: "tool_start"; messageId: string; toolCall: { name: string; summary: string } }
  | {
      type: "tool_end";
      messageId: string;
      toolCall: { name: string; summary: string; status: ToolCallStatus; resultPreview: string | null };
    }
  | { type: "message_end"; message: MessageDto }
  | { type: "agent_settled" }
  | { type: "status"; status: SessionStatus }
  | { type: "error"; code: string; message: string }
  | { type: "pong" };

/** KPI 卡片（docs/API_CONTRACT.md §3） */
export interface KpiCard {
  id: string;
  title: string;
  value: string;
  trend: "up" | "down" | "flat" | "unknown";
  delta: string | null;
  updatedAt: string;
  link: string | null;
  error: string | null;
}

/** GET /api/system 响应 */
export interface ToolAvailability {
  available: boolean;
  version: string | null;
}

export interface TailscaleStatus extends ToolAvailability {
  loggedIn: boolean;
  hostname: string | null;
}

export interface SystemInfo {
  platform: "darwin" | "win32" | "linux" | string;
  pi: ToolAvailability;
  tmux: ToolAvailability;
  ttyd: ToolAvailability;
  tailscale: TailscaleStatus;
  sessionDir: string;
  workspaceRoot: string;
}

/** ===== git / 文件只读 API（docs/API_CONTRACT.md §6） ===== */

/** GET /api/git/status 的 dirty 文件项（status 为 porcelain 状态字母，如 "M"/"??"/"MM"） */
export interface GitDirtyFile {
  path: string;
  status: string;
  origPath: string | null;
}

/** GET /api/git/status 响应 */
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

/** GET /api/git/log 的提交项（hash 为短 hash） */
export interface GitCommit {
  hash: string;
  author: string;
  authorDate: string;
  relativeTime: string;
  subject: string;
}

/** GET /api/git/branches 的分支项 */
export interface GitBranchInfo {
  name: string;
  current: boolean;
  upstream: string | null;
}

/** GET /api/git/diff 响应（unified diff 原文） */
export interface GitDiffResult {
  root: string;
  file: string | null;
  commit: string | null;
  truncated: boolean;
  diff: string;
}

/** GET /api/files/content 响应（纯文本，语法高亮由前端做） */
export interface FileContentResult {
  root: string;
  path: string;
  size: number;
  truncated: boolean;
  content: string;
}

/** 统一错误信封 */
export interface ErrorEnvelope {
  error: { code: string; message: string };
}
