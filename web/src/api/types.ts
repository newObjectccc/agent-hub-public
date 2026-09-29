/**
 * 与 docs/API_CONTRACT.md 一一对应的数据类型（v0 契约，不得单方面改字段名）。
 */

export type SessionStatus = "idle" | "running" | "error";

/** 会话来源：pi（~/.pi/agent/sessions）或 claude（~/.claude/projects） */
export type SessionSource = "pi" | "claude";

export interface SessionSummary {
  id: string;
  /** 会话来源徽章（pi | claude） */
  source: SessionSource;
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

/** 树节点 role（树含全部 entry，比 MessageRole 多 system/other） */
export type TreeRole = MessageRole | "system" | "other";

/** GET /api/search 结果项（snippet 中命中词以 [[...]] 包裹） */
export interface SearchResult {
  sessionId: string;
  sessionName: string | null;
  messageId: string;
  role: MessageRole;
  snippet: string;
  timestamp: number; // pi 原始毫秒时间戳
}

export interface SearchResponse {
  results: SearchResult[];
}

/** GET /api/sessions/:id/tree 节点（先序 DFS 顺序） */
export interface TreeNode {
  id: string;
  parentId: string | null;
  role: TreeRole;
  text: string;
  timestamp: number;
  hasChildren: boolean;
}

/** GET /api/sessions/:id/tree 响应；activePath 为活跃分支 root→leaf 的 id 路径 */
export interface SessionTree {
  entries: TreeNode[];
  activePath: string[];
}

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
  claude: SystemComponent;
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
