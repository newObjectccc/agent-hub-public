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
  /**
   * pi-subagents 派生的子代理会话（命名 `<type>#<id>` 如 developer#abc123，
   * 或入口消息含派生特征）。渲染容错：缺省按主会话（`!== true`）处理。
   */
  isSubAgent: boolean;
  /**
   * 血缘父会话 id（pi header.parentSession 解析）：pi-subagents 派生 / fork 分支均带；
   * claude 恒 null，识别不出为 null（归"未归组子代理"兜底分组）。渲染容错：`?? null`。
   */
  parentSessionId?: string | null;
  /**
   * 最后驱动来源（契约 §1）：面板驱动过（手机/网页 POST prompt）→ "panel"，否则 "terminal"。
   * 可缺省（老 server）：渲染容错按 "terminal"。手机面板发消息 = server 的 pi SDK 实例
   * 驱动同一会话文件，电脑终端 pi 需 pi --resume 重开才能看到。
   */
  lastDrivenBy?: "panel" | "terminal";
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
  /**
   * 执行时长计时（纯前端本地时钟，WS tool_start/tool_end 打点；server DTO 可缺省）：
   * running 卡片实时显示已运行时长，done/error 显示总耗时。
   */
  startedAt?: number;
  endedAt?: number;
}

/** 消息内嵌图片（pi ImageContent / claude image block → data URL 或 http(s) URL） */
export interface MessageImage {
  url: string;
  alt: string | null;
}

export interface SessionMessage {
  id: string;
  role: MessageRole;
  timestamp: number; // pi 原始毫秒时间戳
  text: string;
  /** 思维链全文（thinking 块）；无思维链为 null。server 始终下发，缺省视为无 */
  thinking?: string | null;
  toolCalls: ToolCall[];
  /** 内嵌图片（无图缺省）；按序渲染为 <img>（max-width 100%，不拦截长按） */
  images?: MessageImage[];
  /**
   * 流式进行中（message_start → message_end 之间为 true）：
   * 空内容时渲染"回复中"活占位（绝不显示"（无内容）"），气泡带进行中视觉。
   * 历史/权威消息缺省视为已 settle。
   */
  streaming?: boolean;
}

/**
 * 子代理活动（pi-subagents 派生会话，按 parentSessionId 归属父会话）：
 * GET /api/sessions/:id/agents 全量快照 + WS `subagent_activity` 增量推送共用。
 */
export interface SubAgentActivity {
  sessionId: string;
  /** 子代理会话名（`<type>#<id>`，如 developer#abc123） */
  name: string;
  status: SessionStatus;
  /** 当前/最近工具 summary（"正在执行：<currentTool>"） */
  currentTool: string | null;
  /** currentTool 是否仍在执行 */
  toolRunning: boolean;
  /** 最新输出摘要（最后一条 assistant 文本，截断） */
  lastOutput: string | null;
  /** 首次活动时间（ms），用于"已运行时长" */
  startedAt: number | null;
  updatedAt: number;
  /** 已结束（agent_settled / idle）：卡片转"✅ 完成，点击查看结果" */
  done: boolean;
  /** 完成后的结果摘要（最后一条 assistant 文本） */
  resultSummary: string | null;
}

export interface SubAgentsResponse {
  agents: SubAgentActivity[];
}

export interface SessionDetail {
  session: SessionSummary;
  messages: SessionMessage[];
  /** 本页之前是否还有更早消息（分页查询时有效；全量返回恒 false） */
  hasMore: boolean;
  /** 下一页 before 游标（本页最早一条消息 id）；无更早消息为 null */
  nextBefore: string | null;
}

export interface SystemComponent {
  available: boolean;
  version: string | null;
}

/* ===== 真实系统指标（docs/API_CONTRACT.md §2；单项失败独立降级 null） ===== */

/** CPU：两次 os.cpus() 采样差分使用率（0..100）；采样失败 usagePercent=null */
export interface SystemCpuMetrics {
  usagePercent: number | null;
  cores: number;
}

/** 内存（字节） */
export interface SystemMemoryMetrics {
  usedBytes: number;
  totalBytes: number;
  usagePercent: number;
}

/** 磁盘（项目所在盘，字节）；采集失败整体 null */
export interface SystemDiskMetrics {
  usedBytes: number;
  totalBytes: number;
  usagePercent: number;
  mount: string;
}

export interface SystemMetrics {
  cpu: SystemCpuMetrics;
  memory: SystemMemoryMetrics;
  disk: SystemDiskMetrics | null;
  /** 1/5/15 分钟负载均值；Windows 无 → null */
  loadavg: [number, number, number] | null;
  /** 系统运行时长秒 */
  uptimeSeconds: number;
  sampledAt: string;
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
  /** 真实系统指标；缺省/为 null 表示不可用（旧 server 兼容，UI 降级不显示） */
  metrics?: SystemMetrics | null;
}

export interface PromptResult {
  accepted: boolean;
  mode: "prompt" | "steer" | "followUp";
}

/** GET /api/commands?source= 命令项（契约 §8） */
export interface CommandItem {
  name: string;
  description: string;
  builtin: boolean;
  /** 仅终端可用（claude 内置命令在 claude -p 下无效），UI 标注降级 */
  terminalOnly: boolean;
}

export interface CommandList {
  source: SessionSource;
  commands: CommandItem[];
}

/** GET /api/fs/tree 目录项（契约 §9） */
export type FsEntryType = "dir" | "file";

export interface FsEntry {
  name: string;
  type: FsEntryType;
  /** .git / node_modules / 点开头：默认隐藏，hidden=1 展开 */
  hidden: boolean;
  size: number | null;
}

export interface FsTree {
  cwd: string;
  /** 当前目录相对 cwd 路径（"" = 根） */
  path: string;
  parent: string | null;
  entries: FsEntry[];
  truncated: boolean;
}

/** POST /api/uploads 响应项（契约 §11） */
export interface UploadResult {
  /** 清洗后的文件名 */
  name: string;
  /** 可引用路径：cwd 内为相对路径（`.agent-hub-uploads/x.png`），临时目录兜底为绝对路径 */
  path: string;
  /** 落盘绝对路径 */
  absPath: string;
  mimeType: string;
  size: number;
  /** 是否图片（缩略图预览 + prompt 直接附图） */
  isImage: boolean;
}

export interface UploadResponse {
  upload: UploadResult;
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
  /** pi-subagents 派生的子代理会话通知（前端聚合为一条展示） */
  isSubAgent?: boolean;
}

export interface NotificationListResponse {
  notifications: NotificationItem[];
  unreadCount: number;
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
