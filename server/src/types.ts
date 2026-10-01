/**
 * API 契约 DTO 类型（docs/API_CONTRACT.md 的 TypeScript 表达）。
 * 字段名/路径与契约一一对应，任何一方不得单方面修改。
 */

export type SessionStatus = "idle" | "running" | "error";

/**
 * 会话最后驱动来源（心理预期管理）：面板（手机/网页 POST prompt）或终端（电脑 pi/claude）。
 * 可缺省（老 server/容错路径）：缺省视为 terminal。
 */
export type SessionDrivenBy = "panel" | "terminal";

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
  /**
   * pi-subagents 派生的子代理会话（会话名 `<type>#<id>` 如 developer#abc123，
   * 或入口消息含 pi-subagents 派生特征）。主会话恒 false。
   */
  isSubAgent: boolean;
  /**
   * 血缘父会话 id（pi 会话 header.parentSession 解析，文件名末段即会话 id）：
   * pi-subagents 派生子代理与 fork 分支均带；claude 侧无独立父子会话文件恒 null。
   * 识别不出 / 跨机父文件缺失为 null（前端归"未归组子代理"兜底分组）。
   */
  parentSessionId?: string | null;
  /**
   * 最后驱动来源（面板驱动过即 "panel"，只增不减）：手机面板发消息 = server 的 pi SDK
   * 实例驱动同一会话文件，电脑终端 pi 需 pi --resume 重开才能看到。可缺省按 terminal。
   */
  lastDrivenBy?: SessionDrivenBy;
  /** 终端 pi 驱动状态（E3 双模式）：扩展心跳判定的在线/接管状态。仅 pi 会话有值。 */
  terminal?: TerminalAttachInfo | null;
}

