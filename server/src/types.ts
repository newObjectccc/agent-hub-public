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
  /** 本页之前是否还有更早消息（分页查询时有效；全量返回恒 false） */
  hasMore: boolean;
  /** 下一页 before 游标（本页最早一条消息 id）；无更早消息为 null */
  nextBefore: string | null;
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

/** 统一错误信封 */
export interface ErrorEnvelope {
  error: { code: string; message: string };
}
