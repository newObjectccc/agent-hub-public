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

/** WS server → client 事件（docs/API_CONTRACT.md §6 表格） */
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
  claude: ToolAvailability;
  tailscale: TailscaleStatus;
  sessionDir: string;
  workspaceRoot: string;
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
  text: string;
}

/** 统一错误信封 */
export interface ErrorEnvelope {
  error: { code: string; message: string };
}