/** 终端 pi 状态（双模式会话驱动）：online=心跳 90s 内；attached=attach 接管生效 */
export interface TerminalAttachInfo {
  online: boolean;
  attached: boolean;
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

/** 子代理活动（pi-subagents 派生会话，按 parentSessionId 归属父会话；反馈轮 3 #4） */
export interface SubAgentActivityDto {
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
  /** 已结束（非 running）：卡片转"✅ 完成，点击查看结果" */
  done: boolean;
  /** 完成后的结果摘要 */
  resultSummary: string | null;
}

/** WS subagent_activity 增量（只带变化字段） */
export type SubAgentActivityUpdate = Partial<Omit<SubAgentActivityDto, "sessionId">> & { sessionId: string };

/** GET /api/sessions/:id/agents 响应 */
export interface SubAgentsResponse {
  agents: SubAgentActivityDto[];
}

/** 消息内嵌图片（pi ImageContent / claude image block → data URL 或 http(s) URL） */
export interface MessageImage {
  /** `data:image/...;base64,...` 或 http(s) URL */
  url: string;
  alt: string | null;
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
  /** 内嵌图片（ImageContent/image block）；无图缺省。前端按序渲染为 <img> */
  images?: MessageImage[];
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
  | {
      type: "subagent_activity";
      sessionId: string;
      parentSessionId: string;
      activity: SubAgentActivityUpdate;
    }
  | { type: "error"; code: string; message: string }
  | { type: "attach_state"; attached: boolean; terminalOnline: boolean }
  | { type: "command_ack"; commandId: string; ok: boolean; error: string | null }
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

/** 真实系统指标（docs/API_CONTRACT.md §2）：各字段采集失败独立降级，不整体报错 */

/** CPU：两次 os.cpus() times 采样差分的使用率百分比（0..100） */
export interface CpuMetrics {
  usagePercent: number | null;
  cores: number;
}

/** 内存（字节）：used = total - free（os.totalmem/os.freemem） */
export interface MemoryMetrics {
  usedBytes: number;
  totalBytes: number;
  usagePercent: number;
}

/** 磁盘（项目所在盘，字节）；采集失败整体为 null */
export interface DiskMetrics {
  usedBytes: number;
  totalBytes: number;
  usagePercent: number;
  /** 挂载点（POSIX）或盘符（Windows，如 "C:"） */
  mount: string;
}

export interface SystemMetrics {
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  disk: DiskMetrics | null;
  /** 1/5/15 分钟负载均值（os.loadavg）；Windows 无负载均值 → null */
  loadavg: [number, number, number] | null;
  /** 系统运行时长秒（os.uptime） */
  uptimeSeconds: number;
  sampledAt: string;
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
  /** 真实系统指标；整体采集失败为 null（不影响工具探测字段） */
  metrics: SystemMetrics | null;
  /** ttyd Web 终端运行态（可选增强，F2；缺省按未启用容错） */
  terminal?: TerminalStatusDto;
}

/** ===== ttyd Web 终端（docs/API_CONTRACT.md §13） ===== */

/** GET /api/terminal/status / GET /api/system.terminal 运行态 DTO */
export interface TerminalStatusDto {
  /** 平台是否支持（仅 POSIX；Windows 显示 WSL 降级提示） */
  supported: boolean;
  /** ttyd 二进制是否已安装 */
  installed: boolean;
  /** 按需拉起的 ttyd 是否正在运行 */
  running: boolean;
  version: string | null;
  /** 降级提示（未安装/不支持时给安装命令；正常为 null） */
  hint: string | null;
}

/** POST /api/terminal/session 响应（url 为同源反代地址，含一次性 token） */
export interface TerminalSessionDto {
  url: string;
  expiresAt: string;
}

/** ===== slash 命令清单（docs/API_CONTRACT.md §8） ===== */

/** GET /api/commands?source= 的命令项 */
export interface CommandDto {
  /** 命令名（含前导斜杠，如 "/resume" 或 "/dir:name"） */
  name: string;
  description: string;
  builtin: boolean;
  /** 仅终端可用：claude 内置命令在 `claude -p` 下无效（实测拒绝或无输出），UI 标注降级 */
  terminalOnly: boolean;
}

export interface CommandListDto {
  source: SessionSource;
  commands: CommandDto[];
}

/** ===== 文件树只读 API（docs/API_CONTRACT.md §9） ===== */

export type FsEntryType = "dir" | "file";

/** GET /api/fs/tree 目录项 */
export interface FsEntryDto {
  name: string;
  type: FsEntryType;
  /** .git / node_modules / 点开头：默认隐藏，?hidden=1 展开 */
  hidden: boolean;
  /** 文件字节数；目录为 null */
  size: number | null;
}

/** GET /api/fs/tree 响应（单层列表） */
export interface FsTreeDto {
  /** 根（会话 cwd，绝对路径） */
  cwd: string;
  /** 当前目录相对 cwd 的路径，"" 为根 */
  path: string;
  /** 上一层相对路径；根为 null */
  parent: string | null;
  entries: FsEntryDto[];
  /** 条目超过上限被截断 */
  truncated: boolean;
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

/** GET /api/usage：Token 用量汇总维度（契约 §15，pi 源；每次 API 调用的 usage 求和） */
export interface UsageTotalsDto {
  totalTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  /** cost.total 求和；数据源全程无 cost 字段时为 null（允许 null/0） */
  costTotal: number | null;
}

/** 时间窗汇总：今日（本地 0 点起）/ 近 7 天（含今日）/ 全部 */
export interface UsageWindowsDto {
  today: UsageTotalsDto;
  last7Days: UsageTotalsDto;
  all: UsageTotalsDto;
}

/** 自定义时间窗（?days=N，最近 N 天含今日） */
export interface UsageRangeDto {
  days: number;
  usage: UsageTotalsDto;
}

/** GET /api/usage 全局汇总里的单会话项（仅含有 usage 采样的会话） */
export interface SessionUsageDto {
  sessionId: string;
  name: string | null;
  updatedAt: string;
  usage: UsageTotalsDto;
}

/** GET /api/usage 响应（无 sessionId：全局汇总 + 会话明细） */
export interface UsageOverviewDto {
  windows: UsageWindowsDto;
  /** 仅带 ?days=N 时返回 */
  range?: UsageRangeDto;
  sessions: SessionUsageDto[];
}

/** GET /api/usage?sessionId= 响应（单会话汇总） */
export interface UsageSessionDto {
  sessionId: string;
  name: string | null;
  updatedAt: string;
  windows: UsageWindowsDto;
  /** 仅带 ?days=N 时返回 */
  range?: UsageRangeDto;
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
  /** pi-subagents 派生的子代理会话通知（前端默认聚合为一条，不淹没主会话） */
  isSubAgent?: boolean;
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

/** POST /api/uploads 响应项（契约 §11） */
export interface UploadDto {
  /** 清洗后的文件名（含扩展名） */
  name: string;
  /** 可引用路径：cwd 内为相对路径（`.agent-hub-uploads/x.png`），临时目录兜底时为绝对路径 */
  path: string;
  /** 落盘绝对路径 */
  absPath: string;
  mimeType: string;
  size: number;
  /** 是否图片（决定 UI 缩略图预览与 prompt 直接附图） */
  isImage: boolean;
}

/** prompt 图片附件（通道 b：pi ImageContent；由 server 读上传文件后交给适配层） */
export interface PromptImageAttachment {
  /** 原始引用路径（相对 cwd 或绝对；claude 侧降级提示用） */
  path: string;
  /** MIME（image/png 等） */
  mimeType: string;
  /** base64 图片数据（不含 data: 前缀） */
  data: string;
}
