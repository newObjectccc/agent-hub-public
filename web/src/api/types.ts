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

export interface SystemComponent {
  available: boolean;
  version: string | null;
}

export interface SystemStatus {
  platform: "darwin" | "win32" | "linux" | string;
  pi: SystemComponent;
  tmux: SystemComponent;
  ttyd: SystemComponent;
  /** 可选增强（老 server 可能没有此字段） */
  claude?: SystemComponent;
  tailscale: SystemComponent & { loggedIn?: boolean; hostname?: string | null };
  sessionDir: string;
  workspaceRoot: string;
}

export interface PromptResult {
  accepted: boolean;
  mode: "prompt" | "steer" | "followUp";
}

/** GET /api/dashboard/stats：运行看板卡（工作中会话的实时进度） */
export interface WorkingSessionCard {
  id: string;
  name: string | null;
  cwd: string;
  status: SessionStatus;
  /** 当前 run 起点（最后一条用户消息时间） */
  startedAt: string | null;
  /** 当前/最近一次工具调用摘要 */
  currentTool: string | null;
  /** 最后输出摘要 */
  lastOutput: string | null;
  updatedAt: string;
}

/** GET /api/dashboard/stats：等你处理卡（agent 干完/出错的会话） */
export interface AttentionSessionCard {
  id: string;
  name: string | null;
  cwd: string;
  status: SessionStatus;
  reason: "settled" | "error";
  summary: string | null;
  updatedAt: string;
}

/** GET /api/dashboard/stats 响应（首页今日概览 + 分区，真实数据推导） */
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
  /** 本周完成会话数 */
  weekDone: number;
  /** 今日完成一轮及以上的会话 id（tab 过滤用） */
  todayDoneSessions: string[];
  workingSessions: WorkingSessionCard[];
  attentionSessions: AttentionSessionCard[];
}

/** 通知类型：settled=本轮干完；error=出错；steering=被插话；done=手动中止 */
export type NotificationKind = "settled" | "error" | "steering" | "done";

/** GET /api/notifications 通知项 */
export interface NotificationItem {
  id: string;
  sessionId: string;
  sessionName: string | null;
  kind: NotificationKind;
  text: string;
  timestamp: string;
  read: boolean;
}

export interface NotificationListResponse {
  notifications: NotificationItem[];
  unreadCount: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}
