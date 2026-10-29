/**
 * 与 docs/API_CONTRACT.md 一一对应的数据类型（v0 契约，不得单方面改字段名）。
 */

export type SessionStatus = "idle" | "running" | "error";

/** 会话来源：pi（~/.pi/agent/sessions）、claude（~/.claude/projects）或 codex（~/.codex/sessions） */
export type SessionSource = "pi" | "claude" | "codex";

export interface SessionSummary {
  id: string;
  /** 会话来源徽章（pi | claude） */
  source: SessionSource;
  /** 会话名（server 口径：无名/显式清空为 null，契约 §1） */
  name: string | null;
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
  /** 终端驱动状态（E3 双模式）：pi=扩展心跳；claude=hub 驱动进程。pi/claude 会话有值。 */
  terminal?: TerminalAttachInfo | null;
  /**
   * 归档会话（codex `~/.codex/archived_sessions/`，契约 §1）：列表标注「归档」并排尾。
   * 可缺省（非归档 / 旧 server），渲染容错按非归档（`!== true`）。
   */
  archived?: boolean;
}

/**
 * 终端驱动状态：pi=扩展心跳（online=90s 内）；claude=hub 驱动（online=可接管，docs/CLAUDE_DRIVER.md）。
 * attached=attach 接管生效。driver 缺省按 "queue"（pi）容错。
 */
export interface EffectivePolicyDto { approval: string; sandbox: string; bypass: boolean }

export interface TerminalAttachInfo {
  effectivePolicy?: EffectivePolicyDto;
  online: boolean;
  attached: boolean;
  /** 驱动形态：queue=pi 扩展指令队列；hub=server 持有 claude -p 长驻进程 */
  driver?: "queue" | "hub";
  source?: "claude" | "codex";
  /** 投屏（tmux 镜像）就绪（仅 hub 形态） */
  mirror?: boolean;
  /**
   * 智能默认策略（server config.claudeDriver.defaultPolicy 随 terminal 下发，契约增量字段）：
   * "active-only"=仅活跃会话默认接管；"always"=打开即默认接管（仍须接管当下可行）；
   * "never"=永不默认接管，只手动切换。可缺省（老 server / 未下发）：按 "active-only"
   * 容错，与历史智能默认行为一致。
   */
  defaultPolicy?: "active-only" | "always" | "never";
  /**
   * 终端扩展是否仍在长轮询取指令（server 下发，可缺省）。
   * 心跳 TTL 是 90s，终端关掉后这 90s 里 online 仍为 true；靠这个字段区分
   * 「终端真的活着」与「心跳还没过期的死终端」，后者绝不自动接管。
   */
  responsive?: boolean;
}

/**
 * 问答题（Codex 工具向用户提问 / MCP elicitation，`kind === "question"` 下发）：
 * `options` 为 null = 自由文本题；非空 = 单选选项（label 唯一，描述可空）。
 */
export interface HostUserQuestion {
  /** questionId，应答映射键 */
  id: string;
  /** 标题（小标题），可空 */
  header: string | null;
  /** 问题文本 */
  question: string;
  /** 选项列表；null = 自由文本 */
  options: Array<{ label: string; description: string | null }> | null;
}

/** host 权限请求（hub 驱动 claude 会话的手机批权限，契约 §12） */
export interface HostRequestDto {
  id: string;
  sessionId: string;
  kind: "permission" | "question";
  title: string;
  detail: string | null;
  toolName?: string;
  allowAlways?: boolean;
  requestType?: "commandExecution" | "fileChange" | "permissions";
  turnId?: string;
  itemId?: string;
  permissions?: unknown;
  /** 问答题（仅 kind === "question" 下发）；审批请求无此字段 */
  questions?: HostUserQuestion[] | null;
  createdAt: number;
  expiresAt: number | null;
}

/**
 * POST /api/sessions/:id/host-requests/:requestId 应答 body（契约二选一）：
 * 审批现状 `{ outcome: "allow" | "deny" }`；问答提交 `{ answers: { [questionId]: string[] } }`。
 */
export type HostRequestBody =
  | { outcome: "allow" | "deny" }
  | { answers: Record<string, string[]> };

export type HostRequestOutcome = "allow" | "deny" | "timeout" | "cancelled";

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
   * 模型/流式错误（assistant 的 stopReason==="error"|"aborted"）；无错缺省。
   * 没有这个字段时，余额耗尽/网络中断/上下文溢出都只会渲染成灰色「（无内容）」，
   * 用户根本不知道发生了什么、更不知道该怎么救。
   */
  error?: MessageError;
  /**
   * 流式进行中（message_start → message_end 之间为 true）：
   * 空内容时渲染"回复中"活占位（绝不显示"（无内容）"），气泡带进行中视觉。
   * 历史/权威消息缺省视为已 settle。
   */
  streaming?: boolean;
  turnId?: string;
}

