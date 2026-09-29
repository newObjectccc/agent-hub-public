/**
 * API 契约 DTO 类型（docs/API_CONTRACT.md 的 TypeScript 表达）。
 * 字段名/路径与契约一一对应，任何一方不得单方面修改。
 */

export type SessionStatus = "idle" | "running" | "error";

/** 会话来源：pi（~/.pi/agent/sessions）或 claude（~/.claude/projects） */
export type SessionSource = "pi" | "claude";

/** GET /api/sessions 列表项 */
export interface SessionListItem {
  id: string;
  /** 会话来源（pi | claude） */
  source: SessionSource;
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
  /** 思维链全文（assistant 的 thinking 块）；无思维链为 null；claude 适配层暂缺省 */
  thinking?: string | null;
  toolCalls: ToolCallDto[];
}

export interface SessionDetail {
  session: SessionListItem;
  messages: MessageDto[];
  /** 本页之前是否还有更早消息（分页查询时有效；全量返回恒 false） */
  hasMore: boolean;
  /** 下一页 before 游标（本页最早一条消息 id）；无更早消息为 null */
  nextBefore: string | null;
}

/** WS server → client 事件（docs/API_CONTRACT.md §6 表格） */
export type ServerEvent =
  | { type: "session"; id: string; cwd: string }
  | { type: "message_start"; message: { id: string; role: MessageRole; timestamp: number } }
  | { type: "text_delta"; messageId: string; delta: string }
  | { type: "thinking_delta"; messageId: string; delta: string }
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
  claude: ToolAvailability;
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

/** GET /api/dashboard/stats：运行看板卡（工作中会话的实时进度） */
export interface WorkingSessionCard {
  id: string;
  name: string | null;
  cwd: string;
  status: SessionStatus;
  /** 当前 run 起点（active branch 最后一条用户消息时间） */
  startedAt: string | null;
  /** 当前/最近一次工具调用摘要 */
  currentTool: string | null;
  /** 最后输出摘要（最后一条 assistant 文本） */
  lastOutput: string | null;
  updatedAt: string;
}

/** GET /api/dashboard/stats：等你处理卡（agent 干完/出错的会话） */
export interface AttentionSessionCard {
  id: string;
  name: string | null;
  cwd: string;
  status: SessionStatus;
  /** settled=agent 干完等你输入；error=运行出错 */
  reason: "settled" | "error";
  summary: string | null;
  updatedAt: string;
}

/** GET /api/dashboard/stats 响应（首页今日概览 + 分区列表，真实数据推导） */
export interface DashboardStats {
  working: number;
  needAttention: number;
  todayDone: number;
  todayMessages: number;
  weekCommits: number;
  /** 连续活跃天数（截至最近活跃日；今日未活跃不渐裂） */
  streak: number;
  /** 本周（周一起）消息总数 */
  weekMessages: number;
  /** 本周完成会话数（本周内至少完成一轮的会话） */
  weekDone: number;
  /** 今日完成一轮及以上的会话 id（前端 tab 过滤用） */
  todayDoneSessions: string[];
  workingSessions: WorkingSessionCard[];
  attentionSessions: AttentionSessionCard[];
}

/** 通知类型：settled=本轮干完；error=出错；steering=被插话；done=手动中止 */
export type NotificationKind = "settled" | "error" | "steering" | "done";

/** GET /api/notifications 通知项（从会话事件聚合） */
export interface NotificationItem {
  id: string;
  sessionId: string;
  sessionName: string | null;
  kind: NotificationKind;
  text: string;
  timestamp: string;
  read: boolean;
}

/** GET /api/notifications 响应 */
export interface NotificationListResponse {
  notifications: NotificationItem[];
  unreadCount: number;
}

/** 会话运行活动（SessionHub.onActivity 上报：steering=插话/排队；done=手动中止） */
export interface HubActivity {
  kind: Extract<NotificationKind, "steering" | "done">;
  text: string;}

/** 统一错误信封 */
export interface ErrorEnvelope {
  error: { code: string; message: string };
}