/** 错误分类：决定文案与自救动作（上下文溢出可一键压缩，其余只能看原因） */
export type MessageErrorKind = "contextOverflow" | "aborted" | "other";

export interface MessageError {
  /** 原始错误文本（server 从 SDK 的 errorMessage 透出，不美化也不隐藏） */
  message: string;
  kind: MessageErrorKind;
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
  /** ttyd Web 终端运行态（F2；旧 server 缺省，UI 按未启用容错） */
  terminal?: TerminalStatus;
}

/* ===== ttyd Web 终端（docs/API_CONTRACT.md §13） ===== */

/** GET /api/terminal/status / GET /api/system.terminal */
export interface TerminalStatus {
  /** 平台是否支持（仅 POSIX；Windows 降级提示） */
  supported: boolean;
  /** ttyd 是否已安装 */
  installed: boolean;
  /** 按需拉起的 ttyd 是否运行中 */
  running: boolean;
  version: string | null;
  /** 降级提示（未安装/不支持时给安装命令） */
  hint: string | null;
}

/** POST /api/terminal/session：同源反代地址（含一次性 token） */
export interface TerminalSession {
  url: string;
  expiresAt: string;
}

export interface PromptResult {
  accepted: boolean;
  mode: "prompt" | "steer" | "followUp";
}

/* ===== 终端接管 / 指令队列（E3 双模式，契约 §12） ===== */

/** attach 指令注入模式（与 pi sendUserMessage 语义一致） */
export type AttachCommandMode = "prompt" | "steer" | "followUp";

/** POST /api/sessions/:id/attach 响应 */
export interface AttachResult {
  effectivePolicy?: EffectivePolicyDto;
  attached: boolean;
  agent: {
    sessionId: string;
    pid?: number | null;
    cwd: string;
    online: boolean;
    /** hub 驱动形态（claude）附带 */
    driver?: "queue" | "hub";
    mirror?: boolean;
  } | null;
}

/** POST /api/sessions/:id/message 响应（attach 通道） */
export interface AttachMessageResult {
  accepted: boolean;
  channel: "attach";
  commandId: string;
  mode: AttachCommandMode;
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

/** 各来源细分计数（pi / claude / codex 恒齐全；分源统计的原子单元，契约增量字段） */
export interface SessionSourceCounts {
  pi: number;
  claude: number;
  codex: number;
}

/** GET /api/dashboard/stats：按会话来源分组的细分计数（增量字段，老字段语义/口径不变） */
export interface DashboardSourceStats {
  /** 今日消息数细分（各来源之和 = todayMessages） */
  todayMessages: SessionSourceCounts;
  /** 今日完成 run 次数细分（各来源之和 = todayDone） */
  todayDone: SessionSourceCounts;
  /** 工作中会话数细分（各来源之和 = working） */
  working: SessionSourceCounts;
  /** 等你处理会话数细分（各来源之和 = needAttention） */
  needAttention: SessionSourceCounts;
}

/** GET /api/dashboard/stats：运行看板卡（工作中会话的实时进度） */
export interface WorkingSessionCard {
  id: string;
  name: string | null;
  cwd: string;
  status: SessionStatus;
  /** 会话来源（pi | claude | codex；分源徽章/过滤用） */
  source: SessionSource;
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
  /** 会话来源（pi | claude | codex；分源徽章/过滤用） */
  source: SessionSource;
  /** settled=agent 干完等你输入；error=运行出错 */
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
  /** 按来源（pi | claude | codex）分组的细分计数（增量字段；各细分之和 = 对应总量字段） */
  bySource: DashboardSourceStats;
}

/** GET /api/usage：Token 用量汇总维度（契约 §14，pi 源；每次 API 调用的 usage 求和） */
export interface UsageTotals {
  totalTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  /** cost.total 求和；数据源无 cost 字段时 null（0 是有效金额） */
  costTotal: number | null;
}

/** 时间窗汇总：今日 / 近 7 天（含今日）/ 全部 */
export interface UsageWindows {
  today: UsageTotals;
  last7Days: UsageTotals;
  all: UsageTotals;
}

/** 自定义时间窗（?days=N，最近 N 天含今日） */
export interface UsageRange {
  days: number;
  usage: UsageTotals;
}

/** GET /api/usage 全局汇总里的单会话项 */
export interface SessionUsage {
  sessionId: string;
  name: string | null;
  updatedAt: string;
  usage: UsageTotals;
}

/** GET /api/usage 响应（全局汇总 + 会话明细） */
export interface UsageOverview {
  windows: UsageWindows;
  /** 仅带 ?days=N 时返回 */
  range?: UsageRange;
  sessions: SessionUsage[];
}

/** GET /api/usage?sessionId= 响应（单会话汇总） */
export interface UsageSessionDetail {
  sessionId: string;
  name: string | null;
  updatedAt: string;
  windows: UsageWindows;
  /** 仅带 ?days=N 时返回 */
  range?: UsageRange;
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
